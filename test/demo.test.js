import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupApp, API_KEY } from './helpers.js';
import { DEFAULT_PARENT_ID } from '../src/db.js';

const voidReply = async () => ({
  decision: 'void',
  confidence: 0.85,
  category: 'watch_not_worn',
  reasoning: 'Charger-day gap — the watch was not worn overnight, not a genuine decline.',
});

test('false-alarm scenario: Claude voids the charger-day INACTIVITY alarm, no incident raised', async () => {
  const { app, db } = setupApp({ demo: { callJson: voidReply } });
  const res = await request(app).post('/v1/demo/scenario/false-alarm').set('x-api-key', API_KEY).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.review.decision, 'void');

  const incidents = db.prepare(`SELECT * FROM incidents WHERE type = 'INACTIVITY'`).all();
  assert.equal(incidents.length, 0);

  const reviews = db.prepare('SELECT * FROM frs_reviews').all();
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].decision, 'void');

  const events = await request(app).get('/v1/events').set('x-api-key', API_KEY);
  assert.ok(events.body.some((e) => e.type === 'frs_void'));
});

test('POST /v1/demo/reset wipes incidents/events but leaves wallets table untouched', async () => {
  const { app, db } = setupApp();
  await request(app).post('/v1/sos').set('x-api-key', API_KEY).send({});
  db.prepare(`INSERT OR REPLACE INTO wallets (name, address) VALUES ('payoutPool', ?)`).run('0xDeadBeef');

  const res = await request(app).post('/v1/demo/reset').set('x-api-key', API_KEY).send({});
  assert.equal(res.status, 200);

  const incidents = db.prepare('SELECT * FROM incidents').all();
  assert.equal(incidents.length, 0);
  const wallet = db.prepare(`SELECT * FROM wallets WHERE name = 'payoutPool'`).get();
  assert.equal(wallet.address, '0xDeadBeef');
});

test('wandering scenario starts the GPS walk (position moves away from home)', async () => {
  const prevScale = process.env.DEMO_TIMESCALE;
  process.env.DEMO_TIMESCALE = '100000';
  const { app } = setupApp();
  const before = await request(app).get('/v1/telemetry').set('x-api-key', API_KEY);
  const res = await request(app).post('/v1/demo/scenario/wandering').set('x-api-key', API_KEY).send({});
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  const after = await request(app).get('/v1/telemetry').set('x-api-key', API_KEY);
  assert.notEqual(before.body.lastLocation.lat, after.body.lastLocation.lat);
  if (prevScale === undefined) delete process.env.DEMO_TIMESCALE;
  else process.env.DEMO_TIMESCALE = prevScale;
});

test('unknown scenario name -> 404', async () => {
  const { app } = setupApp();
  const res = await request(app).post('/v1/demo/scenario/not-a-real-scenario').set('x-api-key', API_KEY).send({});
  assert.equal(res.status, 404);
});
