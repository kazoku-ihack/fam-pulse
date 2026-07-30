import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { z } from 'zod';
import { appendEvent, getParentId } from '../db.js';
import { requireRole } from '../auth.js';
import { validateRules, monthKeyTokyo } from '../attestation-rules.js';
import { COVERAGE_CODE } from '../coverage.js';
import { computeInner } from '../protosure/stub.js';
import * as chainDefault from '../chain/chain.js';
import { asyncHandler } from '../asyncHandler.js';

const DEMO_TX_WINDOW_MS = 60 * 60 * 1000;
let demoTxTimestamps = [];

function underDemoTxLimit() {
  const limit = parseInt(process.env.MAX_DEMO_TX_PER_HOUR, 10) || 20;
  const now = Date.now();
  demoTxTimestamps = demoTxTimestamps.filter((t) => now - t < DEMO_TX_WINDOW_MS);
  return demoTxTimestamps.length < limit;
}
function recordDemoTx() {
  demoTxTimestamps.push(Date.now());
}
// test-only reset hook
export function _resetDemoTxThrottle() {
  demoTxTimestamps = [];
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Pure netting math, exported for direct property testing.
export function computeNetCredit(lines) {
  return lines
    .filter((l) => l.type === 'visit' && l.attested && !l.disputed)
    .reduce((sum, l) => sum + l.amount, 0);
}

// Values are echoed verbatim from the stored attestation — never recomputed — so what gets
// submitted on-chain is exactly what was validated and signed at attestation time.
async function executePayoutOnChain(chain, att) {
  const wallet = chain.getRelayerWallet();
  const payout = chain.getPayoutContract(wallet);
  const tx = await payout.submitTrigger(
    att.policyId,
    att.triggerRef,
    att.coverageCode,
    BigInt(att.payoutAmount),
    att.recipient,
    BigInt(att.monthKey),
    att.signature
  );
  const receipt = await tx.wait();
  return { txHash: receipt.hash, explorerUrl: chain.explorerUrl(receipt.hash) };
}

// Permanent (non-retryable) on-chain failures free the reserved headroom back up.
const PERMANENT_FAILURE_REASONS = new Set(['NONCE_ALREADY_USED', 'SIGNER_MISMATCH', 'CAP_EXCEEDED']);

function releaseCapLedger(db, attestationId) {
  db.prepare(`UPDATE cap_ledger SET status = 'released' WHERE attestationId = ? AND status = 'reserved'`).run(attestationId);
}

function mapChainError(e) {
  const msg = String(e.reason || e.shortMessage || e.message || '');
  if (msg.includes('NONCE_ALREADY_USED')) return { status: 409, error: 'NONCE_ALREADY_USED' };
  if (msg.includes('SIGNER_MISMATCH')) {
    return { status: 502, error: 'SIGNER_MISMATCH', message: 'signer not registered on contract — run setSigner' };
  }
  if (msg.includes('CAP_EXCEEDED')) return { status: 422, error: 'CAP_EXCEEDED' };
  return { status: 502, error: 'CHAIN_ERROR', message: e.message };
}

const transferSchema = z.object({
  attestationId: z.string().min(1).optional(),
  toAddr: z.string().optional(),
  amount: z.number().optional(),
  incidentId: z.string().optional(),
  parentId: z.string().optional(),
});

// Mendix now calls Protosure directly for the attestation itself — this service no longer signs
// via protosure/rater-client.js for this flow. preTransferHash is the step in between: it
// receives Protosure's already-signed attestation, independently verifies it, applies this
// repo's own payout rules (deterministic rules still own the money, even though Protosure already
// attested — see attestation-rules.js), and persists an `attestations` row exactly like
// POST /v1/attestation/trigger does, so POST /v1/jpyc/transfer can execute it unchanged.
const preTransferHashSchema = z.object({
  quote_id: z.string().min(1),
  coverage_code: z.string().min(1),
  recipient: z.string().min(1),
  payout_amount: z.number().positive(),
  trigger_ref: z.string().min(1),
  incident_timestamp: z.number(),
  contract_address: z.string().min(1),
  chain_id: z.union([z.string(), z.number()]),
  parentId: z.string().optional(),
  attester: z.object({
    nonce: z.string().min(1),
    signer: z.string().min(1),
    signature: z.string().min(1),
    payload_hash: z.string().min(1),
  }),
});

function normalizeIncidentTimestamp(ts) {
  // Accept both unix seconds and unix milliseconds from upstream callers
  return ts < 1e12 ? ts * 1000 : ts;
}

export function paymentsRouter(db, { chain = chainDefault } = {}) {
  const router = Router();

  router.get('/v1/wallet/balance', asyncHandler(async (req, res) => {
    const address =
      req.query.address || db.prepare("SELECT address FROM wallets WHERE name = 'sakura'").get()?.address;
    if (!address) return res.status(400).json({ error: 'ADDRESS_REQUIRED' });
    if (!chain.isChainDeployed()) {
      return res.json({ address, balance: null, configured: false });
    }
    try {
      const jpyc = chain.getJpycContract();
      const [raw, decimals] = await Promise.all([jpyc.balanceOf(address), jpyc.decimals()]);
      res.json({ address, balance: Number(raw) / 10 ** Number(decimals), configured: true });
    } catch (e) {
      res.status(502).json({ error: 'CHAIN_ERROR', message: e.message });
    }
  }));

  router.post('/v1/jpyc/preTransferHash', requireRole('adult_child'), asyncHandler(async (req, res) => {
    const parsed = preTransferHashSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
    const {
      quote_id, coverage_code, recipient, payout_amount, trigger_ref,
      incident_timestamp, contract_address, chain_id, attester, parentId,
    } = parsed.data;

    // coverage_code arrives as the on-chain hex byte (e.g. "0x01") — reverse-map to this repo's
    // triggerCode so the fixed-schedule/cool-down rules (keyed by triggerCode) can run.
    const triggerCode = Object.entries(COVERAGE_CODE).find(
      ([, hex]) => hex.toLowerCase() === coverage_code.toLowerCase()
    )?.[0];
    if (!triggerCode) return res.status(400).json({ error: 'UNKNOWN_COVERAGE_CODE' });

    const configuredPayoutAddress = String(process.env.PAYOUT_ADDR || '');
    const configuredChainId = String(process.env.CHAIN_ID || '43113');
    if(!configuredPayoutAddress){
      return res.status(503).json({error : 'CHAIN_NOT_CONFIGURED'});
    }
    // The digest binds contract_address/chain_id implicitly, but a mismatch would otherwise only
    // surface as a wasted, later on-chain revert — fail fast instead.
    if (contract_address.toLowerCase() !== configuredPayoutAddress.toLowerCase()) {
      const jpycAddr = String(process.env.JPYC_ADDR || '').toLowerCase();
      const hint = contract_address.toLowerCase() === jpycAddr && jpycAddr ? 'contract_address must be PAYOUT_ADDR (payout contract), not JPYC_ADDR (token_contract)'
      : undefined;
      return res.status(422).json({ 
        error: 'CONTRACT_ADDRESS_MISMATCH',
        expected: configuredPayoutAddress,
        received: contract_address,
        ...(hint ? {hint}:{}),
      });
    }
    //if (String(chain_id) !== String(process.env.CHAIN_ID || '43113')) {
    if (String(chain_id) !== configuredChainId) {
      return res.status(422).json({ 
        error: 'CHAIN_ID_MISMATCH',
        expected: configuredChainId,
        received: String(chain_id), 
      });
    }
    const normalizedIncidentTimestamp = normalizeIncidentTimestamp(incident_timestamp);
    const monthKey = monthKeyTokyo(normalizedIncidentTimestamp);

    // Deterministic rules still own the money — Protosure's own attestation doesn't bypass this;
    // same FIXED_SCHEDULE / PT-01 cool-down / cap_ledger headroom checks
    // POST /v1/attestation/trigger already applies.
    const rules = validateRules({ db, triggerCode, payoutAmount: payout_amount, monthKey, coverageCode: coverage_code });
    if (!rules.ok) return res.status(422).json({ error: rules.reason });

    // Independently verify the attester's signature — never trust a signature blob relayed
    // through Mendix without recomputing it ourselves. Reuses the exact digest scheme
    // MimamorParametric.sol / protosure/stub.js already use, so it can never drift from what the
    // contract will actually recover on submitTrigger.
    const inner = computeInner({
      policyId: quote_id,
      triggerRef: trigger_ref,
      coverageCode: coverage_code,
      payoutAmount: payout_amount,
      recipient,
      monthKey,
      contractAddress: contract_address,
      chainId: chain_id,
    });
    const digest = ethers.hashMessage(ethers.getBytes(inner));
    if (digest.toLowerCase() !== attester.payload_hash.toLowerCase()) {
      return res.status(422).json({ error: 'PAYLOAD_HASH_MISMATCH' });
    }

    let recovered;
    try {
      recovered = ethers.recoverAddress(digest, attester.signature);
    } catch (e) {
      return res.status(422).json({ error: 'INVALID_SIGNATURE', message: e.message });
    }
    if (recovered.toLowerCase() !== attester.signer.toLowerCase()) {
      return res.status(422).json({ error: 'SIGNATURE_SIGNER_MISMATCH' });
    }

    const registeredSigner = String(process.env.REGISTERED_SIGNER || '').toLowerCase();
    if (!registeredSigner || attester.signer.toLowerCase() !== registeredSigner) {
      return res.status(422).json({ error: 'SIGNER_NOT_REGISTERED' });
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO attestations (id, policyId, triggerCode, payoutAmount, recipient, timestamp, triggerRef, coverageCode, monthKey, payloadHash, signature, signer, source, txHash, status, attesterNonce)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`
    ).run(
      id,
      quote_id,
      triggerCode,
      payout_amount,
      recipient,
      normalizedIncidentTimestamp,
      trigger_ref,
      coverage_code,
      monthKey,
      digest,
      attester.signature,
      attester.signer,
      'protosure-direct',
      'signed',
      attester.nonce
    );

    // Reserve the intended spend against the local cap ledger, same as createAttestation() in
    // routes/attestation.js — released by /v1/jpyc/transfer on a permanent on-chain submit failure.
    db.prepare(
      `INSERT INTO cap_ledger (id, coverageCode, monthKey, amount, attestationId, status, ts) VALUES (?,?,?,?,?, 'reserved', ?)`
    ).run(randomUUID(), coverage_code, monthKey, payout_amount, id, Date.now());

    appendEvent(db, {
      parentId: parentId || null,
      type: 'payout',
      title: `Attestation received from Protosure for ${triggerCode}`,
      deepLink: `/v1/attestation/${id}`,
      refId: id,
    });

    res.status(201).json({
      id,
      status: 'signed',
      source: 'protosure-direct',
      triggerCode,
      payoutAmount: payout_amount,
      quoteId: quote_id,
      nonce: attester.nonce,
      // Informational only — no second signature is produced here. `oracle` names this service's
      // own configured signer identity for audit purposes; the attester's (Protosure's) signature
      // is the only one that actually authorizes the on-chain transfer via submitTrigger.
      oracle: process.env.REGISTERED_SIGNER || null,
      attester: attester.signer,
      oracleSig: null,
      attesterSig: attester.signature,
      evidenceHash: digest,
      amountWei: payout_amount,
    });
  }));

  router.post('/v1/jpyc/transfer', requireRole('adult_child'), asyncHandler(async (req, res) => {
    const parsed = transferSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
    const { attestationId, toAddr, incidentId, parentId } = parsed.data;
    if (!attestationId) {
      return res.status(403).json({ error: 'ATTESTATION_REQUIRED' });
    }

    const att = db.prepare('SELECT * FROM attestations WHERE id = ?').get(attestationId);
    if (!att || att.status !== 'signed') {
      return res.status(403).json({ error: 'ATTESTATION_REQUIRED' });
    }
    if (toAddr && toAddr.toLowerCase() !== att.recipient.toLowerCase()) {
      return res.status(400).json({ error: 'RECIPIENT_MISMATCH' });
    }

    if (!underDemoTxLimit()) {
      return res.json({ status: 'DEMO_TX_LIMIT', message: 'Demo transaction cap reached this hour — try again later' });
    }
    if (!chain.isChainDeployed() || !chain.isRelayerConfigured()) {
      return res.status(503).json({ error: 'CHAIN_NOT_CONFIGURED' });
    }

    try {
      const { txHash, explorerUrl } = await withTimeout(executePayoutOnChain(chain, att), 10000);
      recordDemoTx();
      db.prepare(`UPDATE attestations SET status = 'paid', txHash = ? WHERE id = ?`).run(txHash, att.id);
      appendEvent(db, {
        parentId: parentId || null,
        type: 'payout',
        title: `Payout sent: ¥${att.payoutAmount}`,
        deepLink: explorerUrl,
        refId: incidentId || att.id,
      });
      res.json({ status: 'paid', txHash, explorerUrl, signer: att.signer, source: att.source, payloadHash: att.payloadHash });
    } catch (e) {
      if (e.code === 'TIMEOUT') return res.json({ status: 'pending', attestationId: att.id });
      const mapped = mapChainError(e);
      if (PERMANENT_FAILURE_REASONS.has(mapped.error)) releaseCapLedger(db, att.id);
      res.status(mapped.status).json(mapped);
    }
  }));

  router.post('/v1/jpyc/batchTransfer', requireRole('adult_child'), asyncHandler(async (req, res) => {
    const { settlementId, parentId } = req.body || {};
    if (!settlementId) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'settlementId required' });
    const settlement = db.prepare('SELECT * FROM settlements WHERE id = ?').get(settlementId);
    if (!settlement) return res.status(404).json({ error: 'NOT_FOUND' });

    const lines = JSON.parse(settlement.lines_json);
    // Server-side re-derivation: never trust a client-supplied exclusion list.
    const excluded = lines.filter((l) => l.disputed || !l.attested).map((l) => l.lineId);
    const included = lines.filter((l) => !excluded.includes(l.lineId));
    if (included.length === 0) return res.status(400).json({ error: 'NOTHING_TO_TRANSFER', excluded });

    const attestation = db
      .prepare(
        `SELECT * FROM attestations WHERE policyId = ? AND triggerCode = 'PT-06' AND status = 'signed' ORDER BY timestamp DESC LIMIT 1`
      )
      .get(settlementId);
    if (!attestation) return res.status(403).json({ error: 'ATTESTATION_REQUIRED' });

    if (!underDemoTxLimit()) {
      return res.json({ status: 'DEMO_TX_LIMIT', message: 'Demo transaction cap reached this hour — try again later' });
    }
    if (!chain.isChainDeployed() || !chain.isRelayerConfigured()) {
      return res.status(503).json({ error: 'CHAIN_NOT_CONFIGURED' });
    }

    try {
      const { txHash, explorerUrl } = await withTimeout(executePayoutOnChain(chain, attestation), 10000);
      recordDemoTx();
      db.prepare(`UPDATE attestations SET status = 'paid', txHash = ? WHERE id = ?`).run(txHash, attestation.id);
      appendEvent(db, {
        parentId: parentId || settlement.parentId,
        type: 'settlement',
        title: 'Settlement batch paid',
        deepLink: explorerUrl,
        refId: settlementId,
      });
      res.json({
        status: 'paid',
        txHash,
        explorerUrl,
        included: included.map((l) => l.lineId),
        excluded,
        signer: attestation.signer,
        source: attestation.source,
        payloadHash: attestation.payloadHash,
      });
    } catch (e) {
      if (e.code === 'TIMEOUT') return res.json({ status: 'pending', attestationId: attestation.id });
      const mapped = mapChainError(e);
      if (PERMANENT_FAILURE_REASONS.has(mapped.error)) releaseCapLedger(db, attestation.id);
      res.status(mapped.status).json(mapped);
    }
  }));

  router.get('/v1/settlement/current', (req, res) => {
    const parentId = getParentId(req);
    const row = db
      .prepare('SELECT * FROM settlements WHERE parentId = ? ORDER BY period DESC LIMIT 1')
      .get(parentId);
    if (!row) return res.json(null);
    const lines = JSON.parse(row.lines_json);
    const netCredit = computeNetCredit(lines);
    res.json({ id: row.id, parentId: row.parentId, period: row.period, lines, netCredit, pt03Credit: row.pt03Credit });
  });

  router.patch('/v1/settlement/:id/line/:lineId', requireRole('adult_child'), (req, res) => {
    const { disputed } = req.body || {};
    if (typeof disputed !== 'boolean') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'disputed must be boolean' });
    }
    const row = db.prepare('SELECT * FROM settlements WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    const lines = JSON.parse(row.lines_json);
    const idx = lines.findIndex((l) => l.lineId === req.params.lineId);
    if (idx === -1) return res.status(404).json({ error: 'LINE_NOT_FOUND' });
    lines[idx].disputed = disputed;
    db.prepare('UPDATE settlements SET lines_json = ? WHERE id = ?').run(JSON.stringify(lines), row.id);
    appendEvent(db, {
      parentId: row.parentId,
      type: 'settlement',
      title: `Line ${req.params.lineId} ${disputed ? 'flagged as disputed' : 'dispute cleared'}`,
      deepLink: '/v1/settlement/current',
      refId: row.id,
    });
    res.json({ lineId: req.params.lineId, disputed });
  });

  return router;
}
