import test from 'node:test';
import assert from 'node:assert/strict';
import { sign, RaterUnavailableError } from '../src/protosure/rater-client.js';

// Fixture = the golden reference vector's expected response shape (see
// FamPulse_API_Sync_Changes.md and test/protosure-stub.test.js for the offline half of this
// same contract).
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

function jsonFetch(calculation, ok = true) {
  return async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ calculation }) });
}

function withRegisteredSigner(value, fn) {
  const prev = process.env.REGISTERED_SIGNER;
  process.env.REGISTERED_SIGNER = value;
  return fn().finally(() => {
    process.env.REGISTERED_SIGNER = prev;
  });
}

test('sends the eight snake_case fields and accepts a golden-vector-shaped response', async () => {
  let capturedBody;
  const fetchImpl = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ calculation: { payload_hash: GOLDEN_PAYLOAD_HASH, signature: '0x' + '11'.repeat(65), signer: GOLDEN_SIGNER } }) };
  };
  await withRegisteredSigner(GOLDEN_SIGNER, async () => {
    const result = await sign(GOLDEN_FIELDS, { fetchImpl });
    assert.equal(result.payload_hash, GOLDEN_PAYLOAD_HASH);
    assert.equal(result.signer, GOLDEN_SIGNER);
    assert.equal(result.source, 'protosure');
  });
  assert.deepEqual(capturedBody, {
    policy_id: 'KP-2026-001',
    trigger_ref: 'TRG-0001',
    coverage_code: '0x01',
    payout_amount: '3000',
    recipient: '0x742d35Cc6634C0532925a3b8D4C9C0f25B4f2F9a',
    month_key: '202608',
    contract_address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    chain_id: '43113',
  });
});

test('rejects a response signed by a signer other than REGISTERED_SIGNER', async () => {
  await withRegisteredSigner(GOLDEN_SIGNER, async () => {
    await assert.rejects(
      () =>
        sign(GOLDEN_FIELDS, {
          fetchImpl: jsonFetch({ payload_hash: GOLDEN_PAYLOAD_HASH, signature: '0x' + '11'.repeat(65), signer: '0x0000000000000000000000000000000000dEaD' }),
        }),
      RaterUnavailableError
    );
  });
});

test('rejects a signature that is not 65 bytes', async () => {
  await withRegisteredSigner(GOLDEN_SIGNER, async () => {
    await assert.rejects(
      () =>
        sign(GOLDEN_FIELDS, {
          fetchImpl: jsonFetch({ payload_hash: GOLDEN_PAYLOAD_HASH, signature: '0x1234', signer: GOLDEN_SIGNER }),
        }),
      RaterUnavailableError
    );
  });
});

test('rejects a malformed response missing calculation fields', async () => {
  await withRegisteredSigner(GOLDEN_SIGNER, async () => {
    await assert.rejects(
      () => sign(GOLDEN_FIELDS, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }),
      RaterUnavailableError
    );
  });
});

test('timeout/unreachable rater retries once (R-19) then throws RaterUnavailableError', async () => {
  let calls = 0;
  const flakyFetch = async () => {
    calls++;
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(() => sign(GOLDEN_FIELDS, { fetchImpl: flakyFetch }), RaterUnavailableError);
  assert.equal(calls, 2); // one retry, per R-19
});
