import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appendEvent, getSettings, getParentId, DEFAULT_PARENT_ID, SECOND_PARENT_ID } from '../db.js';
import { createGeofenceTracker, distanceMeters, dwellThresholdMs } from '../geofence.js';
import { currentPosition } from '../sims/gps.js';
import { triageWandering } from '../claude/wandering-triage.js';
import { computeFRS } from '../frs.js';
import { checkFrsAlarms } from '../alarms.js';
import { createDispatchForIncident } from './dispatch.js';
import { takeAnthropicKey } from '../claude/pendingKey.js';
import { requireRole } from '../auth.js';

const trackers = new Map(); // parentId -> geofence tracker
const TICK_MS = 2000;
let tickHandle = null;

function getTracker(parentId) {
  let t = trackers.get(parentId);
  if (!t) {
    t = createGeofenceTracker();
    trackers.set(parentId, t);
  }
  return t;
}

function parseIncident(row) {
  return {
    id: row.id,
    parentId: row.parentId,
    type: row.type,
    severity: row.severity,
    ts: row.ts,
    active: Boolean(row.active),
    lat: row.lat,
    lng: row.lng,
    exitTs: row.exitTs,
    dwellMin: row.dwellMin,
    escalationDueTs: row.escalationDueTs,
    pickupConfirmed: Boolean(row.pickupConfirmed),
    dropoffConfirmed: Boolean(row.dropoffConfirmed),
    timeline: row.timeline_json ? JSON.parse(row.timeline_json) : [],
    pt01Eligible: Boolean(row.pt01Eligible),
    triage: row.triage_json ? JSON.parse(row.triage_json) : null,
  };
}

function addTimeline(db, id, entry) {
  const row = db.prepare('SELECT timeline_json FROM incidents WHERE id = ?').get(id);
  const timeline = row?.timeline_json ? JSON.parse(row.timeline_json) : [];
  timeline.push({ ts: Date.now(), ...entry });
  db.prepare('UPDATE incidents SET timeline_json = ? WHERE id = ?').run(JSON.stringify(timeline), id);
}

function frsContextFor(db, parentId) {
  const date = new Date().toISOString().slice(0, 10);
  const todayRow = db
    .prepare('SELECT dailySteps, sleepHours, heartRateResting FROM metrics WHERE parentId = ? AND date = ?')
    .get(parentId, date);
  const historySteps = db
    .prepare('SELECT dailySteps FROM metrics WHERE parentId = ? AND date < ? ORDER BY date DESC LIMIT 7')
    .all(parentId, date)
    .map((r) => r.dailySteps);
  return computeFRS({ today: todayRow ?? null, historySteps });
}

function recentOutcomes(db, parentId, limit = 5) {
  return db
    .prepare(
      `SELECT type, severity, active FROM incidents WHERE parentId = ? ORDER BY ts DESC LIMIT ?`
    )
    .all(parentId, limit)
    .map((r) => `${r.type.toLowerCase()}: ${r.active ? 'active' : 'resolved'}`);
}

async function createWanderingIncident(db, parentId, settings, geofenceEvent) {
  const id = randomUUID();
  const ts = Date.now();
  const pos = currentPosition(parentId, settings.homeLatLng);
  const frs = frsContextFor(db, parentId);
  const localHour = new Date().getHours();
  const dwellMin = Math.round(geofenceEvent.dwellMs / 60000);

  const knownSafePlaces = settings.knownSafePlaces || [];
  const movingTowardSafePlace = knownSafePlaces.some(
    (p) => distanceMeters(pos.lat, pos.lng, p.lat, p.lng) <= 150
  );

  db.prepare(
    `INSERT INTO incidents (id, parentId, type, severity, ts, active, lat, lng, exitTs, dwellMin, escalationDueTs, pickupConfirmed, dropoffConfirmed, timeline_json, pt01Eligible, triage_json)
     VALUES (?,?,?,?,?,1,?,?,?,?,?,0,0,?,1,NULL)`
  ).run(
    id,
    parentId,
    'WANDERING',
    'high',
    ts,
    pos.lat,
    pos.lng,
    geofenceEvent.exitTs,
    Math.round((geofenceEvent.dwellMs / 60000) * 100) / 100,
    ts + 10 * 60 * 1000,
    JSON.stringify([{ ts, event: 'incident_created', detail: `Exited geo-fence, dwell ${dwellMin}min` }])
  );

  appendEvent(db, {
    parentId,
    type: 'wandering',
    title: 'Wandering alert: outside safe zone',
    deepLink: `/v1/incidents/${id}`,
    refId: id,
  });

  const triage = await triageWandering(
    {
      dwellMin,
      distanceM: Math.round(geofenceEvent.distanceM),
      direction: geofenceEvent.direction,
      localTimeIso: new Date(ts).toISOString(),
      localHour,
      frsScore: frs.score,
      frsFactors: frs.factors,
      recentOutcomes: recentOutcomes(db, parentId),
      knownSafePlaces,
      movingTowardSafePlace,
    },
    { apiKey: takeAnthropicKey(parentId) }
  );

  db.prepare('UPDATE incidents SET triage_json = ?, severity = ? WHERE id = ?').run(
    JSON.stringify(triage),
    triage.severity,
    id
  );
  addTimeline(db, id, { event: 'triage', detail: triage.reasoning, recommendedAction: triage.recommendedAction });

  // Surface the triage reason in the same activity feed the app already polls (GET /v1/events),
  // so "why was I alerted" is visible without a second call to fetch the incident's timeline.
  appendEvent(db, {
    parentId,
    type: 'wandering',
    title: `Triage (${triage.severity}): ${triage.reasoning}`,
    deepLink: `/v1/incidents/${id}`,
    refId: id,
  });

  // Auto-dispatch: "wandering for more than 10 minutes" is measured on the same (possibly
  // DEMO_TIMESCALE-compressed) clock the geo-fence tracker uses, not wall-clock dwellMin — a
  // WANDERING incident only ever reaches this point once geofenceEvent.dwellMs has crossed
  // dwellThresholdMs(), so this is a defensive restatement of that same rule, not a fresh timer.
  // 'soft_check' is the only triage outcome that means "probably fine" — anything else
  // (notify_now / dispatch_suggest) is treated as unusual and dispatches a taxi automatically
  // rather than waiting on the caregiver to request one.
  if (geofenceEvent.dwellMs >= dwellThresholdMs() && triage.recommendedAction !== 'soft_check') {
    const { status } = createDispatchForIncident(db, { id, parentId, lat: pos.lat, lng: pos.lng });
    if (status === 201) {
      addTimeline(db, id, {
        event: 'auto_dispatch',
        detail: `Automatic taxi dispatch triggered — dwell ${dwellMin}min, triage recommended ${triage.recommendedAction}`,
      });
    }
  }

  return id;
}

function checkDropoff(db, parentId, settings) {
  const active = db
    .prepare(`SELECT * FROM incidents WHERE parentId = ? AND active = 1 AND pickupConfirmed = 1 AND dropoffConfirmed = 0`)
    .all(parentId);
  if (active.length === 0) return;
  const pos = currentPosition(parentId, settings.homeLatLng);
  const distanceM = distanceMeters(settings.homeLatLng.lat, settings.homeLatLng.lng, pos.lat, pos.lng);
  if (distanceM <= 50) {
    for (const inc of active) {
      db.prepare('UPDATE incidents SET dropoffConfirmed = 1 WHERE id = ?').run(inc.id);
      addTimeline(db, inc.id, { event: 'dropoff_confirmed' });
      appendEvent(db, {
        parentId,
        type: 'visit_completed',
        title: 'Safe arrival confirmed at home',
        deepLink: `/v1/incidents/${inc.id}`,
        refId: inc.id,
      });
    }
  }
}

async function tickParent(db, parentId) {
  const settings = getSettings(db, parentId);
  if (!settings.monitoringActive || !settings.sharingEnabled) return;

  const home = settings.homeLatLng;
  const tracker = getTracker(parentId);
  const pos = currentPosition(parentId, home);
  // home/radius are read fresh every tick (never cached on the tracker), so a config change
  // from PATCH /v1/policy/monitoringConfig takes effect on the very next tick.
  const event = tracker.ingest(pos, home, settings.geofenceRadius, dwellThresholdMs());

  if (event.event === 'wandering') {
    const existing = db
      .prepare(`SELECT id FROM incidents WHERE parentId = ? AND type = 'WANDERING' AND active = 1`)
      .get(parentId);
    if (!existing) {
      await createWanderingIncident(db, parentId, settings, event);
    }
  } else if (event.event === 'inside' && event.resolvedByEnlargement) {
    // The geo-fence radius was enlarged mid-dwell, not a genuine walk-home — close any active
    // WANDERING incident with a distinct resolution note (a real walk-home is instead resolved
    // via checkDropoff's GPS-match-to-home confirmation, a deliberate, higher-confidence signal).
    const active = db
      .prepare(`SELECT * FROM incidents WHERE parentId = ? AND type = 'WANDERING' AND active = 1`)
      .get(parentId);
    if (active) {
      db.prepare('UPDATE incidents SET active = 0 WHERE id = ?').run(active.id);
      addTimeline(db, active.id, { event: 'resolved', detail: 'geofence enlarged' });
      appendEvent(db, {
        parentId,
        type: 'wandering',
        title: 'Wandering alert resolved — geo-fence enlarged',
        deepLink: `/v1/incidents/${active.id}`,
        refId: active.id,
      });
    }
  }

  checkDropoff(db, parentId, settings);
  await checkFrsAlarms(db, parentId).catch((e) => console.error('frs alarm check error', e));
}

function activeHouseholdIds(db) {
  // householdId === parentId for the demo's 1:1 mapping (see db.js seed()). Falls back to the
  // two hard-coded demo constants only if the households table is empty (e.g. a fresh :memory:
  // db used before seed() has run), so tests that open the db without seeding don't break.
  const rows = db.prepare('SELECT householdId FROM households').all();
  return rows.length > 0 ? rows.map((r) => r.householdId) : [DEFAULT_PARENT_ID, SECOND_PARENT_ID];
}

export function startGeofenceTick(db) {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(() => {
    for (const parentId of activeHouseholdIds(db)) {
      tickParent(db, parentId).catch((e) => console.error('geofence tick error', e));
    }
  }, TICK_MS);
  tickHandle.unref?.();
  return tickHandle;
}

export function stopGeofenceTick() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
}

const sosSchema = z.object({
  parentId: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

export function incidentsRouter(db) {
  const router = Router();

  router.get('/v1/incidents', (req, res) => {
    const parentId = getParentId(req);
    let rows;
    if (req.query.active === undefined) {
      rows = db.prepare('SELECT * FROM incidents WHERE parentId = ? ORDER BY ts DESC').all(parentId);
    } else {
      const active = ['1', 'true'].includes(String(req.query.active)) ? 1 : 0;
      rows = db
        .prepare('SELECT * FROM incidents WHERE parentId = ? AND active = ? ORDER BY ts DESC')
        .all(parentId, active);
    }
    res.json(rows.map(parseIncident));
  });

  router.get('/v1/incidents/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(parseIncident(row));
  });

  router.patch('/v1/incident/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'NOT_FOUND' });
    if (req.body.pickupConfirmed !== true) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'only pickupConfirmed:true is accepted' });
    }
    const dispatch = db
      .prepare(`SELECT * FROM dispatches WHERE incidentId = ? ORDER BY createdTs DESC LIMIT 1`)
      .get(row.id);
    if (!dispatch || dispatch.status !== 'en_route') {
      return res.status(409).json({ error: 'DISPATCH_NOT_EN_ROUTE' });
    }
    db.prepare('UPDATE incidents SET pickupConfirmed = 1 WHERE id = ?').run(row.id);
    addTimeline(db, row.id, { event: 'pickup_confirmed' });
    appendEvent(db, {
      parentId: row.parentId,
      type: 'wandering',
      title: 'Pickup confirmed — heading home',
      deepLink: `/v1/incidents/${row.id}`,
      refId: row.id,
    });
    res.json(parseIncident(db.prepare('SELECT * FROM incidents WHERE id = ?').get(row.id)));
  });

  router.post('/v1/sos', requireRole('parent'), (req, res) => {
    const parsed = sosSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
    const parentId = getParentId(req);
    const settings = getSettings(db, parentId);
    const pos =
      parsed.data.lat != null && parsed.data.lng != null
        ? { lat: parsed.data.lat, lng: parsed.data.lng }
        : currentPosition(parentId, settings.homeLatLng);

    const id = randomUUID();
    const ts = Date.now();
    db.prepare(
      `INSERT INTO incidents (id, parentId, type, severity, ts, active, lat, lng, exitTs, dwellMin, escalationDueTs, pickupConfirmed, dropoffConfirmed, timeline_json, pt01Eligible, triage_json)
       VALUES (?,?,?,?,?,1,?,?,NULL,NULL,?,0,0,?,0,NULL)`
    ).run(
      id,
      parentId,
      'SOS',
      'high',
      ts,
      pos.lat,
      pos.lng,
      ts + 10 * 60 * 1000,
      JSON.stringify([{ ts, event: 'sos_triggered' }])
    );
    appendEvent(db, {
      parentId,
      type: 'sos',
      title: '助けて! SOS triggered',
      deepLink: `/v1/incidents/${id}`,
      refId: id,
    });
    res.status(201).json(parseIncident(db.prepare('SELECT * FROM incidents WHERE id = ?').get(id)));
  });

  return router;
}
