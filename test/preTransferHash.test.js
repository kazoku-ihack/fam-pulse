import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { computeInner, signInner } from '../src/protosure/stub.js';
import { setupApp, API_KEY } from './helpers.js';
import { makeFakeChain } from './fakeChain.js';
import { _resetDemoTxThrottle } from '../src/routes/payments.js';

// Same golden reference vector used in test/protosure-stub.test.js — DEMO_KEY recovers to
// GOLDEN_SIGNER, which test/helpers.js forces as REGISTERED_SIGNER, so a signature produced here
// passes the SIGNER_NOT_REGISTERED check exactly like a real Protosure attestation would.
const DEMO_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const GOLDEN_SIGNER = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';
// PAYOUT_ADDR/CHAIN_ID use a soft `||` fallback in helpers.js (unlike STUB_SIGNER_PRIVATE_KEY),
// so a developer's local .env can override them — read whatever's actually active rather than
// hardcoding the golden default, or this test would fail outside a completely empty .env.
const PAYOUT_ADDR = process.env.PAYOUT_ADDR;
const CHAIN_ID = process.env.CHAIN_ID;
const RECIPIENT = '0x742d35Cc6634C0532925a3b8D4C9C0f25B4f2F9a';
const AUGUST_2026_TOKYO = new Date('2026-08-15T03:00:00Z').getTime(); // -> monthKey 202608

function signAs(privateKey, { quoteId, triggerRef, coverageCode, payoutAmount, recipient, monthKey, contractAddress, chainId }) {
  const inner = computeInner({
    policyId: quoteId,
    triggerRef,
    coverageCode,
    payoutAmount,
    recipient,
    monthKey,
    contractAddress,
    chainId,
  });
  return signInner(inner, privateKey);
}

function baseBody(overrides = {}) {
  const fields = {
    quoteId: 'KP-2026-001',
    triggerRef: 'TRG-0001',
    coverageCode: '0x01',
    payoutAmount: 3000,
    recipient: RECIPIENT,
    monthKey: '202608',
    contractAddress: PAYOUT_ADDR,
    chainId: CHAIN_ID,
    ...overrides,
  };
  const { payload_hash, signature, signer } = signAs(DEMO_KEY, fields);
  return {
    quote_id: fields.quoteId,
    coverage_code: fields.coverageCode,
    recipient: fields.recipient,
    payout_amount: fields.payoutAmount,
    trigger_ref: fields.triggerRef,
    incident_timestamp: AUGUST_2026_TOKYO,
    contract_address: fields.contractAddress,
    chain_id: fields.chainId,
    attester: { nonce: 'PSN-0001', signer, signature, payload_hash },
  };
}

test('preTransferHash: happy path persists an attestation compatible with /v1/jpyc/transfer', async () => {
  const { app } = setupApp();
  const res = await request(app)
    .post('/v1/jpyc/preTransferHash')
    .set('x-api-key', API_KEY)
    .send(baseBody());

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'signed');
  assert.equal(res.body.source, 'protosure-direct');
  assert.equal(res.body.triggerCode, 'PT-01');
  assert.equal(res.body.payoutAmount, 3000);
  assert.equal(res.body.amountWei, 3000);
  assert.equal(res.body.quoteId, 'KP-2026-001');
  assert.equal(res.body.nonce, 'PSN-0001');
  assert.equal(res.body.attester.toLowerCase(), GOLDEN_SIGNER);
  assert.equal(res.body.oracleSig, null);
  assert.ok(res.body.evidenceHash.startsWith('0x'));
  assert.ok(res.body.id);

  const att = await request(app).get(`/v1/attestation/${res.body.id}`).set('x-api-key', API_KEY);
  assert.equal(att.status, 200);
  assert.equal(att.body.status, 'signed');
});

test('preTransferHash: the resulting attestation executes correctly through the existing /v1/jpyc/transfer', async () => {
  _resetDemoTxThrottle();
  const chain = makeFakeChain();
  const { app } = setupApp({ payments: { chain } });

  const pre = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(baseBody());
  assert.equal(pre.status, 201);

  const transfer = await request(app)
    .post('/v1/jpyc/transfer')
    .set('x-api-key', API_KEY)
    .send({ attestationId: pre.body.id });
  assert.equal(transfer.status, 200);
  assert.equal(transfer.body.status, 'paid');
  assert.equal(transfer.body.signer.toLowerCase(), GOLDEN_SIGNER);
});

test('preTransferHash: rejects when the signature does not recover to the claimed attester.signer', async () => {
  const { app } = setupApp();
  const fields = {
    quoteId: 'KP-2026-001',
    triggerRef: 'TRG-0001',
    coverageCode: '0x01',
    payoutAmount: 3000,
    recipient: RECIPIENT,
    monthKey: '202608',
    contractAddress: PAYOUT_ADDR,
    chainId: CHAIN_ID,
  };
  // A validly-formed signature from an unrelated key — payload_hash is deterministic from
  // `fields` alone (independent of who signs), so it still matches the server's recomputed
  // digest; only the falsely-claimed `signer` should fail to match what actually recovers.
  const { payload_hash, signature } = signAs('bb'.repeat(32), fields);
  const body = {
    quote_id: fields.quoteId,
    coverage_code: fields.coverageCode,
    recipient: fields.recipient,
    payout_amount: fields.payoutAmount,
    trigger_ref: fields.triggerRef,
    incident_timestamp: AUGUST_2026_TOKYO,
    contract_address: fields.contractAddress,
    chain_id: fields.chainId,
    attester: { nonce: 'PSN-0001', signer: GOLDEN_SIGNER, signature, payload_hash },
  };
  const res = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(body);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'SIGNATURE_SIGNER_MISMATCH');
});

test('preTransferHash: rejects a payload_hash that does not match the recomputed digest', async () => {
  const { app } = setupApp();
  const body = baseBody();
  body.attester.payload_hash = '0x' + '11'.repeat(32);
  const res = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(body);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'PAYLOAD_HASH_MISMATCH');
});

test('preTransferHash: rejects an unknown coverage_code', async () => {
  const { app } = setupApp();
  const body = baseBody({ coverageCode: '0x99' });
  const res = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(body);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'UNKNOWN_COVERAGE_CODE');
});

test('preTransferHash: local fixed-schedule rules still apply — amount mismatch is rejected even though Protosure already attested it', async () => {
  const { app } = setupApp();
  const body = baseBody({ payoutAmount: 3001 });
  const res = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(body);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'AMOUNT_MISMATCH');
});

test('preTransferHash: PT-01 monthly cool-down still applies (3rd in the same month is rejected)', async () => {
  const { app } = setupApp();
  const r1 = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(baseBody({ triggerRef: 'TRG-A' }));
  assert.equal(r1.status, 201);
  const r2 = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(baseBody({ triggerRef: 'TRG-B' }));
  assert.equal(r2.status, 201);
  const r3 = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(baseBody({ triggerRef: 'TRG-C' }));
  assert.equal(r3.status, 422);
  assert.equal(r3.body.error, 'COOLDOWN_EXCEEDED');
});

test('preTransferHash: rejects an attester signer that is not REGISTERED_SIGNER', async () => {
  const { app } = setupApp();
  const OTHER_KEY = 'aa'.repeat(32); // valid 32-byte key, unrelated to REGISTERED_SIGNER
  const fields = {
    quoteId: 'KP-2026-001',
    triggerRef: 'TRG-0001',
    coverageCode: '0x01',
    payoutAmount: 3000,
    recipient: RECIPIENT,
    monthKey: '202608',
    contractAddress: PAYOUT_ADDR,
    chainId: CHAIN_ID,
  };
  const { payload_hash, signature, signer } = signAs(OTHER_KEY, fields);
  const body = {
    quote_id: fields.quoteId,
    coverage_code: fields.coverageCode,
    recipient: fields.recipient,
    payout_amount: fields.payoutAmount,
    trigger_ref: fields.triggerRef,
    incident_timestamp: AUGUST_2026_TOKYO,
    contract_address: fields.contractAddress,
    chain_id: fields.chainId,
    attester: { nonce: 'PSN-0001', signer, signature, payload_hash },
  };
  const res = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(body);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'SIGNER_NOT_REGISTERED');
});

test('preTransferHash: rejects a contract_address that does not match PAYOUT_ADDR', async () => {
  const { app } = setupApp();
  const body = baseBody({ contractAddress: '0x' + '33'.repeat(20) });
  const res = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(body);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'CONTRACT_ADDRESS_MISMATCH');
});

test('preTransferHash: rejects a chain_id that does not match CHAIN_ID', async () => {
  const { app } = setupApp();
  const body = baseBody({ chainId: '1' });
  const res = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(body);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'CHAIN_ID_MISMATCH');
});
