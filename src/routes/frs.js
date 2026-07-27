import { Router } from 'express';
import { computeFRS } from '../frs.js';
import { getParentId } from '../db.js';

function priorHistorySteps(db, parentId, beforeDate, limit = 7) {
  const rows = db
    .prepare(
      `SELECT dailySteps FROM metrics WHERE parentId = ? AND date < ? ORDER BY date DESC LIMIT ?`
    )
    .all(parentId, beforeDate, limit);
  return rows.map((r) => r.dailySteps);
}

export function frsRouter(db) {
  const router = Router();

  router.get('/v1/frs/today', (req, res) => {
    const parentId = getParentId(req);
    const date = new Date().toISOString().slice(0, 10);
    const todayRow = db
      .prepare(`SELECT dailySteps, sleepHours, heartRateResting FROM metrics WHERE parentId = ? AND date = ?`)
      .get(parentId, date);

    const frs = todayRow
      ? computeFRS({ today: todayRow, historySteps: priorHistorySteps(db, parentId, date) })
      : computeFRS({ today: null });

    // The parent role never receives the numeric FRS — enforced here, not trusted to any client.
    if (req.household?.role === 'parent') {
      const { score, factors, ...redacted } = frs;
      return res.json(redacted);
    }
    res.json(frs);
  });

  router.get('/v1/frs/history', (req, res) => {
    const parentId = getParentId(req);
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 7));
    const rows = db
      .prepare(`SELECT date, score FROM frs_history WHERE parentId = ? ORDER BY date DESC LIMIT ?`)
      .all(parentId, days);
    res.json(rows.reverse().map((r) => ({ date: r.date, score: r.score ?? null })));
  });

  router.get('/v1/frs/reviews', (req, res) => {
    const parentId = getParentId(req);
    const rows = db
      .prepare(`SELECT * FROM frs_reviews WHERE parentId = ? ORDER BY ts DESC`)
      .all(parentId);
    res.json(
      rows.map((r) => ({
        id: r.id,
        parentId: r.parentId,
        ts: r.ts,
        conditionType: r.conditionType,
        conditionKey: r.conditionKey,
        decision: r.decision,
        confidence: r.confidence,
        category: r.category,
        reasoning: r.reasoning,
      }))
    );
  });

  return router;
}
