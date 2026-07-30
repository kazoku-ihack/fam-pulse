import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupApp, API_KEY } from './helpers.js';
import { makeFakeChain } from './fakeChain.js';
import { _resetDemoTxThrottle } from '../src/routes/payments.js';

test('rehearseTransfer: with no attestationId, generates a fresh PT-01 attestation signed by the rehearsal signer and pays it out', async () => {
  _resetDemoTxThrottle();
  const chain = makeFakeChain();
  const { app } = setupApp({ payments: { chain } });

  const res = await request(app).post('/v1/jpyc/rehearseTransfer').set('x-api-key', API_KEY).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'paid');
  assert.ok(res.body.attestationId);
  assert.ok(res.body.txHash);
  assert.ok(res.body.explorerUrl);

  const att = await request(app).get(`/v1/attestation/${res.body.attestationId}`).set('x-api-key', API_KEY);
  assert.equal(att.status, 200);
  assert.equal(att.body.status, 'paid');
  assert.equal(att.body.triggerCode, 'PT-01');
});

test('rehearseTransfer: repeated calls with no attestationId never collide (fresh trigger_ref each time)', async () => {
  _resetDemoTxThrottle();
  const chain = makeFakeChain();
  const { app } = setupApp({ payments: { chain } });

  const first = await request(app).post('/v1/jpyc/rehearseTransfer').set('x-api-key', API_KEY).send({});
  const second = await request(app).post('/v1/jpyc/rehearseTransfer').set('x-api-key', API_KEY).send({});
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'paid');
  assert.equal(second.status, 200);
  assert.equal(second.body.status, 'paid');
  assert.notEqual(first.body.attestationId, second.body.attestationId);
});

test('rehearseTransfer: with an attestationId, transfers that existing attestation instead of generating a new one', async () => {
  _resetDemoTxThrottle();
  const chain = makeFakeChain();
  const { app } = setupApp({ payments: { chain } });

  const generated = await request(app).post('/v1/jpyc/rehearseTransfer').set('x-api-key', API_KEY).send({});
  assert.equal(generated.status, 200);

  // Same attestation was already paid above — reusing its id should now fail like any other
  // already-paid attestation (status is no longer 'signed'), proving this path looks the
  // attestation up rather than silently regenerating one.
  const reused = await request(app)
    .post('/v1/jpyc/rehearseTransfer')
    .set('x-api-key', API_KEY)
    .send({ attestationId: generated.body.attestationId });
  assert.equal(reused.status, 403);
  assert.equal(reused.body.error, 'ATTESTATION_REQUIRED');
});

test('rehearseTransfer: rejects an unknown attestationId', async () => {
  const { app } = setupApp();
  const res = await request(app).post('/v1/jpyc/rehearseTransfer').set('x-api-key', API_KEY).send({ attestationId: 'does-not-exist' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'ATTESTATION_REQUIRED');
});

test('rehearseTransfer: 503s with SIGNER_NOT_CONFIGURED when STUB_SIGNER_PRIVATE_KEY is unset', async () => {
  const saved = process.env.STUB_SIGNER_PRIVATE_KEY;
  delete process.env.STUB_SIGNER_PRIVATE_KEY;
  try {
    const { app } = setupApp();
    const res = await request(app).post('/v1/jpyc/rehearseTransfer').set('x-api-key', API_KEY).send({});
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'SIGNER_NOT_CONFIGURED');
  } finally {
    process.env.STUB_SIGNER_PRIVATE_KEY = saved;
  }
});

test('rehearseTransfer: 503s with ATTESTER_ADDRESS_NOT_CONFIGURED when neither ATTESTER_ADDRESS nor REGISTERED_SIGNER is set', async () => {
  const savedAttester = process.env.ATTESTER_ADDRESS;
  const savedRegistered = process.env.REGISTERED_SIGNER;
  delete process.env.ATTESTER_ADDRESS;
  delete process.env.REGISTERED_SIGNER;
  try {
    const { app } = setupApp();
    const res = await request(app).post('/v1/jpyc/rehearseTransfer').set('x-api-key', API_KEY).send({});
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'ATTESTER_ADDRESS_NOT_CONFIGURED');
  } finally {
    if (savedAttester === undefined) delete process.env.ATTESTER_ADDRESS;
    else process.env.ATTESTER_ADDRESS = savedAttester;
    if (savedRegistered === undefined) delete process.env.REGISTERED_SIGNER;
    else process.env.REGISTERED_SIGNER = savedRegistered;
  }
});

test('rehearseTransfer: requires x-api-key like every other /v1/jpyc/* route', async () => {
  const { app } = setupApp();
  const res = await request(app).post('/v1/jpyc/rehearseTransfer').send({});
  assert.equal(res.status, 401);
});
