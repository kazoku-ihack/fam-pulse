import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupApp, API_KEY } from './helpers.js';

test('POST /v1/sos creates a high-severity incident, bypassing triage entirely', async () => {
  const { app, db } = setupApp();
  const res = await request(app).post('/v1/sos').set('x-api-key', API_KEY).send({});
  assert.equal(res.status, 201);
  assert.equal(res.body.type, 'SOS');
  assert.equal(res.body.severity, 'high');
  assert.equal(res.body.triage, null);

  const events = db.prepare('SELECT * FROM events').all();
  assert.ok(events.some((e) => e.type === 'sos'));
});

test('SOS has no dedupe: repeated calls create separate incidents', async () => {
  const { app } = setupApp();
  await request(app).post('/v1/sos').set('x-api-key', API_KEY).send({});
  await request(app).post('/v1/sos').set('x-api-key', API_KEY).send({});
  const res = await request(app).get('/v1/incidents').set('x-api-key', API_KEY);
  assert.equal(res.body.filter((i) => i.type === 'SOS').length, 2);
});

test('PATCH pickupConfirmed returns 409 unless a dispatch is en_route', async () => {
  const { app } = setupApp();
  const sos = await request(app).post('/v1/sos').set('x-api-key', API_KEY).send({});
  const res = await request(app)
    .patch(`/v1/incident/${sos.body.id}`)
    .set('x-api-key', API_KEY)
    .send({ pickupConfirmed: true });
  assert.equal(res.status, 409);
});

test('GET /v1/incidents?active= filters correctly', async () => {
  const { app } = setupApp();
  await request(app).post('/v1/sos').set('x-api-key', API_KEY).send({});
  const activeRes = await request(app).get('/v1/incidents?active=1').set('x-api-key', API_KEY);
  assert.ok(activeRes.body.length >= 1);
  assert.ok(activeRes.body.every((i) => i.active === true));

  const inactiveRes = await request(app).get('/v1/incidents?active=0').set('x-api-key', API_KEY);
  assert.ok(inactiveRes.body.every((i) => i.active === false));
});
