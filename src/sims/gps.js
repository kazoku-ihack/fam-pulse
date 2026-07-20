// Scripted GPS walk for the wandering scenario. Positions evolve over real wall-clock time,
// compressed by DEMO_TIMESCALE — the same knob that compresses the geo-fence dwell threshold
// (see geofence.js), so a whole scenario plays out in seconds during a demo.

import { HOME } from '../db.js';

const walks = new Map(); // parentId -> { startedAt, timescale }

// Waypoints expressed in *demo minutes* (i.e. real-world minutes as the scenario would run
// at timescale=1). offsets are degrees added to home lat/lng.
const WANDER_SCRIPT = [
  { atMinute: 0, offsetLat: 0, offsetLng: 0, accuracyM: 8 }, // at home
  { atMinute: 1, offsetLat: 0.0015, offsetLng: 0.0015, accuracyM: 12 }, // ~230m out
  { atMinute: 2, offsetLat: 0.0035, offsetLng: 0.003, accuracyM: 15 }, // ~470m out, near the fence
  { atMinute: 3, offsetLat: 0.006, offsetLng: 0.0045, accuracyM: 18 }, // ~740m out — outside the 500m radius, holds here
];

function getTimescale() {
  return parseFloat(process.env.DEMO_TIMESCALE) || 1;
}

export function startWanderingWalk(parentId, { timescale = getTimescale(), startedAt = Date.now() } = {}) {
  walks.set(parentId, { startedAt, timescale });
}

export function stopWalk(parentId) {
  walks.delete(parentId);
}

export function isWalking(parentId) {
  return walks.has(parentId);
}

export function currentPosition(parentId, home = HOME, nowTs = Date.now()) {
  const walk = walks.get(parentId);
  if (!walk) {
    return { lat: home.lat, lng: home.lng, accuracyM: 8, ts: nowTs };
  }
  const elapsedMs = nowTs - walk.startedAt;
  const elapsedDemoMinutes = (elapsedMs * walk.timescale) / 60000;
  let point = WANDER_SCRIPT[0];
  for (const step of WANDER_SCRIPT) {
    if (elapsedDemoMinutes >= step.atMinute) point = step;
  }
  return {
    lat: home.lat + point.offsetLat,
    lng: home.lng + point.offsetLng,
    accuracyM: point.accuracyM,
    ts: nowTs,
  };
}

export function returnHome(parentId) {
  stopWalk(parentId);
}
