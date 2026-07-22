import { Router } from 'express';
import { getSettings, getParentId } from '../db.js';
import { currentPosition } from '../sims/gps.js';

export function telemetryRouter(db) {
  const router = Router();

  router.get('/v1/telemetry', (req, res) => {
    const parentId = getParentId(req);
    const settings = getSettings(db, parentId);

    if (!settings.sharingEnabled) {
      return res.json({ sharingEnabled: false, configVersion: settings.configVersion });
    }

    const date = new Date().toISOString().slice(0, 10);
    const metricsRow = db
      .prepare('SELECT dailySteps, sleepHours, heartRateAvg FROM metrics WHERE parentId = ? AND date = ?')
      .get(parentId, date);
    const pos = currentPosition(parentId, settings.homeLatLng);

    res.json({
      lastLocation: { lat: pos.lat, lng: pos.lng },
      accuracyM: pos.accuracyM,
      dailySteps: metricsRow?.dailySteps ?? null,
      sleepHours: metricsRow?.sleepHours ?? null,
      lastHeartRate: metricsRow?.heartRateAvg ?? null,
      sharingEnabled: true,
      // The Parent app watches this and re-fetches /v1/policy/monitoringConfig on change.
      configVersion: settings.configVersion,
      ts: Date.now(),
    });
  });

  return router;
}
