import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appendEvent } from '../db.js';
import { FIXED_SCHEDULE, validateTrigger as stubValidate } from '../protosure/stub.js';
import { validateWithRater } from '../protosure/rater-client.js';
import * as chainDefault from '../chain/chain.js';
import { asyncHandler } from '../asyncHandler.js';

const triggerSchema = z.object({
  policyId: z.string().min(1),
  triggerCode: z.enum(['PT-01', 'PT-02', 'PT-03', 'PT-04']),
  recipient: z.string().min(1),
  parentId: z.string().optional(),
  incidentId: z.string().optional(),
  eventTimestamp: z.number().optional(),
});

// Dispatches to the Protosure rater or the local stub per ATTESTATION_MODE, with fallback
// behavior on rater failure per ATTESTATION_FALLBACK. Both paths return the same shape so
// callers never need to branch on mode.
export async function runTriggerValidation({ db, policyId, triggerCode, payoutAmount, eventTimestamp }) {
  const mode = process.env.ATTESTATION_MODE || 'stub';
  if (mode === 'protosure') {
    try {
      return await validateWithRater({ policyId, triggerCode, payoutAmount, eventTimestamp });
    } catch (e) {
      const fallback = process.env.ATTESTATION_FALLBACK || 'stub';
      if (fallback === 'fail') {
        return { ok: false, reason: 'RATER_UNAVAILABLE', source: 'rater-unavailable' };
      }
      const local = stubValidate({ db, policyId, triggerCode, payoutAmount, eventTimestamp });
      return { ...local, source: 'stub-fallback' };
    }
  }
  return stubValidate({ db, policyId, triggerCode, payoutAmount, eventTimestamp });
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
    nonce: row.nonce,
    payloadHash: row.payloadHash,
    signature: row.signature,
    signerAddress: row.signerAddress,
    txHash: row.txHash,
    status: row.status,
    source: row.source,
    raterRef: row.raterRef,
  };
}

async function createAttestation(db, chain, { policyId, triggerCode, recipient, eventTimestamp }) {
  const payoutAmount = FIXED_SCHEDULE[triggerCode];
  const ts = eventTimestamp || Date.now();

  const validation = await runTriggerValidation({ db, policyId, triggerCode, payoutAmount, eventTimestamp: ts });
  if (!validation.ok) {
    return { ok: false, status: 422, body: { error: validation.reason, source: validation.source } };
  }

  if (!chain.isSignerConfigured()) {
    return { ok: false, status: 503, body: { error: 'SIGNER_NOT_CONFIGURED' } };
  }

  const nonce = chain.randomNonce();
  const payloadHash = chain.buildPayloadHash({ policyId, triggerCode, payoutAmount, recipient, timestamp: ts, nonce });
  const wallet = chain.getSignerWallet();
  const signature = await chain.signPayloadHash(wallet, payloadHash);

  const id = randomUUID();
  const source = validation.source || (process.env.ATTESTATION_MODE || 'stub');
  db.prepare(
    `INSERT INTO attestations (id, policyId, triggerCode, payoutAmount, recipient, timestamp, nonce, payloadHash, signature, signerAddress, txHash, status, source, raterRef)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`
  ).run(id, policyId, triggerCode, payoutAmount, recipient, ts, nonce, payloadHash, signature, wallet.address, 'signed', source, validation.raterRef || null);

  return { ok: true, id };
}

export function attestationRouter(db, { chain = chainDefault } = {}) {
  const router = Router();

  router.post('/v1/attestation/trigger', asyncHandler(async (req, res) => {
    const parsed = triggerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
    const { policyId, triggerCode, recipient, incidentId, parentId, eventTimestamp } = parsed.data;

    const result = await createAttestation(db, chain, { policyId, triggerCode, recipient, eventTimestamp });
    if (!result.ok) return res.status(result.status).json(result.body);

    appendEvent(db, {
      parentId: parentId || null,
      type: 'payout',
      title: `Attestation signed for ${triggerCode} (¥${FIXED_SCHEDULE[triggerCode]})`,
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

    const result = await createAttestation(db, chain, { policyId: settlementId, triggerCode: 'PT-03', recipient });
    if (!result.ok) return res.status(result.status).json(result.body);

    const lines = JSON.parse(settlement.lines_json).map((l) => (l.disputed ? l : { ...l, attested: true }));
    db.prepare('UPDATE settlements SET lines_json = ? WHERE id = ?').run(JSON.stringify(lines), settlementId);

    appendEvent(db, {
      parentId: parentId || settlement.parentId,
      type: 'settlement',
      title: `Settlement batch attested (¥${FIXED_SCHEDULE['PT-03']})`,
      deepLink: `/v1/attestation/${result.id}`,
      refId: settlementId,
    });

    res.status(201).json(rowToAttestation(db.prepare('SELECT * FROM attestations WHERE id = ?').get(result.id)));
  }));

  router.get('/v1/attestation/signer/current', (req, res) => {
    if (!chain.isSignerConfigured()) {
      return res.json({ configured: false, signerAddress: null });
    }
    try {
      const wallet = chain.getSignerWallet();
      res.json({ configured: true, signerAddress: wallet.address });
    } catch (e) {
      res.json({ configured: false, signerAddress: null, error: e.message });
    }
  });

  return router;
}
