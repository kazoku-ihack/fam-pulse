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
    .send({ policyId: 'p1', triggerCode: 'PT-02', recipient: RECIPIENT, payoutAmount: 999999 });
  assert.equal(res.status, 201);
  assert.equal(res.body.payoutAmount, 30000); // PT-02 fixed schedule, client's 999999 ignored
  assert.equal(res.body.status, 'signed');
  assert.equal(res.body.source, 'stub');
});

test('attestation/trigger 503s when no signer key is configured', async () => {
  const chain = makeFakeChain({ isSignerConfigured: () => false });
  const { app } = setupApp({ attestation: { chain } });
  const res = await request(app)
    .post('/v1/attestation/trigger')
    .set('x-api-key', API_KEY)
    .send({ policyId: 'p1', triggerCode: 'PT-02', recipient: RECIPIENT });
  assert.equal(res.status, 503);
});

test('PT-01 stub cool-down: 3rd trigger within 30 days is rejected', async () => {
  const chain = makeFakeChain();
  const { app } = setupApp({ attestation: { chain } });
  const r1 = await request(app).post('/v1/attestation/trigger').set('x-api-key', API_KEY).send({ policyId: 'p1', triggerCode: 'PT-01', recipient: RECIPIENT });
  assert.equal(r1.status, 201);
  const r2 = await request(app).post('/v1/attestation/trigger').set('x-api-key', API_KEY).send({ policyId: 'p1', triggerCode: 'PT-01', recipient: RECIPIENT });
  assert.equal(r2.status, 201);
  const r3 = await request(app).post('/v1/attestation/trigger').set('x-api-key', API_KEY).send({ policyId: 'p1', triggerCode: 'PT-01', recipient: RECIPIENT });
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

test('reused nonce on-chain -> 409 NONCE_ALREADY_USED', async () => {
  _resetDemoTxThrottle();
  const chain = makeFakeChain({ randomNonce: () => '0x' + 'aa'.repeat(32) });
  const { app } = setupApp({ attestation: { chain }, payments: { chain } });

  const t1 = await request(app).post('/v1/attestation/trigger').set('x-api-key', API_KEY).send({ policyId: 'p1', triggerCode: 'PT-02', recipient: RECIPIENT });
  const t2 = await request(app).post('/v1/attestation/trigger').set('x-api-key', API_KEY).send({ policyId: 'p2', triggerCode: 'PT-04', recipient: RECIPIENT });

  const r1 = await request(app).post('/v1/jpyc/transfer').set('x-api-key', API_KEY).send({ attestationId: t1.body.id });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.status, 'paid');

  const r2 = await request(app).post('/v1/jpyc/transfer').set('x-api-key', API_KEY).send({ attestationId: t2.body.id });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.error, 'NONCE_ALREADY_USED');
});

test('successful transfer returns txHash and a Snowtrace explorerUrl', async () => {
  _resetDemoTxThrottle();
  const chain = makeFakeChain();
  const { app } = setupApp({ attestation: { chain }, payments: { chain } });
  const t1 = await request(app).post('/v1/attestation/trigger').set('x-api-key', API_KEY).send({ policyId: 'p1', triggerCode: 'PT-04', recipient: RECIPIENT });
  const res = await request(app).post('/v1/jpyc/transfer').set('x-api-key', API_KEY).send({ attestationId: t1.body.id });
  assert.equal(res.status, 200);
  assert.match(res.body.txHash, /^0x/);
  assert.ok(res.body.explorerUrl.startsWith('https://testnet.snowtrace.io/tx/'));
});
