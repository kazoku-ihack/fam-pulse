// Pure geo-fence math: haversine distance + a dwell tracker driven by ingested position
// samples. No I/O, no timers — callers (routes/incidents.js in real operation, tests directly)
// drive it with samples and a threshold.

const EARTH_RADIUS_M = 6371000;

export function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

export function bearingCardinal(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

const ACCURACY_LIMIT_M = 50;

// One tracker instance per monitored subject. `ingest` is a pure state transition: it does not
// read the clock itself, and it does not cache `home`/`radiusM` at construction time — both are
// passed in on every call, so a config change (PATCH /v1/policy/monitoringConfig) takes effect
// on the very next tick rather than only for trackers created after the change. The caller
// supplies `sample.ts` and the current `dwellThresholdMs`, which makes the dwell boundary fully
// deterministic and testable without real waiting.
export function createGeofenceTracker() {
  let outsideSinceTs = null;
  let lastRadiusM = null;

  return {
    ingest(sample, home, radiusM, dwellThresholdMs) {
      if (sample.accuracyM > ACCURACY_LIMIT_M) {
        return { event: 'excluded' };
      }
      const distanceM = distanceMeters(home.lat, home.lng, sample.lat, sample.lng);
      const outside = distanceM > radiusM;
      const wasOutside = outsideSinceTs !== null;
      const priorRadiusM = lastRadiusM;
      lastRadiusM = radiusM;

      if (!outside) {
        // Distinguish "radius was enlarged mid-dwell" from a genuine walk-home: only the
        // former has the position still outside what the radius *used to be* a moment ago.
        const resolvedByEnlargement = wasOutside && priorRadiusM != null && distanceM > priorRadiusM;
        outsideSinceTs = null;
        return { event: 'inside', distanceM, resolvedByEnlargement };
      }

      if (outsideSinceTs === null) outsideSinceTs = sample.ts;
      const dwellMs = sample.ts - outsideSinceTs;

      if (dwellMs > dwellThresholdMs) {
        return {
          event: 'wandering',
          distanceM,
          dwellMs,
          exitTs: outsideSinceTs,
          direction: bearingCardinal(home.lat, home.lng, sample.lat, sample.lng),
        };
      }
      return { event: 'outside_pending', distanceM, dwellMs };
    },
    reset() {
      outsideSinceTs = null;
      lastRadiusM = null;
    },
  };
}

export function dwellThresholdMs(timescale = parseFloat(process.env.DEMO_TIMESCALE) || 1) {
  return (10 * 60 * 1000) / timescale;
}
