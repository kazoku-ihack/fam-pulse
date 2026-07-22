import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupApp, API_KEY } from './helpers.js';
import { createGeofenceTracker } from '../src/geofence.js';

test('PATCH /v1/policy/monitoringConfig bumps configVersion and sets updatedAt/updatedBy', async () => {
  const { app } = setupApp();
  const before = await request(app).get('/v1/policy/monitoringConfig').set('x-api-key', API_KEY);
  assert.equal(before.body.configVersion, 1);

  const patch = await request(app)
    .patch('/v1/policy/monitoringConfig')
    .set('x-api-key', API_KEY)
    .send({ homeLatLng: { lat: 35.66, lng: 139.7 }, geofenceRadius: 800, monitoringActive: true });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.configVersion, 2);
  assert.equal(patch.body.updatedBy, 'sakura');
  assert.ok(patch.body.updatedAt >= before.body.updatedAt);

  const after = await request(app).get('/v1/policy/monitoringConfig').set('x-api-key', API_KEY);
  assert.equal(after.body.configVersion, 2);
  assert.equal(after.body.geofenceRadius, 800);
});

test('telemetry frame carries configVersion, including the sharingEnabled:false short frame', async () => {
  const { app } = setupApp();
  const t1 = await request(app).get('/v1/telemetry').set('x-api-key', API_KEY);
  assert.equal(t1.body.configVersion, 1);

  await request(app).patch('/v1/consent').set('x-api-key', API_KEY).send({ sharingEnabled: false });
  const t2 = await request(app).get('/v1/telemetry').set('x-api-key', API_KEY);
  assert.deepEqual(t2.body, { sharingEnabled: false, configVersion: 1 });
});

test('a geofence_updated event is appended on every PATCH', async () => {
  const { app } = setupApp();
  await request(app)
    .patch('/v1/policy/monitoringConfig')
    .set('x-api-key', API_KEY)
    .send({ homeLatLng: { lat: 35.66, lng: 139.7 }, geofenceRadius: 900, monitoringActive: true });
  const events = await request(app).get('/v1/events').set('x-api-key', API_KEY);
  assert.ok(events.body.some((e) => e.type === 'geofence_updated'));
});

test('geofence tracker: shrinking the radius mid-tick can create a WANDERING incident sooner', () => {
  const home = { lat: 35.6595, lng: 139.7005 };
  const point600m = { lat: home.lat + 0.0054, lng: home.lng }; // ~600m from home
  const tracker = createGeofenceTracker();
  const threshold = 1000; // ms, arbitrary small threshold for this unit test

  // At radius 1000m, 600m away is inside -> no dwell starts.
  const r1 = tracker.ingest({ ...point600m, accuracyM: 10, ts: 0 }, home, 1000, threshold);
  assert.equal(r1.event, 'inside');

  // Radius shrinks to 500m -> the SAME position is now outside -> dwell starts this tick.
  const r2 = tracker.ingest({ ...point600m, accuracyM: 10, ts: 100 }, home, 500, threshold);
  assert.equal(r2.event, 'outside_pending');

  const r3 = tracker.ingest({ ...point600m, accuracyM: 10, ts: 100 + threshold + 1 }, home, 500, threshold);
  assert.equal(r3.event, 'wandering');
});

test('geofence tracker: enlarging the radius mid-dwell resolves it (resolvedByEnlargement)', () => {
  const home = { lat: 35.6595, lng: 139.7005 };
  const point600m = { lat: home.lat + 0.0054, lng: home.lng }; // ~600m from home
  const tracker = createGeofenceTracker();
  const threshold = 1000;

  // Outside at radius 500m -> dwell starts.
  const r1 = tracker.ingest({ ...point600m, accuracyM: 10, ts: 0 }, home, 500, threshold);
  assert.equal(r1.event, 'outside_pending');

  // Radius enlarges to 1000m -> the SAME position (still 600m away, hasn't moved) is now
  // inside -> resolved by enlargement, not a genuine walk-home.
  const r2 = tracker.ingest({ ...point600m, accuracyM: 10, ts: 200 }, home, 1000, threshold);
  assert.equal(r2.event, 'inside');
  assert.equal(r2.resolvedByEnlargement, true);
});

test('geofence tracker: walking back inside the SAME radius is not flagged as enlargement', () => {
  const home = { lat: 35.6595, lng: 139.7005 };
  const outside = { lat: home.lat + 0.0054, lng: home.lng };
  const tracker = createGeofenceTracker();
  const threshold = 1000;

  tracker.ingest({ ...outside, accuracyM: 10, ts: 0 }, home, 500, threshold);
  const r2 = tracker.ingest({ ...home, accuracyM: 10, ts: 100 }, home, 500, threshold);
  assert.equal(r2.event, 'inside');
  assert.equal(r2.resolvedByEnlargement, false);
});
