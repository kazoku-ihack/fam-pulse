import { Router } from 'express';
import { z } from 'zod';
import { appendEvent, getParentId } from '../db.js';
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

const JPYC_DECIMALS = 18n;

// Pure netting math, exported for direct property testing.
export function computeNetCredit(lines) {
  return lines
    .filter((l) => l.type === 'visit' && l.attested && !l.disputed)
    .reduce((sum, l) => sum + l.amount, 0);
}

async function executePayoutOnChain(chain, att) {
  const wallet = chain.getSignerWallet();
  const payout = chain.getPayoutContract(wallet);
  const amountUnits = BigInt(att.payoutAmount) * 10n ** JPYC_DECIMALS;
  const tx = await payout.submitTrigger(
    att.policyId,
    att.triggerCode,
    amountUnits,
    att.recipient,
    att.timestamp,
    att.nonce,
    att.signature
  );
  const receipt = await tx.wait();
  return { txHash: receipt.hash, explorerUrl: chain.explorerUrl(receipt.hash) };
}

function mapChainError(e) {
  const msg = String(e.reason || e.shortMessage || e.message || '');
  if (msg.includes('NONCE_ALREADY_USED')) return { status: 409, error: 'NONCE_ALREADY_USED' };
  if (msg.includes('SIGNER_MISMATCH')) return { status: 409, error: 'SIGNER_MISMATCH' };
  if (msg.includes('COOLDOWN_EXCEEDED')) return { status: 409, error: 'COOLDOWN_EXCEEDED' };
  return { status: 502, error: 'CHAIN_ERROR', message: e.message };
}

const transferSchema = z.object({
  attestationId: z.string().min(1).optional(),
  toAddr: z.string().optional(),
  amount: z.number().optional(),
  incidentId: z.string().optional(),
  parentId: z.string().optional(),
});

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

  router.post('/v1/jpyc/transfer', asyncHandler(async (req, res) => {
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
    if (!chain.isChainDeployed() || !chain.isSignerConfigured()) {
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
      res.json({ status: 'paid', txHash, explorerUrl });
    } catch (e) {
      if (e.code === 'TIMEOUT') return res.json({ status: 'pending', attestationId: att.id });
      const mapped = mapChainError(e);
      res.status(mapped.status).json(mapped);
    }
  }));

  router.post('/v1/jpyc/batchTransfer', asyncHandler(async (req, res) => {
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
        `SELECT * FROM attestations WHERE policyId = ? AND triggerCode = 'PT-03' AND status = 'signed' ORDER BY timestamp DESC LIMIT 1`
      )
      .get(settlementId);
    if (!attestation) return res.status(403).json({ error: 'ATTESTATION_REQUIRED' });

    if (!underDemoTxLimit()) {
      return res.json({ status: 'DEMO_TX_LIMIT', message: 'Demo transaction cap reached this hour — try again later' });
    }
    if (!chain.isChainDeployed() || !chain.isSignerConfigured()) {
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
      res.json({ status: 'paid', txHash, explorerUrl, included: included.map((l) => l.lineId), excluded });
    } catch (e) {
      if (e.code === 'TIMEOUT') return res.json({ status: 'pending', attestationId: attestation.id });
      const mapped = mapChainError(e);
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

  router.patch('/v1/settlement/:id/line/:lineId', (req, res) => {
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
