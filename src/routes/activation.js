import { Router } from 'express';
import { randomUUID, createHmac } from 'node:crypto';
import { z } from 'zod';
import { appendEvent, getSettings } from '../db.js';
import { hashDeviceToken } from '../auth.js';
import { normaliseCredentials, NormalisationError } from '../activation-normalise.js';
import { verifyPolicy as stubVerifyPolicy } from '../protosure/policy-verify-stub.js';
import { verifyPolicy as realVerifyPolicy, NoMatchError, UpstreamError } from '../protosure/policy-verify.js';
import { asyncHandler } from '../asyncHandler.js';

const NO_MATCH_FLOOR_MS = 150; // R-20: pad every no-match exit path to the same minimum latency

function secret() {
  return process.env.DEVICE_TOKEN_SECRET || '';
}

// Salted with DEVICE_TOKEN_SECRET — no separate hashing secret is introduced, reusing the one
// secret the build plan's env list already defines.
function hashValue(value) {
  return createHmac('sha256', secret()).update(String(value)).digest('hex');
}

function generateDeviceToken(deviceId) {
  const nonce = randomUUID();
  const mac = createHmac('sha256', secret()).update(`${deviceId}.${nonce}`).digest('hex');
  return `${deviceId}.${nonce}.${mac}`;
}

async function resolveVerifyPolicy(fields) {
  const mode = process.env.ACTIVATION_MODE || 'stub';
  if (mode === 'protosure') return realVerifyPolicy(fields);
  return stubVerifyPolicy(fields);
}

function lockWindowMs() {
  return (parseInt(process.env.ACTIVATION_LOCK_MINUTES, 10) || 15) * 60 * 1000;
}
function maxAttempts() {
  return parseInt(process.env.ACTIVATION_MAX_ATTEMPTS, 10) || 5;
}

// Sliding window: counts failures for `column = value` within the trailing lock window. Once the
// count reaches maxAttempts(), locked stays true until the oldest counted failure ages out of the
// window — a single ACTIVATION_LOCK_MINUTES knob doubles as both the counting window and the
// lock duration, so "the lock expires" falls out of the same query rather than needing separate
// bookkeeping.
function checkLock(db, column, value) {
  if (!value) return { locked: false };
  const cutoff = Date.now() - lockWindowMs();
  const rows = db
    .prepare(
      `SELECT ts FROM activation_attempts WHERE ${column} = ? AND outcome = 'fail' AND ts > ? ORDER BY ts ASC`
    )
    .all(value, cutoff);
  if (rows.length < maxAttempts()) return { locked: false };
  const retryAfter = Math.max(1, Math.ceil((rows[0].ts + lockWindowMs() - Date.now()) / 1000));
  return { locked: true, retryAfter };
}

function recordAttempt(db, { policyNumberHash, deviceId, ip, outcome }) {
  db.prepare(
    `INSERT INTO activation_attempts (policyNumberHash, deviceId, ip, outcome, ts) VALUES (?,?,?,?,?)`
  ).run(policyNumberHash, deviceId || null, ip || null, outcome, Date.now());
}

async function respondNoMatch(res, startTs) {
  const elapsed = Date.now() - startTs;
  if (elapsed < NO_MATCH_FLOOR_MS) {
    await new Promise((resolve) => setTimeout(resolve, NO_MATCH_FLOOR_MS - elapsed));
  }
  return res.status(401).json({ error: 'AUTH_NO_MATCH' });
}

const activationVerifySchema = z.object({
  role: z.enum(['parent', 'adult_child']),
  policyNumber: z.string().min(1),
  insuredDob: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().min(1),
  deviceId: z.string().min(1),
});

const activationCompleteSchema = z.object({
  activationId: z.string().min(1),
  deviceId: z.string().min(1),
  pushToken: z.string().optional(),
});

function upsertHousehold(db, verified, normalisedPolicyNumber, insuredDobHash, now) {
  const existing = db.prepare('SELECT * FROM households WHERE customerId = ?').get(verified.customerId);
  const householdId = existing ? existing.householdId : randomUUID();
  const coveragesJson = JSON.stringify(verified.coverages || []);
  if (existing) {
    db.prepare(
      `UPDATE households SET originalQuoteId=?, smartContractId=?, policyNumber=?, policyStatus=?, insuredDisplayName=?, insuredDobHash=?, coveragesJson=?, lastReconciledAt=? WHERE householdId=?`
    ).run(
      verified.originalQuoteId,
      verified.smartContractId,
      normalisedPolicyNumber,
      verified.policyStatus,
      verified.insuredDisplayName,
      insuredDobHash,
      coveragesJson,
      now,
      householdId
    );
  } else {
    db.prepare(
      `INSERT INTO households (householdId, customerId, originalQuoteId, smartContractId, policyNumber, policyStatus, insuredDisplayName, insuredDobHash, coveragesJson, createdAt, lastReconciledAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      householdId,
      verified.customerId,
      verified.originalQuoteId,
      verified.smartContractId,
      normalisedPolicyNumber,
      verified.policyStatus,
      verified.insuredDisplayName,
      insuredDobHash,
      coveragesJson,
      now,
      now
    );
  }
  return householdId;
}

// Guarded to protosure mode only. There is no confirmed Protosure contract yet for "look up a
// policy by customerId alone" (verifyPolicy requires all four original credentials, which are
// deliberately never retained past the verify call) — this is a wiring point for that future
// contract, not a live integration. Logs rather than throws so a misconfigured/unspecified
// reconciliation never takes down the periodic tick.
export async function reconcileHousehold(db, householdId) {
  if ((process.env.ACTIVATION_MODE || 'stub') !== 'protosure') return;
  console.log(
    JSON.stringify({ reconcile: true, householdId, note: 'no confirmed Protosure lookup-by-customerId contract yet — no-op' })
  );
}

function maskedDob() {
  // insuredDob is never retained past the verify call (only insuredDobHash, one-way) — there is
  // no partial-real-digit mask to derive from a hash, so this is a constant placeholder rather
  // than a fabricated-looking partial date.
  return '**-**-**';
}

export function activationRouter(db) {
  const router = Router();

  router.post(
    '/v1/activation/verify',
    asyncHandler(async (req, res) => {
      const startTs = Date.now();
      const parsed = activationVerifySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
      const { role, policyNumber, insuredDob, phone, email, deviceId } = parsed.data;
      const ip = req.ip;

      let policyNumberHash;
      try {
        policyNumberHash = hashValue(policyNumber.trim().toUpperCase().replace(/\s+/g, ' '));
      } catch {
        policyNumberHash = hashValue(policyNumber);
      }

      // Lock check happens before any Protosure call — a locked policy number (or IP) must never
      // generate upstream load.
      const policyLock = checkLock(db, 'policyNumberHash', policyNumberHash);
      const ipLock = checkLock(db, 'ip', ip);
      if (policyLock.locked || ipLock.locked) {
        const retryAfter = Math.max(policyLock.retryAfter || 0, ipLock.retryAfter || 0);
        return res.status(423).json({ error: 'ACTIVATION_LOCKED', retryAfter });
      }

      let normalised;
      try {
        normalised = normaliseCredentials({ policyNumber, insuredDob, phone, email });
      } catch (e) {
        if (!(e instanceof NormalisationError)) throw e;
        recordAttempt(db, { policyNumberHash, deviceId, ip, outcome: 'fail' });
        return respondNoMatch(res, startTs);
      }

      let verified;
      try {
        verified = await resolveVerifyPolicy(normalised);
      } catch (e) {
        if (e instanceof UpstreamError) {
          return res.status(502).json({ error: 'PROTOSURE_UNAVAILABLE' });
        }
        if (e instanceof NoMatchError) {
          recordAttempt(db, { policyNumberHash, deviceId, ip, outcome: 'fail' });
          return respondNoMatch(res, startTs);
        }
        throw e;
      }

      const now = Date.now();
      const insuredDobHash = hashValue(normalised.insuredDob);
      const householdId = upsertHousehold(db, verified, normalised.policyNumber, insuredDobHash, now);
      await reconcileHousehold(db, householdId);

      const activationId = randomUUID();
      const ttlMs = (parseInt(process.env.ACTIVATION_TTL_MINUTES, 10) || 15) * 60 * 1000;
      db.prepare(
        `INSERT INTO activations (activationId, deviceId, role, householdId, state, createdAt, expiresAt) VALUES (?,?,?,?, 'verified', ?, ?)`
      ).run(activationId, deviceId, role, householdId, now, now + ttlMs);

      recordAttempt(db, { policyNumberHash, deviceId, ip, outcome: 'success' });

      res.json({
        activationId,
        customerId: verified.customerId,
        originalQuoteId: verified.originalQuoteId,
        smartContractId: verified.smartContractId,
        householdId,
        policyStatus: verified.policyStatus,
        insuredDisplayName: verified.insuredDisplayName,
        coverages: verified.coverages || [],
        // Not issued until POST /v1/activation/complete — included as null so the shape matches
        // the spec's ActivationResult across both endpoints.
        deviceToken: null,
      });
    })
  );

  router.post('/v1/activation/complete', (req, res) => {
    const parsed = activationCompleteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
    const { activationId, deviceId, pushToken } = parsed.data;

    const activation = db.prepare('SELECT * FROM activations WHERE activationId = ?').get(activationId);
    if (!activation || activation.state !== 'verified') {
      return res.status(409).json({ error: 'ACTIVATION_NOT_VERIFIED' });
    }
    const now = Date.now();
    if (activation.expiresAt < now) {
      db.prepare(`UPDATE activations SET state = 'expired' WHERE activationId = ?`).run(activationId);
      return res.status(409).json({ error: 'ACTIVATION_EXPIRED' });
    }

    const { householdId, role } = activation;
    const deviceToken = generateDeviceToken(deviceId);
    const deviceTokenHash = hashDeviceToken(deviceToken);

    const txn = db.transaction(() => {
      db.prepare(
        `UPDATE devices SET revokedAt = ? WHERE householdId = ? AND role = ? AND revokedAt IS NULL AND deviceId != ?`
      ).run(now, householdId, role, deviceId);
      db.prepare(
        `INSERT INTO devices (deviceId, householdId, role, deviceTokenHash, pushToken, activatedAt, lastSeen, revokedAt)
         VALUES (?,?,?,?,?,?,?,NULL)
         ON CONFLICT(deviceId) DO UPDATE SET
           householdId = excluded.householdId, role = excluded.role, deviceTokenHash = excluded.deviceTokenHash,
           pushToken = excluded.pushToken, activatedAt = excluded.activatedAt, lastSeen = excluded.lastSeen, revokedAt = NULL`
      ).run(deviceId, householdId, role, deviceTokenHash, pushToken || null, now, now);
      db.prepare(`UPDATE activations SET state = 'completed' WHERE activationId = ?`).run(activationId);
    });
    txn();

    appendEvent(db, {
      parentId: householdId,
      type: 'activation_completed',
      title: `Device activated — role ${role}`,
      deepLink: `/v1/household/${householdId}`,
      refId: deviceId,
    });

    res.json({ householdId, role, deviceToken, nextScreen: role === 'parent' ? 'W-08' : 'W-01' });
  });

  router.get('/v1/activation/status', (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'deviceId required' });
    const device = db.prepare('SELECT * FROM devices WHERE deviceId = ?').get(deviceId);
    if (!device) return res.json({ state: 'unactivated' });
    if (device.revokedAt) return res.json({ state: 'revoked', role: device.role, householdId: device.householdId });
    return res.json({ state: 'active', role: device.role, householdId: device.householdId });
  });

  router.get('/v1/household/:id', (req, res) => {
    const household = db.prepare('SELECT * FROM households WHERE householdId = ?').get(req.params.id);
    if (!household) return res.status(404).json({ error: 'NOT_FOUND' });
    const devices = db
      .prepare('SELECT deviceId, role, lastSeen, activatedAt FROM devices WHERE householdId = ? AND revokedAt IS NULL')
      .all(household.householdId);
    // parentId === householdId for the demo's 1:1 household<->parent mapping (see src/db.js seed()).
    const settings = getSettings(db, household.householdId);
    res.json({
      householdId: household.householdId,
      customerId: household.customerId,
      originalQuoteId: household.originalQuoteId,
      smartContractId: household.smartContractId,
      policyNumber: household.policyNumber,
      policyStatus: household.policyStatus,
      insuredDisplayName: household.insuredDisplayName,
      insuredDobMasked: maskedDob(),
      devices,
      geofenceConfigured: Boolean(settings.homeLatLng && settings.geofenceRadius),
      consentGranted: Boolean(settings.sharingEnabled),
      configVersion: settings.configVersion,
    });
  });

  return router;
}
