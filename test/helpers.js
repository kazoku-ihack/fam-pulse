import { openDb, seed } from '../src/db.js';
import { createApp } from '../src/server.js';

process.env.API_KEY = process.env.API_KEY || 'test-key';
// Force stub mode regardless of the developer's local .env — tests must stay deterministic and
// offline even when ATTESTATION_MODE=protosure is set for live Protosure testing. Tests that
// specifically exercise the live-rater path (test/attestation-fallback.test.js) override this
// per-test via withEnv.
process.env.ATTESTATION_MODE = 'stub';
// Demo key from the golden reference vector (FamPulse_API_Sync_Changes.md) — offline-only,
// signs attestations in stub mode without touching any network. Forced (not a fallback) because
// the developer's local .env may hold a real Fuji deploy/rehearsal key for live testing, which
// recovers to a different address than the golden vector's REGISTERED_SIGNER below.
process.env.STUB_SIGNER_PRIVATE_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
process.env.REGISTERED_SIGNER = process.env.REGISTERED_SIGNER || '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
process.env.PAYOUT_ADDR = process.env.PAYOUT_ADDR || '0x5FbDB2315678afecb367f032d93F642f64180aa3';
process.env.CHAIN_ID = process.env.CHAIN_ID || '43113';

export const API_KEY = process.env.API_KEY;

export function setupApp(deps = {}) {
  const db = openDb(':memory:');
  seed(db);
  const app = createApp(db, deps);
  return { app, db };
}
