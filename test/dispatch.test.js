import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { setupApp, API_KEY } from './helpers.js';

async function makeIncident(app) {
  const res = await request(app).post('/v1/sos').set('x-api-key', API_KEY).send({});
  return res.body.id;
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
