import { Router } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { appendEvent, getSettings } from '../db.js';
import { requireRole } from '../auth.js';
import {
  startDispatchSimulation,
  cancelDispatchSimulation,
  driverInfo,
  routePolyline,
  signPayload,
} from '../sims/uber.js';
import * as chainDefault from '../chain/chain.js';
import { createAttestation, monthKeyTokyo } from './attestation.js';
import { executePayoutOnChain, mapChainError, PERMANENT_FAILURE_REASONS, releaseCapLedger, withTimeout } from './payments.js';
import { asyncHandler } from '../asyncHandler.js';

export const STATE_ORDER = ['requested', 'accepted', 'en_route', 'arrived', 'completed'];
const TERMINAL_STATES = ['completed', 'cancelled'];
const MAX_RETRIES = 3;

// Fixed ride fee, paid directly out of Sakura's own JPYC balance — not an insurance payout, so it
// doesn't ride the attestation/cap-ledger machinery below. PT-07/PT-08 (funded from the insurer's
// pool) are separate, best-effort legs triggered as a side effect of this payment.
export const TAXI_RIDE_FEE_JPY = 2000;
// How many rescue payments (dispatch-completion driver payments) in a single Tokyo month-key
// trigger the PT-08 monthly bonus. Lives here, not attestation-rules.js, because the count is
// read from `dispatches` (dispatch-domain data), not from `attestations` — attestation-rules.js's
// validateRules() only ever reasons about attestation rows and cap_ledger.
const RESCUE_BONUS_THRESHOLD = 3;
const DEFAULT_POLICY_ID = 'KP-2026-001'; // fallback when a household has no policyNumber on file

function webhookSecret() {
  return process.env.API_KEY || 'kazoku-demo-webhook-secret';
}

function baseUrl() {
  return process.env.INTERNAL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
}

function parseDispatch(row) {
  return {
    id: row.id,
    incidentId: row.incidentId,
    status: row.status,
    driver: JSON.parse(row.driver_json),
    etaMin: row.etaMin,
    lat: row.lat,
    lng: row.lng,
    retryCount: row.retryCount,
  };
}

const dispatchSchema = z.object({
  incidentId: z.string().min(1),
});

const payDriverSchema = z.object({
  // Explicit per-request override for SAKURA_WALLET_PRIVATE_KEY — see
  // chain.js#getSakuraWallet for why this is never persisted or logged.
  sakuraPrivateKey: z.string().min(1).optional(),
});

// Core dispatch-creation logic, shared by the HTTP route and by automatic triggers (e.g. an
// unusual wandering triage result — see createDispatchForIncident's caller in routes/incidents.js).
// `incident` only needs { id, parentId, lat, lng }. Returns { status, body } — never throws for
// expected business outcomes (duplicate/retry-limit), so callers can act on `status` uniformly.
export function createDispatchForIncident(db, incident, { idempotencyKey = null } = {}) {
  if (idempotencyKey) {
    const existing = db
      .prepare('SELECT * FROM dispatches WHERE incidentId = ? AND idempotencyKey = ?')
      .get(incident.id, idempotencyKey);
    if (existing) return { status: 200, body: parseDispatch(existing) };
  }

  const activeExisting = db
    .prepare(`SELECT * FROM dispatches WHERE incidentId = ? AND status NOT IN ('completed','cancelled')`)
    .get(incident.id);
  if (activeExisting) {
    return { status: 409, body: { error: 'DUPLICATE_ACTIVE_DISPATCH', dispatch: parseDispatch(activeExisting) } };
  }

  const priorCount = db
    .prepare(`SELECT COUNT(*) AS c FROM dispatches WHERE incidentId = ?`)
    .get(incident.id).c;
  if (priorCount >= MAX_RETRIES) {
    return { status: 429, body: { error: 'RETRY_LIMIT_EXCEEDED' } };
  }

  const settings = getSettings(db, incident.parentId);
  const pickup = { lat: incident.lat, lng: incident.lng };
  const dropoff = settings.homeLatLng;

  const id = randomUUID();
  const driver = driverInfo();
  db.prepare(
    `INSERT INTO dispatches (id, incidentId, status, driver_json, etaMin, lat, lng, retryCount, idempotencyKey, createdTs)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, incident.id, 'requested', JSON.stringify(driver), 8, pickup.lat, pickup.lng, priorCount, idempotencyKey || null, Date.now());

  appendEvent(db, {
    parentId: incident.parentId,
    type: 'wandering',
    title: `Taxi dispatched — ${driver.name}`,
    deepLink: `/v1/uber/dispatch/${id}`,
    refId: id,
  });

  startDispatchSimulation({
    dispatchId: id,
    incidentId: incident.id,
    baseUrl: baseUrl(),
    secret: webhookSecret(),
    pickup,
    dropoff,
  });

  return { status: 201, body: parseDispatch(db.prepare('SELECT * FROM dispatches WHERE id = ?').get(id)) };
}

function resolvePolicyId(db, parentId) {
  const row = parentId ? db.prepare('SELECT policyNumber FROM households WHERE householdId = ?').get(parentId) : null;
  return row?.policyNumber || DEFAULT_POLICY_ID;
}

// Signs and immediately submits an insurer-funded PT-07/PT-08 attestation — the same two-step
// create-then-execute shape as POST /v1/attestation/trigger + POST /v1/jpyc/transfer, just called
// as direct functions instead of two HTTP round-trips so "Approve & Pay" is a single click.
// Best-effort: a failure here is reported back, never thrown — the driver has already been paid
// (an irreversible on-chain transfer) by the time this runs, so it must not fail the request.
async function fireInsurerPayout(db, chain, { policyId, triggerCode, recipient, triggerRef, eventTimestamp, parentId }) {
  const created = await createAttestation(db, chain, { policyId, triggerCode, recipient, triggerRef, eventTimestamp });
  if (!created.ok) return { ok: false, error: created.body.error };

  const att = db.prepare('SELECT * FROM attestations WHERE id = ?').get(created.id);
  try {
    const { txHash, explorerUrl } = await withTimeout(executePayoutOnChain(chain, att), 10000);
    db.prepare(`UPDATE attestations SET status = 'paid', txHash = ? WHERE id = ?`).run(txHash, att.id);
    appendEvent(db, {
      parentId,
      type: 'payout',
      title: `${triggerCode === 'PT-08' ? 'Monthly rescue bonus' : 'Rescue reward'} paid: ¥${att.payoutAmount}`,
      deepLink: explorerUrl,
      refId: att.id,
    });
    return { ok: true, attestationId: att.id, txHash, explorerUrl };
  } catch (e) {
    if (e.code === 'TIMEOUT') return { ok: false, error: 'TIMEOUT', attestationId: att.id };
    const mapped = mapChainError(e);
    if (PERMANENT_FAILURE_REASONS.has(mapped.error)) releaseCapLedger(db, att.id);
    return { ok: false, error: mapped.error, attestationId: att.id };
  }
}

async function executeDriverTransfer(chain, sakuraWallet, driverWalletAddr) {
  const jpyc = chain.getJpycContract(sakuraWallet);
  const tx = await jpyc.transfer(driverWalletAddr, BigInt(TAXI_RIDE_FEE_JPY));
  const receipt = await tx.wait();
  return { txHash: receipt.hash, explorerUrl: chain.explorerUrl(receipt.hash) };
}

// Core "Approve & Pay" logic, shared by the authenticated route and the Judge Console's
// judge-key-gated demo proxy (routes/demo.js) — the console is a static page that can never hold
// x-api-key, so it can't call the real route directly. `parentId` is always derived from the
// dispatch's own incident, never taken from the caller, so it can't be spoofed into crediting a
// PT-07/PT-08 reward against the wrong policy. `sakuraPrivateKey`, if given, is an explicit
// per-request key that overrides SAKURA_WALLET_PRIVATE_KEY (see chain.js#getSakuraWallet) — never
// persisted, only ever used to build one ephemeral ethers.Wallet for this single payment.
export async function payDriverForDispatch(db, chain, { dispatchId, sakuraPrivateKey }) {
  const dispatch = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(dispatchId);
  if (!dispatch) return { status: 404, body: { error: 'NOT_FOUND' } };
  if (dispatch.status !== 'completed') {
    return { status: 409, body: { error: 'DISPATCH_NOT_COMPLETED' } };
  }

  if (dispatch.driverPaidTxHash) {
    return {
      status: 200,
      body: {
        alreadyPaid: true,
        driverPayment: {
          txHash: dispatch.driverPaidTxHash,
          explorerUrl: chain.explorerUrl(dispatch.driverPaidTxHash),
          amount: TAXI_RIDE_FEE_JPY,
        },
      },
    };
  }

  if (!chain.isChainDeployed() || !chain.isSakuraWalletConfigured(sakuraPrivateKey)) {
    return { status: 503, body: { error: 'SAKURA_WALLET_NOT_CONFIGURED' } };
  }

  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(dispatch.incidentId);
  const parentId = incident?.parentId || null;
  const driver = JSON.parse(dispatch.driver_json);

  let txHash, explorerUrl;
  try {
    const sakuraWallet = chain.getSakuraWallet(sakuraPrivateKey);
    ({ txHash, explorerUrl } = await withTimeout(
      executeDriverTransfer(chain, sakuraWallet, driver.driverWalletAddr),
      10000
    ));
  } catch (e) {
    if (e.code === 'TIMEOUT') return { status: 200, body: { status: 'pending', dispatchId } };
    return { status: 502, body: { error: 'CHAIN_ERROR', message: e.message } };
  }

  const paidTs = Date.now();
  db.prepare('UPDATE dispatches SET driverPaidTxHash = ?, driverPaidTs = ? WHERE id = ?').run(txHash, paidTs, dispatchId);
  appendEvent(db, {
    parentId,
    type: 'payout',
    title: `Driver paid ¥${TAXI_RIDE_FEE_JPY} — ${driver.name}`,
    deepLink: explorerUrl,
    refId: dispatchId,
  });

  const result = {
    driverPayment: { txHash, explorerUrl, amount: TAXI_RIDE_FEE_JPY },
    reward: null,
    bonus: null,
  };

  const sakuraAddr = db.prepare("SELECT address FROM wallets WHERE name = 'sakura'").get()?.address;
  if (!sakuraAddr) {
    result.reward = { ok: false, error: 'SAKURA_ADDR_NOT_CONFIGURED' };
    return { status: 201, body: result };
  }

  const policyId = resolvePolicyId(db, parentId);
  result.reward = await fireInsurerPayout(db, chain, {
    policyId,
    triggerCode: 'PT-07',
    recipient: sakuraAddr,
    triggerRef: `reward-${dispatchId}`,
    eventTimestamp: paidTs,
    parentId,
  });

  const monthKey = monthKeyTokyo(paidTs);
  const countThisMonth = db
    .prepare(`SELECT driverPaidTs FROM dispatches WHERE driverPaidTxHash IS NOT NULL`)
    .all()
    .filter((r) => monthKeyTokyo(r.driverPaidTs) === monthKey).length;
  const existingBonus = db
    .prepare(`SELECT id FROM attestations WHERE triggerCode = 'PT-08' AND monthKey = ?`)
    .get(monthKey);

  if (countThisMonth >= RESCUE_BONUS_THRESHOLD && !existingBonus) {
    result.bonus = await fireInsurerPayout(db, chain, {
      policyId,
      triggerCode: 'PT-08',
      recipient: sakuraAddr,
      triggerRef: `bonus-${monthKey}`,
      eventTimestamp: paidTs,
      parentId,
    });
  }

  return { status: 201, body: result };
}

export function dispatchRouter(db, { chain = chainDefault } = {}) {
  const router = Router();

  router.post('/v1/uber/dispatch', requireRole('adult_child'), (req, res) => {
    const parsed = dispatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
    const { incidentId } = parsed.data;
    const idempotencyKey = req.header('idempotency-key') || req.header('Idempotency-Key');

    const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);
    if (!incident) return res.status(404).json({ error: 'INCIDENT_NOT_FOUND' });

    const { status, body } = createDispatchForIncident(db, incident, { idempotencyKey });
    res.status(status).json(body);
  });

  router.get('/v1/uber/dispatch/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(row.incidentId);
    const settings = getSettings(db, incident.parentId);
    const pickup = { lat: incident.lat, lng: incident.lng };
    const dropoff = settings.homeLatLng;
    res.json({
      status: row.status,
      driverName: JSON.parse(row.driver_json).name,
      rating: JSON.parse(row.driver_json).rating,
      vehicle: JSON.parse(row.driver_json).vehicle,
      plate: JSON.parse(row.driver_json).plate,
      etaMin: row.etaMin,
      driverLocation: { lat: row.lat, lng: row.lng },
      routePolyline: routePolyline(pickup, dropoff),
      driverWalletAddr: JSON.parse(row.driver_json).driverWalletAddr,
      retryCount: row.retryCount,
    });
  });

  router.post('/v1/uber/dispatch/:id/pay', requireRole('adult_child'), asyncHandler(async (req, res) => {
    const parsed = payDriverSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
    const { status, body } = await payDriverForDispatch(db, chain, {
      dispatchId: req.params.id,
      sakuraPrivateKey: parsed.data.sakuraPrivateKey,
    });
    res.status(status).json(body);
  }));

  router.delete('/v1/uber/dispatch/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    cancelDispatchSimulation(row.id);
    db.prepare(`UPDATE dispatches SET status = 'cancelled' WHERE id = ?`).run(row.id);
    res.status(204).end();
  });

  return router;
}

// Public (unauthenticated by x-api-key — mounted before the auth middleware in server.js):
// authenticated instead by HMAC signature, exactly like a real provider webhook would be.
export function uberWebhookRouter(db) {
  const router = Router();

  router.post('/v1/webhooks/uber', (req, res) => {
    const signature = req.header('x-uber-signature');
    const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
    const expected = signPayload(webhookSecret(), raw);
    const sigBuf = Buffer.from(signature || '', 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    const valid = sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
    if (!valid) return res.status(401).json({ error: 'BAD_SIGNATURE' });

    const { dispatchId, status, driverLocation, etaMin } = req.body;
    const row = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(dispatchId);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    if (TERMINAL_STATES.includes(row.status)) {
      return res.status(409).json({ error: 'DISPATCH_ALREADY_TERMINAL' });
    }

    const currentIdx = STATE_ORDER.indexOf(row.status);
    const nextIdx = STATE_ORDER.indexOf(status);
    if (nextIdx === -1 || nextIdx !== currentIdx + 1) {
      return res.status(409).json({ error: 'INVALID_STATE_TRANSITION', from: row.status, to: status });
    }

    db.prepare('UPDATE dispatches SET status = ?, etaMin = ?, lat = ?, lng = ? WHERE id = ?').run(
      status,
      etaMin ?? row.etaMin,
      driverLocation?.lat ?? row.lat,
      driverLocation?.lng ?? row.lng,
      dispatchId
    );

    if (status === 'completed') {
      const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(row.incidentId);
      if (incident) {
        appendEvent(db, {
          parentId: incident.parentId,
          type: 'visit_completed',
          title: 'Taxi ride completed',
          deepLink: `/v1/uber/dispatch/${dispatchId}`,
          refId: dispatchId,
        });
      }
    }

    res.json({ ok: true });
  });

  return router;
}
