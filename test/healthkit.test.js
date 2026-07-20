import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupApp, API_KEY } from './helpers.js';
import { DEFAULT_PARENT_ID } from '../src/db.js';

test('rejects out-of-bounds metrics', async () => {
  const { app } = setupApp();
  const res = await request(app)
    .post('/v1/healthkit/metrics')
    .set('x-api-key', API_KEY)
    .send({ date: '2026-07-19', dailySteps: -1, sleepHours: 5, heartRateAvg: 70, heartRateResting: 60 });
  assert.equal(res.status, 400);
});

test('rejects sleep hours above 16 and heart rate above 220', async () => {
  const { app } = setupApp();
  const res = await request(app)
    .post('/v1/healthkit/metrics')
    .set('x-api-key', API_KEY)
    .send({ date: '2026-07-19', dailySteps: 5000, sleepHours: 17, heartRateAvg: 70, heartRateResting: 60 });
  assert.equal(res.status, 400);

  const res2 = await request(app)
    .post('/v1/healthkit/metrics')
    .set('x-api-key', API_KEY)
    .send({ date: '2026-07-19', dailySteps: 5000, sleepHours: 7, heartRateAvg: 300, heartRateResting: 60 });
  assert.equal(res2.status, 400);
});

test('upsert is idempotent per parentId+date', async () => {
  const { app, db } = setupApp();
  const base = {
    date: '2026-07-01',
    dailySteps: 5000,
    sleepHours: 7,
    heartRateAvg: 70,
    heartRateResting: 62,
    parentId: DEFAULT_PARENT_ID,
  };
  const r1 = await request(app).post('/v1/healthkit/metrics').set('x-api-key', API_KEY).send(base);
  assert.equal(r1.status, 201);
  const r2 = await request(app)
    .post('/v1/healthkit/metrics')
    .set('x-api-key', API_KEY)
    .send({ ...base, dailySteps: 6000 });
  assert.equal(r2.status, 201);

  const row = db.prepare('SELECT * FROM metrics WHERE parentId = ? AND date = ?').get(DEFAULT_PARENT_ID, '2026-07-01');
  assert.equal(row.dailySteps, 6000);
});

test('missing day for a parent -> /v1/frs/today reports dataSufficient false', async () => {
  const { app } = setupApp();
  const res = await request(app).get('/v1/frs/today?parentId=brand-new-parent').set('x-api-key', API_KEY);
  assert.equal(res.status, 200);
  assert.equal(res.body.dataSufficient, false);
  assert.equal(res.body.statusText, 'Please wear your watch');
});

test('every route requires x-api-key except /health', async () => {
  const { app } = setupApp();
  const res = await request(app).get('/v1/frs/today');
  assert.equal(res.status, 401);
  const health = await request(app).get('/health');
  assert.equal(health.status, 200);
});
