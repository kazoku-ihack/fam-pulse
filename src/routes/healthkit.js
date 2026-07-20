import { Router } from 'express';
import { z } from 'zod';
import { computeFRS } from '../frs.js';
import { getParentId } from '../db.js';

const metricsSchema = z.object({
  parentId: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  dailySteps: z.number().int().min(0).max(50000),
  sleepHours: z.number().min(0).max(16),
  heartRateAvg: z.number().int().min(30).max(220),
  heartRateResting: z.number().int().min(30).max(220),
});

function priorHistorySteps(db, parentId, beforeDate, limit = 7) {
  const rows = db
    .prepare(
      `SELECT dailySteps FROM metrics WHERE parentId = ? AND date < ? ORDER BY date DESC LIMIT ?`
    )
    .all(parentId, beforeDate, limit);
  return rows.map((r) => r.dailySteps);
}

export function healthkitRouter(db) {
  const router = Router();

  router.post('/v1/healthkit/metrics', (req, res) => {
    const parsed = metricsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', details: parsed.error.issues });
    }
    const parentId = parsed.data.parentId || getParentId(req);
    const { date, dailySteps, sleepHours, heartRateAvg, heartRateResting } = parsed.data;

    db.prepare(
      `INSERT INTO metrics (parentId, date, dailySteps, sleepHours, heartRateAvg, heartRateResting, ts)
       VALUES (@parentId, @date, @dailySteps, @sleepHours, @heartRateAvg, @heartRateResting, @ts)
       ON CONFLICT(parentId, date) DO UPDATE SET
         dailySteps = excluded.dailySteps,
         sleepHours = excluded.sleepHours,
         heartRateAvg = excluded.heartRateAvg,
         heartRateResting = excluded.heartRateResting,
         ts = excluded.ts`
    ).run({ parentId, date, dailySteps, sleepHours, heartRateAvg, heartRateResting, ts: Date.now() });

    const historySteps = priorHistorySteps(db, parentId, date);
    const frs = computeFRS({ today: { dailySteps, sleepHours, heartRateResting }, historySteps });
    db.prepare(
      `INSERT INTO frs_history (parentId, date, score, factors_json) VALUES (?,?,?,?)
       ON CONFLICT(parentId, date) DO UPDATE SET score = excluded.score, factors_json = excluded.factors_json`
    ).run(parentId, date, frs.score, JSON.stringify(frs.factors));

    res.status(201).json({ parentId, date, dailySteps, sleepHours, heartRateAvg, heartRateResting });
  });

  router.get('/v1/healthkit/metrics', (req, res) => {
    const parentId = getParentId(req);
    const rows = db
      .prepare(`SELECT * FROM metrics WHERE parentId = ? ORDER BY date ASC`)
      .all(parentId);
    res.json(rows);
  });

  return router;
}
