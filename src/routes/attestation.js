import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appendEvent } from '../db.js';
import { validateRules, FIXED_SCHEDULE } from '../attestation-rules.js';
import { COVERAGE_CODE, TRIGGER_CODES } from '../coverage.js';
import { signTrigger as stubSign, StubSignerNotConfiguredError } from '../protosure/stub.js';
import { sign as raterSign, RaterUnavailableError } from '../protosure/rater-client.js';
import { computeNetCredit } from './payments.js';
import * as chainDefault from '../chain/chain.js';
import { asyncHandler } from '../asyncHandler.js';

// month_key is always derived in Asia/Tokyo, regardless of server host timezone.
function monthKeyTokyo(ts = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(ts));
  const year = parts.find((p) => p.type === 'year').value;
  const month = parts.find((p) => p.type === 'month').value;
  return `${year}${month}`;
}

const triggerSchema = z.object({
  policyId: z.string().min(1),
  triggerCode: z.enum(TRIGGER_CODES),
  recipient: z.string().min(1),
  parentId: z.string().optional(),
  incidentId: z.string().optional(),
  triggerRef: z.string().min(1).optional(),
  payoutAmount: z.number().positive().optional(), // required for PT-06 only
  eventTimestamp: z.number().optional(),
});

// Dispatches to the Protosure rater or the local offline stub per ATTESTATION_MODE, with
// fallback to the stub on rater failure per ATTESTATION_FALLBACK. Both paths return the same
// shape so callers never need to branch on mode.
async function signFields(fields) {
  const mode = process.env.ATTESTATION_MODE || 'stub';
  if (mode === 'protosure') {
    try {
      return await raterSign(fields);
    } catch (e) {
      const fallback = process.env.ATTESTATION_FALLBACK || 'stub';
      if (fallback === 'fail') {
        const err = new Error('RATER_UNAVAILABLE');
        err.code = 'RATER_UNAVAILABLE';
        throw err;
      }
      return { ...stubSign(fields), source: 'stub-fallback' };
    }
  }
  return stubSign(fields);
}

function rowToAttestation(row) {
  if (!row) return null;
  return {
    id: row.id,
    policyId: row.policyId,
    triggerCode: row.triggerCode,
    payoutAmount: row.payoutAmount,
    recipient: row.recipient,
    timestamp: row.timestamp,
    triggerRef: row.triggerRef,
    coverageCode: row.coverageCode,
    monthKey: row.monthKey,
    payloadHash: row.payloadHash,
    signature: row.signature,
    signer: row.signer,
    source: row.source,
    txHash: row.txHash,
    status: row.status,
  };
}

async function createAttestation(db, chain, { policyId, triggerCode, recipient, triggerRef, payoutAmount, eventTimestamp }) {
  const ts = eventTimestamp || Date.now();
  const monthKey = monthKeyTokyo(ts);
  const coverageCode = COVERAGE_CODE[triggerCode];
  const finalTriggerRef = triggerRef || randomUUID();

  const resolvedAmount = triggerCode === 'PT-06' ? payoutAmount : FIXED_SCHEDULE[triggerCode];
  if (triggerCode === 'PT-06' && !(resolvedAmount > 0)) {
    return { ok: false, status: 400, body: { error: 'PAYOUT_AMOUNT_REQUIRED_FOR_PT-06' } };
  }

  const rules = validateRules({ db, triggerCode, payoutAmount: resolvedAmount, monthKey, coverageCode });
  if (!rules.ok) {
    return { ok: false, status: 422, body: { error: rules.reason } };
  }

  const contractAddress = process.env.PAYOUT_ADDR;
  const chainId = process.env.CHAIN_ID || '43113';
  if (!contractAddress) {
    return { ok: false, status: 503, body: { error: 'CHAIN_NOT_CONFIGURED' } };
  }

  const fields = {
    policyId,
    triggerRef: finalTriggerRef,
    coverageCode,
    payoutAmount: resolvedAmount,
    recipient,
    monthKey,
    contractAddress,
    chainId,
  };

  let signed;
  try {
    signed = await signFields(fields);
  } catch (e) {
    if (e instanceof StubSignerNotConfiguredError) {
      return { ok: false, status: 503, body: { error: 'SIGNER_NOT_CONFIGURED' } };
    }
    if (e instanceof RaterUnavailableError || e.code === 'RATER_UNAVAILABLE') {
      return { ok: false, status: 422, body: { error: 'RATER_UNAVAILABLE' } };
    }
    throw e;
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO attestations (id, policyId, triggerCode, payoutAmount, recipient, timestamp, triggerRef, coverageCode, monthKey, payloadHash, signature, signer, source, txHash, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`
  ).run(
    id,
    policyId,
    triggerCode,
    resolvedAmount,
    recipient,
    ts,
    finalTriggerRef,
    coverageCode,
    monthKey,
    signed.payload_hash,
    signed.signature,
    signed.signer,
    signed.source,
    'signed'
  );

  // Reserve the intended spend against the local cap ledger — released by the payments route
  // on a permanent (non-retryable) on-chain submit failure.
  db.prepare(
    `INSERT INTO cap_ledger (id, coverageCode, monthKey, amount, attestationId, status, ts) VALUES (?,?,?,?,?, 'reserved', ?)`
  ).run(randomUUID(), coverageCode, monthKey, resolvedAmount, id, Date.now());

  return { ok: true, id };
}

export function attestationRouter(db, { chain = chainDefault } = {}) {
  const router = Router();

  router.post('/v1/attestation/trigger', asyncHandler(async (req, res) => {
    const parsed = triggerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
    const { policyId, triggerCode, recipient, incidentId, triggerRef, payoutAmount, parentId, eventTimestamp } = parsed.data;

    const result = await createAttestation(db, chain, {
      policyId,
      triggerCode,
      recipient,
      triggerRef: triggerRef || incidentId,
      payoutAmount,
      eventTimestamp,
    });
    if (!result.ok) return res.status(result.status).json(result.body);

    appendEvent(db, {
      parentId: parentId || null,
      type: 'payout',
      title: `Attestation signed for ${triggerCode}`,
      deepLink: `/v1/attestation/${result.id}`,
      refId: incidentId || result.id,
    });

    res.status(201).json(rowToAttestation(db.prepare('SELECT * FROM attestations WHERE id = ?').get(result.id)));
  }));

  router.get('/v1/attestation/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM attestations WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(rowToAttestation(row));
  });

  router.post('/v1/attestation/settlement/batch', asyncHandler(async (req, res) => {
    const { settlementId, recipient, parentId } = req.body || {};
    if (!settlementId || !recipient) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'settlementId and recipient are required' });
    }
    const settlement = db.prepare('SELECT * FROM settlements WHERE id = ?').get(settlementId);
    if (!settlement) return res.status(404).json({ error: 'NOT_FOUND' });

    const lines = JSON.parse(settlement.lines_json);
    const netCredit = computeNetCredit(lines);

    const result = await createAttestation(db, chain, {
      policyId: settlementId,
      triggerCode: 'PT-06',
      recipient,
      triggerRef: settlementId,
      payoutAmount: netCredit,
    });
    if (!result.ok) return res.status(result.status).json(result.body);

    const updatedLines = lines.map((l) => (l.disputed ? l : { ...l, attested: true }));
    db.prepare('UPDATE settlements SET lines_json = ? WHERE id = ?').run(JSON.stringify(updatedLines), settlementId);

    appendEvent(db, {
      parentId: parentId || settlement.parentId,
      type: 'settlement',
      title: `Settlement batch attested (¥${netCredit})`,
      deepLink: `/v1/attestation/${result.id}`,
      refId: settlementId,
    });

    res.status(201).json(rowToAttestation(db.prepare('SELECT * FROM attestations WHERE id = ?').get(result.id)));
  }));

  router.get('/v1/attestation/signer/current', asyncHandler(async (req, res) => {
    const registeredSigner = process.env.REGISTERED_SIGNER || null;
    if (!chain.isChainDeployed()) {
      return res.json({ registeredSigner, isRegisteredOnChain: null });
    }
    try {
      const payout = chain.getPayoutContract();
      const isRegisteredOnChain = registeredSigner ? await payout.isRegisteredSigner(registeredSigner) : null;
      res.json({ registeredSigner, isRegisteredOnChain });
    } catch (e) {
      res.json({ registeredSigner, isRegisteredOnChain: null, error: e.message });
    }
  }));

  return router;
}
