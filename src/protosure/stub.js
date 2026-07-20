// Deterministic fallback rater: the same rule check as the real Protosure API Rater
// (protosure/rater-client.js), entirely local. Identical interface — flipping
// ATTESTATION_MODE between "stub" and "protosure" is the only thing that changes.

export const FIXED_SCHEDULE = { 'PT-01': 3000, 'PT-02': 30000, 'PT-03': 20000, 'PT-04': 10000 };

const PT01_BUCKET_CAP = 2;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function validateTrigger({ db, policyId, triggerCode, payoutAmount, eventTimestamp = Date.now() }) {
  if (!(triggerCode in FIXED_SCHEDULE)) {
    return { ok: false, reason: 'UNKNOWN_TRIGGER_CODE' };
  }
  if (payoutAmount !== FIXED_SCHEDULE[triggerCode]) {
    return { ok: false, reason: 'RATER_AMOUNT_MISMATCH' };
  }
  if (triggerCode === 'PT-01' && db) {
    const since = eventTimestamp - THIRTY_DAYS_MS;
    const { c } = db
      .prepare(`SELECT COUNT(*) AS c FROM attestations WHERE triggerCode = 'PT-01' AND timestamp >= ?`)
      .get(since);
    if (c >= PT01_BUCKET_CAP) return { ok: false, reason: 'COOLDOWN_EXCEEDED' };
  }
  return { ok: true, raterRef: null, source: 'stub' };
}
