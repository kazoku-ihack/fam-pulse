import { Router } from 'express';
import { z } from 'zod';
import { getSettings, saveSettings, getParentId, appendEvent } from '../db.js';

const chipsSchema = z.object({
  careNetwork: z.enum(['auto', 'manual']).optional(),
  careChannel: z.enum(['auto', 'email', 'call']).optional(),
  triageMode: z.enum(['auto', 'manual']).optional(),
  frsReviewMode: z.enum(['auto', 'manual']).optional(),
});

const settingsPatchSchema = z.object({
  parentId: z.string().optional(),
  chips: chipsSchema.optional(),
  knownSafePlaces: z
    .array(z.object({ name: z.string(), lat: z.number(), lng: z.number() }))
    .optional(),
});

const monitoringConfigSchema = z.object({
  parentId: z.string().optional(),
  homeLatLng: z.object({ lat: z.number(), lng: z.number() }),
  geofenceRadius: z.number().min(100).max(2000),
  monitoringActive: z.boolean(),
});

export function settingsRouter(db) {
  const router = Router();

  router.get('/v1/settings', (req, res) => {
    const parentId = getParentId(req);
    res.json(getSettings(db, parentId));
  });

  router.patch('/v1/settings', (req, res) => {
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
    const parentId = parsed.data.parentId || getParentId(req);
    const settings = getSettings(db, parentId);
    if (parsed.data.chips) settings.chips = { ...settings.chips, ...parsed.data.chips };
    if (parsed.data.knownSafePlaces) settings.knownSafePlaces = parsed.data.knownSafePlaces;
    saveSettings(db, parentId, settings);
    res.json(settings);
  });

  router.patch('/v1/policy/monitoringConfig', (req, res) => {
    const parsed = monitoringConfigSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
    const parentId = parsed.data.parentId || getParentId(req);
    const settings = getSettings(db, parentId);
    if (settings.pairingStatus !== 'connected') {
      return res.status(409).json({ error: 'PAIRING_REQUIRED' });
    }
    settings.homeLatLng = parsed.data.homeLatLng;
    settings.geofenceRadius = parsed.data.geofenceRadius;
    settings.monitoringActive = parsed.data.monitoringActive;
    saveSettings(db, parentId, settings);
    appendEvent(db, {
      parentId,
      type: 'settings',
      title: `Geo-fence updated: ${parsed.data.geofenceRadius}m radius`,
      deepLink: '/v1/settings',
      refId: parentId,
    });
    res.json(settings);
  });

  return router;
}
