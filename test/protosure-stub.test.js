import test from 'node:test';
import assert from 'node:assert/strict';
import { computeInner, signInner, signTrigger } from '../src/protosure/stub.js';

// Golden reference vector, verified against the real Protosure rater (see
// FamPulse_API_Sync_Changes.md). This is the load-bearing compatibility test between our
// offline signer and MimamorParametric.sol's ECDSA.recover — if this ever drifts, every
// signature will revert with SIGNER_MISMATCH on-chain.
const GOLDEN_FIELDS = {
  policyId: 'KP-2026-001',
  triggerRef: 'TRG-0001',
  coverageCode: '0x01',
  payoutAmount: '3000',
  recipient: '0x742d35Cc6634C0532925a3b8D4C9C0f25B4f2F9a',
  monthKey: '202608',
  contractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  chainId: '43113',
};
const GOLDEN_PAYLOAD_HASH = '0xc1b318da13d253576a3a51eb16289aa9ab31141cd8d3acd003049c087a77fd4d';
const GOLDEN_SIGNER = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
const DEMO_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

test('signInner reproduces the exact rater digest and recovers the golden signer', () => {
  const inner = computeInner(GOLDEN_FIELDS);
  const { payload_hash, signer } = signInner(inner, DEMO_KEY);
  assert.equal(payload_hash, GOLDEN_PAYLOAD_HASH);
  assert.equal(signer.toLowerCase(), GOLDEN_SIGNER);
});

test('signTrigger returns source:"stub" and the same golden values via STUB_SIGNER_PRIVATE_KEY', () => {
  const prev = process.env.STUB_SIGNER_PRIVATE_KEY;
  process.env.STUB_SIGNER_PRIVATE_KEY = DEMO_KEY;
  try {
    const result = signTrigger(GOLDEN_FIELDS);
    assert.equal(result.payload_hash, GOLDEN_PAYLOAD_HASH);
    assert.equal(result.signer.toLowerCase(), GOLDEN_SIGNER);
    assert.equal(result.source, 'stub');
    assert.equal(result.signature.length, 132); // 0x + 130 hex chars = 65 bytes
  } finally {
    if (prev === undefined) delete process.env.STUB_SIGNER_PRIVATE_KEY;
    else process.env.STUB_SIGNER_PRIVATE_KEY = prev;
  }
});

test('signTrigger throws StubSignerNotConfiguredError when STUB_SIGNER_PRIVATE_KEY is unset', () => {
  const prev = process.env.STUB_SIGNER_PRIVATE_KEY;
  delete process.env.STUB_SIGNER_PRIVATE_KEY;
  try {
    assert.throws(() => signTrigger(GOLDEN_FIELDS), { code: 'STUB_SIGNER_NOT_CONFIGURED' });
  } finally {
    if (prev !== undefined) process.env.STUB_SIGNER_PRIVATE_KEY = prev;
  }
});

test('changing any field changes the digest', () => {
  const a = computeInner(GOLDEN_FIELDS);
  const b = computeInner({ ...GOLDEN_FIELDS, payoutAmount: '3001' });
  assert.notEqual(a, b);
});
