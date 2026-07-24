import { Router } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { appendEvent, getSettings } from '../db.js';
import {
  startDispatchSimulation,
  cancelDispatchSimulation,
  driverInfo,
  routePolyline,
  signPayload,
} from '../sims/uber.js';

export const STATE_ORDER = ['requested', 'accepted', 'en_route', 'arrived', 'completed'];
const TERMINAL_STATES = ['completed', 'cancelled'];
const MAX_RETRIES = 3;

function webhookSecret() {
  return process.env.API_KEY || 'kazoku-demo-webhook-secret';
}

function baseUrl() {
  return process.env.INTERNAL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
}

function parseDispatch(row) {
  return {
    id: row.id,
    incidentId: row.incidentId,
    status: row.status,
    driver: JSON.parse(row.driver_json),
    etaMin: row.etaMin,
    lat: row.lat,
    lng: row.lng,
    retryCount: row.retryCount,
  };
}

const dispatchSchema = z.object({
  incidentId: z.string().min(1),
});

// Core dispatch-creation logic, shared by the HTTP route and by automatic triggers (e.g. an
// unusual wandering triage result — see createDispatchForIncident's caller in routes/incidents.js).
// `incident` only needs { id, parentId, lat, lng }. Returns { status, body } — never throws for
// expected business outcomes (duplicate/retry-limit), so callers can act on `status` uniformly.
export function createDispatchForIncident(db, incident, { idempotencyKey = null } = {}) {
  if (idempotencyKey) {
    const existing = db
      .prepare('SELECT * FROM dispatches WHERE incidentId = ? AND idempotencyKey = ?')
      .get(incident.id, idempotencyKey);
    if (existing) return { status: 200, body: parseDispatch(existing) };
  }

  const activeExisting = db
    .prepare(`SELECT * FROM dispatches WHERE incidentId = ? AND status NOT IN ('completed','cancelled')`)
    .get(incident.id);
  if (activeExisting) {
    return { status: 409, body: { error: 'DUPLICATE_ACTIVE_DISPATCH', dispatch: parseDispatch(activeExisting) } };
  }

  const priorCount = db
    .prepare(`SELECT COUNT(*) AS c FROM dispatches WHERE incidentId = ?`)
    .get(incident.id).c;
  if (priorCount >= MAX_RETRIES) {
    return { status: 429, body: { error: 'RETRY_LIMIT_EXCEEDED' } };
  }

  const settings = getSettings(db, incident.parentId);
  const pickup = { lat: incident.lat, lng: incident.lng };
  const dropoff = settings.homeLatLng;

  const id = randomUUID();
  const driver = driverInfo();
  db.prepare(
    `INSERT INTO dispatches (id, incidentId, status, driver_json, etaMin, lat, lng, retryCount, idempotencyKey, createdTs)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, incident.id, 'requested', JSON.stringify(driver), 8, pickup.lat, pickup.lng, priorCount, idempotencyKey || null, Date.now());

  appendEvent(db, {
    parentId: incident.parentId,
    type: 'wandering',
    title: `Taxi dispatched — ${driver.name}`,
    deepLink: `/v1/uber/dispatch/${id}`,
    refId: id,
  });

  startDispatchSimulation({
    dispatchId: id,
    incidentId: incident.id,
    baseUrl: baseUrl(),
    secret: webhookSecret(),
    pickup,
    dropoff,
  });

  return { status: 201, body: parseDispatch(db.prepare('SELECT * FROM dispatches WHERE id = ?').get(id)) };
}

export function dispatchRouter(db) {
  const router = Router();

  router.post('/v1/uber/dispatch', (req, res) => {
    const parsed = dispatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
    const { incidentId } = parsed.data;
    const idempotencyKey = req.header('idempotency-key') || req.header('Idempotency-Key');

    const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);
    if (!incident) return res.status(404).json({ error: 'INCIDENT_NOT_FOUND' });

    const { status, body } = createDispatchForIncident(db, incident, { idempotencyKey });
    res.status(status).json(body);
  });

  router.get('/v1/uber/dispatch/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(row.incidentId);
    const settings = getSettings(db, incident.parentId);
    const pickup = { lat: incident.lat, lng: incident.lng };
    const dropoff = settings.homeLatLng;
    res.json({
      status: row.status,
      driverName: JSON.parse(row.driver_json).name,
      rating: JSON.parse(row.driver_json).rating,
      vehicle: JSON.parse(row.driver_json).vehicle,
      plate: JSON.parse(row.driver_json).plate,
      etaMin: row.etaMin,
      driverLocation: { lat: row.lat, lng: row.lng },
      routePolyline: routePolyline(pickup, dropoff),
      driverWalletAddr: JSON.parse(row.driver_json).driverWalletAddr,
      retryCount: row.retryCount,
    });
  });

  router.delete('/v1/uber/dispatch/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    cancelDispatchSimulation(row.id);
    db.prepare(`UPDATE dispatches SET status = 'cancelled' WHERE id = ?`).run(row.id);
    res.status(204).end();
  });

  return router;
}

// Public (unauthenticated by x-api-key — mounted before the auth middleware in server.js):
// authenticated instead by HMAC signature, exactly like a real provider webhook would be.
export function uberWebhookRouter(db) {
  const router = Router();

  router.post('/v1/webhooks/uber', (req, res) => {
    const signature = req.header('x-uber-signature');
    const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
    const expected = signPayload(webhookSecret(), raw);
    const sigBuf = Buffer.from(signature || '', 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    const valid = sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
    if (!valid) return res.status(401).json({ error: 'BAD_SIGNATURE' });

    const { dispatchId, status, driverLocation, etaMin } = req.body;
    const row = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(dispatchId);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    if (TERMINAL_STATES.includes(row.status)) {
      return res.status(409).json({ error: 'DISPATCH_ALREADY_TERMINAL' });
    }

    const currentIdx = STATE_ORDER.indexOf(row.status);
    const nextIdx = STATE_ORDER.indexOf(status);
    if (nextIdx === -1 || nextIdx !== currentIdx + 1) {
      return res.status(409).json({ error: 'INVALID_STATE_TRANSITION', from: row.status, to: status });
    }

    db.prepare('UPDATE dispatches SET status = ?, etaMin = ?, lat = ?, lng = ? WHERE id = ?').run(
      status,
      etaMin ?? row.etaMin,
      driverLocation?.lat ?? row.lat,
      driverLocation?.lng ?? row.lng,
      dispatchId
    );

    if (status === 'completed') {
      const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(row.incidentId);
      if (incident) {
        appendEvent(db, {
          parentId: incident.parentId,
          type: 'visit_completed',
          title: 'Taxi ride completed',
          deepLink: `/v1/uber/dispatch/${dispatchId}`,
          refId: dispatchId,
        });
      }
    }

    res.json({ ok: true });
  });

  return router;
}
