// Offline fixture for ACTIVATION_MODE=stub — deliberately enforces the exact same
// all-four-fields-must-match rule as the real path (src/protosure/policy-verify.js). A stub that
// is more permissive than production would hide integration bugs until demo day; see
// test/activation.test.js's "stub parity" case, which asserts flipping any single field fails.

import { normaliseCredentials, NormalisationError } from '../activation-normalise.js';
import { NoMatchError } from './policy-verify.js';

const FIXTURES = [
  {
    policyNumber: 'KP-2026-001',
    insuredDob: '1948-03-12',
    phone: '+819012345678',
    email: 'sakura.tanaka@example.jp',
    result: {
      customerId: 'CUST-DEMO-001',
      originalQuoteId: 'QT-2026-000481',
      smartContractId: 'SC-FUJI-0001',
      policyStatus: 'in_force',
      insuredDisplayName: 'Yoshiko Tanaka',
      coverages: ['PT-01', 'PT-02', 'PT-03', 'PT-04', 'PT-05', 'PT-06'],
    },
  },
  {
    policyNumber: 'KP-2026-002',
    insuredDob: '1951-11-04',
    phone: '+819098765432',
    email: 'judge.demo@example.jp',
    result: {
      customerId: 'CUST-DEMO-002',
      originalQuoteId: 'QT-2026-000502',
      smartContractId: 'SC-FUJI-0002',
      policyStatus: 'in_force',
      insuredDisplayName: 'Judge Demo',
      coverages: ['PT-01', 'PT-02', 'PT-03', 'PT-04', 'PT-05', 'PT-06'],
    },
  },
];

export async function verifyPolicy({ policyNumber, insuredDob, phone, email }) {
  let normalised;
  try {
    normalised = normaliseCredentials({ policyNumber, insuredDob, phone, email });
  } catch (e) {
    if (e instanceof NormalisationError) throw new NoMatchError('normalisation failed');
    throw e;
  }

  const match = FIXTURES.find(
    (f) =>
      f.policyNumber === normalised.policyNumber &&
      f.insuredDob === normalised.insuredDob &&
      f.phone === normalised.phone &&
      f.email === normalised.email
  );
  if (!match) throw new NoMatchError('no fixture matched all four credentials');
  return { ...match.result };
}
