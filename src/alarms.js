// LOW_FRS / INACTIVITY alarm evaluation: screened through claude/frs-review.js before ever
// becoming a visible incident, so data artifacts (watch not worn, charger-day gaps) don't
// alarm the family. Runs from the same background tick as the geo-fence (routes/incidents.js)
// and can be invoked directly by routes/demo.js for the false-alarm rehearsal scenario.

import { randomUUID } from 'node:crypto';
import { computeFRS } from './frs.js';
import { appendEvent } from './db.js';
import { runFrsReview } from './claude/frs-review.js';
import { takeAnthropicKey } from './claude/pendingKey.js';

function todayStartTs(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function alreadyReviewedToday(db, parentId, conditionType) {
  const row = db
    .prepare(`SELECT id FROM frs_reviews WHERE parentId = ? AND conditionType = ? AND ts >= ?`)
    .get(parentId, conditionType, todayStartTs());
  return Boolean(row);
}

function buildReviewCtx(db, parentId) {
  const series = db
    .prepare(`SELECT date, score FROM frs_history WHERE parentId = ? ORDER BY date DESC LIMIT 14`)
    .all(parentId)
    .reverse();
  const metricsRows = db
    .prepare(`SELECT date, dailySteps, sleepHours, heartRateResting FROM metrics WHERE parentId = ? ORDER BY date DESC LIMIT 14`)
    .all(parentId)
    .reverse();
  const dataSufficientFlags = metricsRows.map((r) => ({ date: r.date, dataSufficient: r.dailySteps != null }));
  const wearTimeFlags = metricsRows.map((r) => ({ date: r.date, worn: r.heartRateResting != null }));
  const chargerDayGaps = metricsRows.filter((r) => r.dailySteps == null || r.dailySteps === 0).map((r) => r.date);
  return { series, dataSufficientFlags, wearTimeFlags, chargerDayGaps, weatherNote: null };
}

async function createFrsIncident(db, parentId, type, severity) {
  const id = randomUUID();
  const ts = Date.now();
  db.prepare(
    `INSERT INTO incidents (id, parentId, type, severity, ts, active, lat, lng, exitTs, dwellMin, escalationDueTs, pickupConfirmed, dropoffConfirmed, timeline_json, pt01Eligible, triage_json)
     VALUES (?,?,?,?,?,1,NULL,NULL,NULL,NULL,?,0,0,?,0,NULL)`
  ).run(id, parentId, type, severity, ts, ts + 60 * 60 * 1000, JSON.stringify([{ ts, event: 'incident_created' }]));
  appendEvent(db, {
    parentId,
    type: type === 'LOW_FRS' ? 'frs_dip' : 'wandering',
    title: type === 'LOW_FRS' ? 'Wellness score dipped — worth a check-in' : 'No activity data today',
    deepLink: `/v1/incidents/${id}`,
    refId: id,
  });
  return id;
}

export async function checkFrsAlarms(db, parentId, { callJson } = {}) {
  const date = new Date().toISOString().slice(0, 10);
  const todayRow = db
    .prepare('SELECT dailySteps, sleepHours, heartRateResting FROM metrics WHERE parentId = ? AND date = ?')
    .get(parentId, date);
  const historySteps = db
    .prepare('SELECT dailySteps FROM metrics WHERE parentId = ? AND date < ? ORDER BY date DESC LIMIT 7')
    .all(parentId, date)
    .map((r) => r.dailySteps);
  const frs = computeFRS({ today: todayRow ?? null, historySteps });

  const activeLowFrs = db.prepare(`SELECT id FROM incidents WHERE parentId = ? AND type = 'LOW_FRS' AND active = 1`).get(parentId);
  const activeInactivity = db
    .prepare(`SELECT id FROM incidents WHERE parentId = ? AND type = 'INACTIVITY' AND active = 1`)
    .get(parentId);

  if (!frs.dataSufficient && !activeInactivity && !alreadyReviewedToday(db, parentId, 'INACTIVITY')) {
    const review = await runFrsReview(db, {
      parentId,
      conditionType: 'INACTIVITY',
      ctx: buildReviewCtx(db, parentId),
      callJson,
      apiKey: takeAnthropicKey(parentId),
    });
    if (review.decision === 'raise') {
      await createFrsIncident(db, parentId, 'INACTIVITY', 'medium');
    }
    return review;
  }

  if (frs.dataSufficient && frs.score < 60 && !activeLowFrs && !alreadyReviewedToday(db, parentId, 'LOW_FRS')) {
    const review = await runFrsReview(db, {
      parentId,
      conditionType: 'LOW_FRS',
      ctx: buildReviewCtx(db, parentId),
      callJson,
      apiKey: takeAnthropicKey(parentId),
    });
    if (review.decision === 'raise') {
      await createFrsIncident(db, parentId, 'LOW_FRS', frs.score < 50 ? 'high' : 'medium');
    }
    return review;
  }

  return null;
}
