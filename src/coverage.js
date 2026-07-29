// Single source of truth for trigger-code <-> coverage-code mapping and monthly caps.
// Imported by attestation-rules.js (local headroom pre-check), routes/attestation.js (digest
// fields), and chain/deploy.js (on-chain setCap calls) — never duplicate these elsewhere.

export const COVERAGE_CODE = {
  'PT-01': '0x01',
  'PT-02': '0x02',
  'PT-03': '0x03',
  'PT-04': '0x04',
  'PT-05': '0x05',
  'PT-06': '0x06',
  'PT-07': '0x07',
  'PT-08': '0x08',
};

export const TRIGGER_CODES = Object.keys(COVERAGE_CODE);

// Whole-JPY monthly cap per coverage code — mirrors what chain/deploy.js sets on-chain via
// MimamorParametric.setCap. Used locally for a fast pre-check (cap_ledger headroom) before ever
// attempting the (much slower, gas-costing) on-chain call.
export const MONTHLY_CAP = {
  'PT-01': 6000,
  'PT-02': 30000,
  'PT-03': 20000,
  'PT-04': 10000,
  'PT-05': 5000,
  'PT-06': 100000,
  'PT-07': 5000, // rescue reward, ¥500 x up to 10 dispatch payments/month
  'PT-08': 5000, // monthly rescue bonus — fires at most once/month by dispatch.js gating; this is a backstop
};
