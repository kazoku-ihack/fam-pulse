// Deterministic parametric rule validation — used identically by BOTH attestation modes
// (stub and protosure). The Protosure rater only signs; it never validates business rules.
// That responsibility lives here, in exactly one place, regardless of which mode is active.

import { MONTHLY_CAP } from './coverage.js';

// month_key is always derived in Asia/Tokyo, regardless of server host timezone. Lives here
// (rather than in routes/attestation.js, where it originated) so routes/payments.js can also
// import it without creating a circular dependency — attestation.js already imports from
// payments.js (computeNetCredit), and attestation-rules.js imports from neither.
export function monthKeyTokyo(ts = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(ts));
  const year = parts.find((p) => p.type === 'year').value;
  const month = parts.find((p) => p.type === 'month').value;
  return `${year}${month}`;
}

// PT-06 (settlement) has no fixed schedule amount — its payout is the settlement's actual
// netted credit, supplied by the caller rather than looked up here.
export const FIXED_SCHEDULE = {
  'PT-01': 3000,
  'PT-02': 30000,
  'PT-03': 20000,
  'PT-04': 10000,
  'PT-05': 1000, // fraud-reward
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
