import { Router } from 'express';
import { z } from 'zod';
import { getSettings, saveSettings, getParentId, appendEvent } from '../db.js';

const consentSchema = z.object({
  parentId: z.string().optional(),
  sharingEnabled: z.boolean(),
});

export function parentRouter(db) {
  const router = Router();

  router.get('/v1/parent/status', (req, res) => {
    const parentId = getParentId(req);
    const settings = getSettings(db, parentId);
    res.json({
      pairingStatus: settings.pairingStatus,
      sharingEnabled: settings.sharingEnabled,
      geofenceConfigured: Boolean(settings.homeLatLng && settings.geofenceRadius),
      monitoringActive: settings.monitoringActive,
    });
  });

  router.patch('/v1/consent', (req, res) => {
    const parsed = consentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
    const parentId = parsed.data.parentId || getParentId(req);
    const settings = getSettings(db, parentId);
    settings.sharingEnabled = parsed.data.sharingEnabled;
    saveSettings(db, parentId, settings);
    appendEvent(db, {
      parentId,
      type: 'settings',
      title: `Location sharing ${settings.sharingEnabled ? 'enabled' : 'disabled'}`,
      deepLink: '/v1/parent/status',
      refId: parentId,
    });
    res.json({ sharingEnabled: settings.sharingEnabled });
  });

  router.get('/v1/carePlan/next', (req, res) => {
    const parentId = getParentId(req);
    const row = db
      .prepare(
        `SELECT plan_json FROM care_requests WHERE parentId = ? AND status = 'approved' AND plan_json IS NOT NULL ORDER BY slaDueTs DESC LIMIT 1`
      )
      .get(parentId);
    if (!row) return res.json(null);
    const plan = JSON.parse(row.plan_json);
    res.json({ staff: plan.staff, visitAt: plan.visitAt });
  });

  return router;
}
