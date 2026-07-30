import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { ethers } from 'ethers';
import { computeInner, signInner } from '../src/protosure/stub.js';
import { setupApp, API_KEY } from './helpers.js';
import { makeFakeChain } from './fakeChain.js';
import { _resetDemoTxThrottle } from '../src/routes/payments.js';

// Recovers from process.env.ORACLE_SIGNER_PRIVATE_KEY, forced in test/helpers.js.
const ORACLE_SIGNER_ADDR = '0xA911EBe20Fb0909DCAD75821cbF7A9e57Ebaf9c9';

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

test('preTransferHash: the resulting attestation executes on the Rider contract (not the single-sig payout contract), with a fresh oracleSig plus the stored attesterSig', async () => {
  _resetDemoTxThrottle();
  let riderCall = null;
  const chain = makeFakeChain({
    getRiderContract: () => ({
      submitTrigger: async (policyId, triggerRef, coverageCode, amountJpy, recipient, monthKey, oracleSig, attesterSig) => {
        riderCall = { policyId, triggerRef, coverageCode, amountJpy, recipient, monthKey, oracleSig, attesterSig };
        return { wait: async () => ({ hash: '0x' + 'cd'.repeat(32) }) };
      },
    }),
    getPayoutContract: () => {
      throw new Error('getPayoutContract must not be called for a protosure-direct attestation');
    },
  });
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

  assert.ok(riderCall, 'Rider contract was never called');
  assert.equal(riderCall.attesterSig, pre.body.attesterSig);
  const recoveredOracle = ethers.recoverAddress(pre.body.evidenceHash, riderCall.oracleSig);
  assert.equal(recoveredOracle.toLowerCase(), ORACLE_SIGNER_ADDR.toLowerCase());
});

test('preTransferHash->transfer: 503s with ORACLE_SIGNER_NOT_CONFIGURED when ORACLE_SIGNER_PRIVATE_KEY is unset', async () => {
  _resetDemoTxThrottle();
  const savedKey = process.env.ORACLE_SIGNER_PRIVATE_KEY;
  delete process.env.ORACLE_SIGNER_PRIVATE_KEY;
  try {
    const chain = makeFakeChain();
    const { app } = setupApp({ payments: { chain } });
    const pre = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(baseBody());
    assert.equal(pre.status, 201);

    const transfer = await request(app)
      .post('/v1/jpyc/transfer')
      .set('x-api-key', API_KEY)
      .send({ attestationId: pre.body.id });
    assert.equal(transfer.status, 503);
    assert.equal(transfer.body.error, 'ORACLE_SIGNER_NOT_CONFIGURED');
  } finally {
    process.env.ORACLE_SIGNER_PRIVATE_KEY = savedKey;
  }
});

test('preTransferHash: rejects an unknown coverage_code', async () => {
  const { app } = setupApp();
  const body = baseBody({ coverageCode: '0x99' });
  const res = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(body);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'UNKNOWN_COVERAGE_CODE');
});

test('preTransferHash: does not re-verify the attester signature or re-run local payout rules — Mendix/Protosure values are trusted as-is', async () => {
  const { app } = setupApp();
  // Deliberately-wrong signature, signer, and an amount that would have failed FIXED_SCHEDULE —
  // none of it is re-checked here; that validation now happens once, upstream, against Protosure.
  const body = baseBody({ payoutAmount: 3001 });
  body.attester.signature = '0x' + 'aa'.repeat(65);
  body.attester.signer = '0x' + '99'.repeat(20);
  body.attester.payload_hash = '0x' + '11'.repeat(32);
  const res = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(body);
  assert.equal(res.status, 201);
  assert.equal(res.body.evidenceHash, body.attester.payload_hash);
  assert.equal(res.body.attester.toLowerCase(), body.attester.signer.toLowerCase());
});

test('preTransferHash: rejects a contract_address that does not match PAYOUT_ADDR', async () => {
  const { app } = setupApp();
  const body = baseBody({ contractAddress: '0x' + '33'.repeat(20) });
  const res = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(body);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'CONTRACT_ADDRESS_MISMATCH');
  assert.equal(res.body.expected, PAYOUT_ADDR);
  assert.equal(res.body.received.toLowerCase(), body.contract_address.toLowerCase());
});

test('preTransferHash: rejects a chain_id that does not match CHAIN_ID', async () => {
  const { app } = setupApp();
  const body = baseBody({ chainId: '1' });
  const res = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(body);
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'CHAIN_ID_MISMATCH');
});

test('preTransferHash: accepts incident_timestamp in unix seconds and normalizes monthkey correctly', async () => {
  const { app } = setupApp();
  const body = baseBody();
  body.incident_timestamp = Math.floor(AUGUST_2026_TOKYO / 1000);

  const pre = await request(app).post('/v1/jpyc/preTransferHash').set('x-api-key', API_KEY).send(body);
  assert.equal(pre.status, 201);

  const att = await request(app).get(`/v1/attestation/${pre.body.id}`).set('x-api-key', API_KEY);
  assert.equal(att.status, 200);
  assert.equal(att.body.monthKey, '202608');
});
