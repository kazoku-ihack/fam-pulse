// Deterministic parametric rule validation — used identically by BOTH attestation modes
// (stub and protosure). The Protosure rater only signs; it never validates business rules.
// That responsibility lives here, in exactly one place, regardless of which mode is active.

import { MONTHLY_CAP } from './coverage.js';

// PT-06 (settlement) has no fixed schedule amount — its payout is the settlement's actual
// netted credit, supplied by the caller rather than looked up here.
export const FIXED_SCHEDULE = {
  'PT-01': 3000,
  'PT-02': 30000,
  'PT-03': 20000,
  'PT-04': 10000,
  'PT-05': 1000, // fraud-reward
  'PT-07': 500, // rescue reward — insurer pays Sakura each time she pays a driver directly
  'PT-08': 5000, // monthly rescue bonus — insurer pays Sakura on the 3rd rescue payment in a month
};

const PT01_MONTHLY_COUNT_CAP = 2;

// ctx: { db, triggerCode, payoutAmount, monthKey, coverageCode }
export function validateRules({ db, triggerCode, payoutAmount, monthKey, coverageCode }) {
  if (triggerCode !== 'PT-06') {
    if (!(triggerCode in FIXED_SCHEDULE)) {
      return { ok: false, reason: 'UNKNOWN_TRIGGER_CODE' };
    }
    if (payoutAmount !== FIXED_SCHEDULE[triggerCode]) {
      return { ok: false, reason: 'AMOUNT_MISMATCH' };
    }
  }

  if (triggerCode === 'PT-01' && db && monthKey) {
    const { c } = db
      .prepare(`SELECT COUNT(*) AS c FROM attestations WHERE triggerCode = 'PT-01' AND monthKey = ?`)
      .get(monthKey);
    if (c >= PT01_MONTHLY_COUNT_CAP) {
      return { ok: false, reason: 'COOLDOWN_EXCEEDED' };
    }
  }

  // Rolling monthly cap headroom, per coverage code x month, from the local cap_ledger — a fast
  // pre-check before ever attempting the (slower, gas-costing) on-chain call. The on-chain
  // contract enforces the real cap independently; this just avoids wasted round-trips.
  if (db && coverageCode && monthKey) {
    const cap = MONTHLY_CAP[triggerCode];
    if (cap != null) {
      const { spent } = db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) AS spent FROM cap_ledger WHERE coverageCode = ? AND monthKey = ? AND status IN ('reserved', 'confirmed')`
        )
        .get(coverageCode, monthKey);
      if (spent + payoutAmount > cap) {
        return { ok: false, reason: 'CAP_EXCEEDED' };
      }
    }
  }

  return { ok: true };
}
