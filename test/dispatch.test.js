import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { setupApp, API_KEY } from './helpers.js';
import { makeFakeChain } from './fakeChain.js';

async function makeIncident(app) {
  const res = await request(app).post('/v1/sos').set('x-api-key', API_KEY).send({});
  return res.body.id;
}

async function advanceDispatch(app, dispatchId, incidentId, status) {
  const payload = { dispatchId, incidentId, status, driverLocation: { lat: 0, lng: 0 }, etaMin: 1, ts: Date.now() };
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', API_KEY).update(body).digest('hex');
  const res = await request(app)
    .post('/v1/webhooks/uber')
    .set('Content-Type', 'application/json')
    .set('x-uber-signature', signature)
    .send(body);
  assert.equal(res.status, 200);
}

async function makeCompletedDispatch(app) {
  const incidentId = await makeIncident(app);
  const dispatchRes = await request(app).post('/v1/uber/dispatch').set('x-api-key', API_KEY).send({ incidentId });
  const dispatchId = dispatchRes.body.id;
  for (const status of ['accepted', 'en_route', 'arrived', 'completed']) {
    await advanceDispatch(app, dispatchId, incidentId, status);
  }
  return dispatchId;
}

test('idempotent dispatch: same Idempotency-Key returns the existing dispatch', async () => {
  const { app } = setupApp();
  const incidentId = await makeIncident(app);
  const r1 = await request(app)
    .post('/v1/uber/dispatch')
    .set('x-api-key', API_KEY)
    .set('Idempotency-Key', 'k1')
    .send({ incidentId });
  assert.equal(r1.status, 201);

  const r2 = await request(app)
    .post('/v1/uber/dispatch')
    .set('x-api-key', API_KEY)
    .set('Idempotency-Key', 'k1')
    .send({ incidentId });
  assert.equal(r2.status, 200);
});

test('duplicate active dispatch without a matching idempotency key -> 409', async () => {
  const { app } = setupApp();
  const incidentId = await makeIncident(app);
  const r1 = await request(app).post('/v1/uber/dispatch').set('x-api-key', API_KEY).send({ incidentId });
  assert.equal(r1.status, 201);
  const r2 = await request(app).post('/v1/uber/dispatch').set('x-api-key', API_KEY).send({ incidentId });
  assert.equal(r2.status, 409);
});

test('webhook with a bad signature is rejected', async () => {
  const { app } = setupApp();
  const res = await request(app)
    .post('/v1/webhooks/uber')
    .set('x-uber-signature', 'not-a-real-signature')
    .send({ dispatchId: 'x', status: 'accepted' });
  assert.equal(res.status, 401);
});

test('webhook state machine cannot skip states', async () => {
  const { app } = setupApp();
  const incidentId = await makeIncident(app);
  const dispatch = await request(app).post('/v1/uber/dispatch').set('x-api-key', API_KEY).send({ incidentId });
  assert.equal(dispatch.body.status, 'requested');

  const payload = {
    dispatchId: dispatch.body.id,
    incidentId,
    status: 'arrived', // skips accepted + en_route
    driverLocation: { lat: 0, lng: 0 },
    etaMin: 1,
    ts: Date.now(),
  };
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', API_KEY).update(body).digest('hex');

  const res = await request(app)
    .post('/v1/webhooks/uber')
    .set('Content-Type', 'application/json')
    .set('x-uber-signature', signature)
    .send(body);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'INVALID_STATE_TRANSITION');
});

test('webhook accepts the next valid transition in order', async () => {
  const { app } = setupApp();
  const incidentId = await makeIncident(app);
  const dispatch = await request(app).post('/v1/uber/dispatch').set('x-api-key', API_KEY).send({ incidentId });

  const payload = {
    dispatchId: dispatch.body.id,
    incidentId,
    status: 'accepted',
    driverLocation: { lat: 0, lng: 0 },
    etaMin: 6,
    ts: Date.now(),
  };
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', API_KEY).update(body).digest('hex');

  const res = await request(app)
    .post('/v1/webhooks/uber')
    .set('Content-Type', 'application/json')
    .set('x-uber-signature', signature)
    .send(body);
  assert.equal(res.status, 200);

  const poll = await request(app).get(`/v1/uber/dispatch/${dispatch.body.id}`).set('x-api-key', API_KEY);
  assert.equal(poll.body.status, 'accepted');
});

test('pay driver: happy path pays the fixed fare and fires the PT-07 reward', async () => {
  const chain = makeFakeChain();
  const { app } = setupApp({ dispatch: { chain } });
  const dispatchId = await makeCompletedDispatch(app);

  const res = await request(app).post(`/v1/uber/dispatch/${dispatchId}/pay`).set('x-api-key', API_KEY).send({});
  assert.equal(res.status, 201);
  assert.equal(res.body.driverPayment.amount, 2000);
  assert.ok(res.body.driverPayment.txHash);
  assert.equal(res.body.reward.ok, true);
  assert.ok(res.body.reward.txHash);
  assert.equal(res.body.bonus, null);
});

test('pay driver: an explicit sakuraPrivateKey in the request overrides an unconfigured server key', async () => {
  const chain = makeFakeChain({
    isSakuraWalletConfigured: (key) => Boolean(key),
    getSakuraWallet: (key) => ({ address: key ? '0xExplicitSakuraWallet00000000000001' : null }),
  });
  const { app } = setupApp({ dispatch: { chain } });
  const dispatchId = await makeCompletedDispatch(app);

  const withoutKey = await request(app).post(`/v1/uber/dispatch/${dispatchId}/pay`).set('x-api-key', API_KEY).send({});
  assert.equal(withoutKey.status, 503);
  assert.equal(withoutKey.body.error, 'SAKURA_WALLET_NOT_CONFIGURED');

  const withKey = await request(app)
    .post(`/v1/uber/dispatch/${dispatchId}/pay`)
    .set('x-api-key', API_KEY)
    .send({ sakuraPrivateKey: '0xsome-key' });
  assert.equal(withKey.status, 201);
});

test('pay driver: empty sakuraPrivateKey fails validation', async () => {
  const chain = makeFakeChain();
  const { app } = setupApp({ dispatch: { chain } });
  const dispatchId = await makeCompletedDispatch(app);

  const res = await request(app)
    .post(`/v1/uber/dispatch/${dispatchId}/pay`)
    .set('x-api-key', API_KEY)
    .send({ sakuraPrivateKey: '' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'VALIDATION_ERROR');
});

test('pay driver: 409 when dispatch is not completed', async () => {
  const chain = makeFakeChain();
  const { app } = setupApp({ dispatch: { chain } });
  const incidentId = await makeIncident(app);
  const dispatchRes = await request(app).post('/v1/uber/dispatch').set('x-api-key', API_KEY).send({ incidentId });

  const res = await request(app).post(`/v1/uber/dispatch/${dispatchRes.body.id}/pay`).set('x-api-key', API_KEY).send({});
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'DISPATCH_NOT_COMPLETED');
});

test('pay driver: idempotent — paying twice does not re-fire the reward', async () => {
  const chain = makeFakeChain();
  const { app } = setupApp({ dispatch: { chain } });
  const dispatchId = await makeCompletedDispatch(app);

  const r1 = await request(app).post(`/v1/uber/dispatch/${dispatchId}/pay`).set('x-api-key', API_KEY).send({});
  assert.equal(r1.status, 201);

  const r2 = await request(app).post(`/v1/uber/dispatch/${dispatchId}/pay`).set('x-api-key', API_KEY).send({});
  assert.equal(r2.status, 200);
  assert.equal(r2.body.alreadyPaid, true);
  assert.equal(r2.body.driverPayment.txHash, r1.body.driverPayment.txHash);
});

test('pay driver: 503 when Sakura wallet is not configured', async () => {
  const chain = makeFakeChain({ isSakuraWalletConfigured: () => false });
  const { app } = setupApp({ dispatch: { chain } });
  const dispatchId = await makeCompletedDispatch(app);

  const res = await request(app).post(`/v1/uber/dispatch/${dispatchId}/pay`).set('x-api-key', API_KEY).send({});
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'SAKURA_WALLET_NOT_CONFIGURED');
});

test('pay driver: PT-08 bonus fires once on the 3rd rescue payment in a month, not again on the 4th', async () => {
  const chain = makeFakeChain();
  const { app } = setupApp({ dispatch: { chain } });

  const bonuses = [];
  for (let i = 0; i < 4; i++) {
    const dispatchId = await makeCompletedDispatch(app);
    const res = await request(app).post(`/v1/uber/dispatch/${dispatchId}/pay`).set('x-api-key', API_KEY).send({});
    assert.equal(res.status, 201);
    bonuses.push(res.body.bonus);
  }

  assert.equal(bonuses[0], null);
  assert.equal(bonuses[1], null);
  assert.equal(bonuses[2].ok, true);
  assert.equal(bonuses[3], null);
});
