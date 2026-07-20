import { Router } from 'express';
import { resetDb, DEFAULT_PARENT_ID } from '../db.js';
import { startWanderingWalk } from '../sims/gps.js';
import { checkFrsAlarms } from '../alarms.js';
import { parseCareReplyEmail, applyParsedReply } from './care.js';
import { asyncHandler } from '../asyncHandler.js';

const CANNED_REPLY =
  'Hi, this is Aiko from the care network. I can visit Thursday at 3pm for a wellness check and light ' +
  'housekeeping. Rate is 3000 yen. — Aiko M.';

function fallbackCannedPlan() {
  return {
    staff: 'Aiko M.',
    visitAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    services: ['wellness check', 'light housekeeping'],
    rate: 3000,
  };
}

export function demoRouter(db, { callJson } = {}) {
  const router = Router();

  router.post('/v1/demo/reset', (req, res) => {
    resetDb(db);
    res.json({ ok: true, resetAt: Date.now() });
  });

  // Public (judge-key gated only) status summary for the Judge Console, which — being a
  // plain static page — can never hold the x-api-key.
  router.get('/v1/demo/status', (req, res) => {
    const parentId = req.query.parentId || DEFAULT_PARENT_ID;
    const activeIncidents = db.prepare('SELECT COUNT(*) AS c FROM incidents WHERE active = 1').get().c;
    const latestPayout = db.prepare(`SELECT * FROM events WHERE type = 'payout' ORDER BY ts DESC LIMIT 1`).get();
    res.json({
      parentId,
      activeIncidents,
      latestPayout: latestPayout
        ? { title: latestPayout.title, deepLink: latestPayout.deepLink, ts: latestPayout.ts }
        : null,
    });
  });

  router.post('/v1/demo/scenario/:name', asyncHandler(async (req, res) => {
    const parentId = req.body?.parentId || DEFAULT_PARENT_ID;

    switch (req.params.name) {
      case 'wandering': {
        startWanderingWalk(parentId);
        return res.json({ ok: true, scenario: 'wandering', parentId });
      }

      case 'false-alarm': {
        const date = new Date().toISOString().slice(0, 10);
        db.prepare('DELETE FROM metrics WHERE parentId = ? AND date = ?').run(parentId, date);
        db.prepare('DELETE FROM frs_history WHERE parentId = ? AND date = ?').run(parentId, date);
        const review = await checkFrsAlarms(db, parentId, { callJson });
        return res.json({ ok: true, scenario: 'false-alarm', parentId, review });
      }

      case 'care-reply': {
        const { careRequestId } = req.body || {};
        const row = careRequestId
          ? db.prepare('SELECT id FROM care_requests WHERE id = ?').get(careRequestId)
          : db
              .prepare(`SELECT id FROM care_requests WHERE parentId = ? AND status = 'pending' ORDER BY slaDueTs DESC LIMIT 1`)
              .get(parentId);
        if (!row) return res.status(404).json({ error: 'NO_PENDING_CARE_REQUEST' });
        const result = await parseCareReplyEmail(CANNED_REPLY, callJson ? { callJson } : undefined);
        applyParsedReply(
          db,
          row.id,
          result.ok ? { ...result, parsedByClaude: true } : { ok: true, plan: fallbackCannedPlan(), parsedByClaude: false }
        );
        return res.json({ ok: true, scenario: 'care-reply', careRequestId: row.id });
      }

      default:
        return res.status(404).json({ error: 'UNKNOWN_SCENARIO' });
    }
  }));

  return router;
}
