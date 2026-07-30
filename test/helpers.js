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
// Unrelated golden key for the Rider contract's oracleSig co-signature (routes/payments.js) —
// forced, same rationale as STUB_SIGNER_PRIVATE_KEY above: deterministic regardless of a
// developer's local .env. Recovers to 0xA911EBe20Fb0909DCAD75821cbF7A9e57Ebaf9c9.
process.env.ORACLE_SIGNER_PRIVATE_KEY = '8f5f86e882c0024e635799ec6d26beb5b44a0b5a8b842f6417ebf95c4cc42b21';
process.env.RIDER_ADDR = process.env.RIDER_ADDR || '0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE';
// Seeded as the 'sakura' wallet's address (src/db.js#seed) — used as the default recipient by
// POST /v1/jpyc/rehearseTransfer when no attestationId is given.
process.env.SAKURA_WALLET_ADDR = process.env.SAKURA_WALLET_ADDR || '0x742d35Cc6634C0532925a3b8D4C9C0f25B4f2F9a';
// Same rationale as ATTESTATION_MODE above: force stub activation regardless of a developer's
// local ACTIVATION_MODE=protosure, so the offline suite never depends on live Protosure reachability.
process.env.ACTIVATION_MODE = 'stub';
process.env.DEVICE_TOKEN_SECRET = process.env.DEVICE_TOKEN_SECRET || 'test-device-token-secret';

export const API_KEY = process.env.API_KEY;

export function setupApp(deps = {}) {
  const db = openDb(':memory:');
  seed(db);
  const app = createApp(db, deps);
  return { app, db };
}
