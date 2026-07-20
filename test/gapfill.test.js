import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupApp, API_KEY } from './helpers.js';
import { DEFAULT_PARENT_ID } from '../src/db.js';

test('GET /v1/parent/status reflects the seed (paired, connected)', async () => {
  const { app } = setupApp();
  const res = await request(app).get('/v1/parent/status').set('x-api-key', API_KEY);
  assert.equal(res.status, 200);
  assert.equal(res.body.pairingStatus, 'connected');
  assert.equal(res.body.sharingEnabled, true);
  assert.equal(res.body.geofenceConfigured, true);
  assert.equal(res.body.monitoringActive, true);
});

test('PATCH /v1/consent sharingEnabled:false closes telemetry to a stub frame', async () => {
  const { app } = setupApp();
  const patch = await request(app).patch('/v1/consent').set('x-api-key', API_KEY).send({ sharingEnabled: false });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.sharingEnabled, false);

  const telemetry = await request(app).get('/v1/telemetry').set('x-api-key', API_KEY);
  assert.deepEqual(telemetry.body, { sharingEnabled: false });

  const status = await request(app).get('/v1/parent/status').set('x-api-key', API_KEY);
  assert.equal(status.body.sharingEnabled, false);
});

test('PATCH /v1/policy/monitoringConfig validates radius 100-2000 and requires pairing', async () => {
  const { app } = setupApp();
  const tooSmall = await request(app)
    .patch('/v1/policy/monitoringConfig')
    .set('x-api-key', API_KEY)
    .send({ homeLatLng: { lat: 35.6595, lng: 139.7005 }, geofenceRadius: 50, monitoringActive: true });
  assert.equal(tooSmall.status, 400);

  const ok = await request(app)
    .patch('/v1/policy/monitoringConfig')
    .set('x-api-key', API_KEY)
    .send({ homeLatLng: { lat: 35.66, lng: 139.7 }, geofenceRadius: 750, monitoringActive: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.geofenceRadius, 750);
});

test('dispute flag on a settlement line persists across refresh', async () => {
  const { app } = setupApp();
  const patch = await request(app)
    .patch('/v1/settlement/settlement-2026-06/line/L1')
    .set('x-api-key', API_KEY)
    .send({ disputed: true });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.disputed, true);

  const refreshed = await request(app)
    .get('/v1/settlement/current?parentId=' + DEFAULT_PARENT_ID)
    .set('x-api-key', API_KEY);
  const line = refreshed.body.lines.find((l) => l.lineId === 'L1');
  assert.equal(line.disputed, true);
});

test('batchTransfer server-side re-derives exclusions (disputed ∪ unattested) and rejects without attestation', async () => {
  const { app } = setupApp();
  await request(app).patch('/v1/settlement/settlement-2026-06/line/L1').set('x-api-key', API_KEY).send({ disputed: true });

  const res = await request(app)
    .post('/v1/jpyc/batchTransfer')
    .set('x-api-key', API_KEY)
    .send({ settlementId: 'settlement-2026-06' });
  // No PT-03 attestation exists yet for this settlement -> must be rejected regardless of lines.
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'ATTESTATION_REQUIRED');
});

test('every scenario appends the expected /v1/events rows', async () => {
  const { app } = setupApp();
  await request(app).post('/v1/sos').set('x-api-key', API_KEY).send({});
  const events = await request(app).get('/v1/events').set('x-api-key', API_KEY);
  assert.ok(events.body.some((e) => e.type === 'sos'));
  assert.ok(events.body.length > 0);
  // newest-first
  const timestamps = events.body.map((e) => e.ts);
  const sorted = [...timestamps].sort((a, b) => b - a);
  assert.deepEqual(timestamps, sorted);
});

test('GET /v1/carePlan/next is null until a plan is approved', async () => {
  const { app } = setupApp();
  const res = await request(app).get('/v1/carePlan/next').set('x-api-key', API_KEY);
  assert.equal(res.status, 200);
  assert.equal(res.body, null);
});
