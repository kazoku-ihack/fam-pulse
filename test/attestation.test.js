import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupApp, API_KEY } from './helpers.js';
import { makeFakeChain } from './fakeChain.js';
import { _resetDemoTxThrottle } from '../src/routes/payments.js';

const RECIPIENT = '0x' + '11'.repeat(20);

test('attestation/trigger signs a fixed-schedule amount, ignoring any client-supplied amount', async () => {
  const chain = makeFakeChain();
  const { app } = setupApp({ attestation: { chain } });
  const res = await request(app)
    .post('/v1/attestation/trigger')
    .set('x-api-key', API_KEY)
    .send({ policyId: 'KP-2026-001', triggerCode: 'PT-02', recipient: RECIPIENT, payoutAmount: 999999 });
  assert.equal(res.status, 201);
  assert.equal(res.body.payoutAmount, 30000); // PT-02 fixed schedule, client's 999999 ignored
  assert.equal(res.body.status, 'signed');
  assert.equal(res.body.source, 'stub');
  assert.equal(res.body.coverageCode, '0x02');
  assert.match(res.body.monthKey, /^\d{6}$/);
  assert.equal(res.body.signer.toLowerCase(), process.env.REGISTERED_SIGNER);
});

test('PT-06 (settlement) has no fixed schedule — payoutAmount must be supplied and is used as-is', async () => {
  const chain = makeFakeChain();
  const { app } = setupApp({ attestation: { chain } });
  const missing = await request(app)
    .post('/v1/attestation/trigger')
    .set('x-api-key', API_KEY)
    .send({ policyId: 'KP-2026-001', triggerCode: 'PT-06', recipient: RECIPIENT });
  assert.equal(missing.status, 400);

  const withAmount = await request(app)
    .post('/v1/attestation/trigger')
    .set('x-api-key', API_KEY)
    .send({ policyId: 'KP-2026-001', triggerCode: 'PT-06', recipient: RECIPIENT, payoutAmount: 12345 });
  assert.equal(withAmount.status, 201);
  assert.equal(withAmount.body.payoutAmount, 12345);
});

test('attestation/trigger 503s when STUB_SIGNER_PRIVATE_KEY is unset (stub mode)', async () => {
  const prev = process.env.STUB_SIGNER_PRIVATE_KEY;
  delete process.env.STUB_SIGNER_PRIVATE_KEY;
  try {
    const chain = makeFakeChain();
    const { app } = setupApp({ attestation: { chain } });
    const res = await request(app)
      .post('/v1/attestation/trigger')
      .set('x-api-key', API_KEY)
      .send({ policyId: 'KP-2026-001', triggerCode: 'PT-02', recipient: RECIPIENT });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'SIGNER_NOT_CONFIGURED');
  } finally {
    process.env.STUB_SIGNER_PRIVATE_KEY = prev;
  }
});

test('PT-01 monthly cool-down: 3rd trigger in the same month is rejected', async () => {
  const chain = makeFakeChain();
  const { app } = setupApp({ attestation: { chain } });
  const r1 = await request(app).post('/v1/attestation/trigger').set('x-api-key', API_KEY).send({ policyId: 'KP-2026-001', triggerCode: 'PT-01', recipient: RECIPIENT });
  assert.equal(r1.status, 201);
  const r2 = await request(app).post('/v1/attestation/trigger').set('x-api-key', API_KEY).send({ policyId: 'KP-2026-002', triggerCode: 'PT-01', recipient: RECIPIENT });
  assert.equal(r2.status, 201);
  const r3 = await request(app).post('/v1/attestation/trigger').set('x-api-key', API_KEY).send({ policyId: 'KP-2026-003', triggerCode: 'PT-01', recipient: RECIPIENT });
  assert.equal(r3.status, 422);
  assert.equal(r3.body.error, 'COOLDOWN_EXCEEDED');
});

test('POST /v1/jpyc/transfer without attestationId -> 403 ATTESTATION_REQUIRED', async () => {
  _resetDemoTxThrottle();
  const chain = makeFakeChain();
  const { app } = setupApp({ payments: { chain } });
  const res = await request(app).post('/v1/jpyc/transfer').set('x-api-key', API_KEY).send({});
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'ATTESTATION_REQUIRED');
});

test('POST /v1/jpyc/transfer with an unknown attestationId -> 403 ATTESTATION_REQUIRED', async () => {
  _resetDemoTxThrottle();
  const chain = makeFakeChain();
  const { app } = setupApp({ payments: { chain } });
  const res = await request(app).post('/v1/jpyc/transfer').set('x-api-key', API_KEY).send({ attestationId: 'does-not-exist' });
  assert.equal(res.status, 403);
});

test('reused triggerRef on-chain -> 409 NONCE_ALREADY_USED, and releases the cap ledger reservation', async () => {
  _resetDemoTxThrottle();
  const chain = makeFakeChain();
  const { app, db } = setupApp({ attestation: { chain }, payments: { chain } });

  // Same triggerRef (incidentId) on two different attestations reproduces an on-chain replay —
  // the fake chain's usedTriggerRefs tracks this exactly like the real contract's usedNonce.
  const t1 = await request(app).post('/v1/attestation/trigger').set('x-api-key', API_KEY).send({ policyId: 'KP-2026-001', triggerCode: 'PT-02', recipient: RECIPIENT, incidentId: 'incident-dup' });
  const t2 = await request(app).post('/v1/attestation/trigger').set('x-api-key', API_KEY).send({ policyId: 'KP-2026-002', triggerCode: 'PT-04', recipient: RECIPIENT, incidentId: 'incident-dup' });

  const r1 = await request(app).post('/v1/jpyc/transfer').set('x-api-key', API_KEY).send({ attestationId: t1.body.id });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.status, 'paid');
  assert.equal(r1.body.signer.toLowerCase(), process.env.REGISTERED_SIGNER);
  assert.equal(r1.body.source, 'stub');
  assert.ok(r1.body.payloadHash.startsWith('0x'));

  const r2 = await request(app).post('/v1/jpyc/transfer').set('x-api-key', API_KEY).send({ attestationId: t2.body.id });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.error, 'NONCE_ALREADY_USED');

  const ledgerRow = db.prepare('SELECT status FROM cap_ledger WHERE attestationId = ?').get(t2.body.id);
  assert.equal(ledgerRow.status, 'released');
});

test('successful transfer returns txHash and a Snowtrace explorerUrl', async () => {
  _resetDemoTxThrottle();
  const chain = makeFakeChain();
  const { app } = setupApp({ attestation: { chain }, payments: { chain } });
  const t1 = await request(app).post('/v1/attestation/trigger').set('x-api-key', API_KEY).send({ policyId: 'KP-2026-001', triggerCode: 'PT-04', recipient: RECIPIENT });
  const res = await request(app).post('/v1/jpyc/transfer').set('x-api-key', API_KEY).send({ attestationId: t1.body.id });
  assert.equal(res.status, 200);
  assert.match(res.body.txHash, /^0x/);
  assert.ok(res.body.explorerUrl.startsWith('https://testnet.snowtrace.io/tx/'));
});

test('GET /v1/attestation/signer/current returns REGISTERED_SIGNER and a live on-chain check', async () => {
  const chain = makeFakeChain();
  const { app } = setupApp({ attestation: { chain } });
  const res = await request(app).get('/v1/attestation/signer/current').set('x-api-key', API_KEY);
  assert.equal(res.status, 200);
  assert.equal(res.body.registeredSigner, process.env.REGISTERED_SIGNER);
  assert.equal(res.body.isRegisteredOnChain, true);
});
