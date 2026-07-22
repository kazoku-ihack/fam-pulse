import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeofenceTracker, dwellThresholdMs, distanceMeters } from '../src/geofence.js';

const home = { lat: 35.6595, lng: 139.7005 };
const farAway = { lat: home.lat + 0.01, lng: home.lng }; // ~1.1km — well outside 500m

test('dwell boundary: 9/10/11 minutes (dwell > 10min required to trigger)', () => {
  const threshold = 10 * 60 * 1000;
  const t0 = 1_000_000;
  const cases = [
    [9, false],
    [10, false],
    [11, true],
  ];
  for (const [minutes, expectWander] of cases) {
    const tracker = createGeofenceTracker();
    const first = tracker.ingest({ ...farAway, accuracyM: 10, ts: t0 }, home, 500, threshold);
    assert.equal(first.event, 'outside_pending');
    const second = tracker.ingest({ ...farAway, accuracyM: 10, ts: t0 + minutes * 60 * 1000 }, home, 500, threshold);
    assert.equal(second.event === 'wandering', expectWander, `minutes=${minutes} expected wander=${expectWander}`);
  }
});

test('low-accuracy samples (>50m) are excluded', () => {
  const tracker = createGeofenceTracker();
  const r = tracker.ingest({ ...farAway, accuracyM: 75, ts: 1 }, home, 500, 1000);
  assert.equal(r.event, 'excluded');
});

test('returning inside the radius resets the dwell clock', () => {
  const tracker = createGeofenceTracker();
  tracker.ingest({ ...farAway, accuracyM: 10, ts: 0 }, home, 500, 1000);
  const insideAgain = tracker.ingest({ ...home, accuracyM: 10, ts: 500 }, home, 500, 1000);
  assert.equal(insideAgain.event, 'inside');
  const backOutside = tracker.ingest({ ...farAway, accuracyM: 10, ts: 900 }, home, 500, 1000);
  assert.equal(backOutside.event, 'outside_pending'); // dwell restarted, not yet at threshold
});

test('DEMO_TIMESCALE compresses the 10-minute threshold (e.g. 30x -> 20s)', () => {
  const prev = process.env.DEMO_TIMESCALE;
  process.env.DEMO_TIMESCALE = '30';
  assert.equal(dwellThresholdMs(), 20000);
  if (prev === undefined) delete process.env.DEMO_TIMESCALE;
  else process.env.DEMO_TIMESCALE = prev;
});

test('distanceMeters is roughly correct for a known offset', () => {
  const d = distanceMeters(home.lat, home.lng, farAway.lat, farAway.lng);
  assert.ok(d > 1000 && d < 1200, `expected ~1100m, got ${d}`);
});
