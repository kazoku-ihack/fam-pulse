import { Router } from 'express';
import { resetDb, DEFAULT_PARENT_ID } from '../db.js';
import { startWanderingWalk } from '../sims/gps.js';
import { checkFrsAlarms } from '../alarms.js';
import { parseCareReplyEmail, applyParsedReply, createCareRequest } from './care.js';
import { payDriverForDispatch, TAXI_RIDE_FEE_JPY } from './dispatch.js';
import { asyncHandler } from '../asyncHandler.js';
import { armAnthropicKey, takeAnthropicKey } from '../claude/pendingKey.js';
import * as chainDefault from '../chain/chain.js';

const CANNED_REPLY =
  'Hi, this is Aiko from the care network. I can visit Thursday at 3pm for a wellness check and light ' +
  'housekeeping. Rate is 3000 yen. — Aiko M.';

const DEFAULT_CARE_NEED_SUMMARY = 'Weekly wellness check-in and light housekeeping';

function fallbackCannedPlan() {
  return {
    staff: 'Aiko M.',
    visitAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    services: ['wellness check', 'light housekeeping'],
    rate: 3000,
  };
}

export function demoRouter(db, { callJson, chain = chainDefault } = {}) {
  const router = Router();

  router.post('/v1/demo/reset', (req, res) => {
    resetDb(db);
    res.json({ ok: true, resetAt: Date.now() });
  });

  // Public (judge-key gated only) status summary for the Judge Console, which — being a
  // plain static page — can never hold the x-api-key.
  router.get('/v1/demo/status', (req, res) => {
    const parentId = req.query.parentId || DEFAULT_PARENT_ID;

    const incidentRows = db
      .prepare(`SELECT id, type, severity, ts, triage_json FROM incidents WHERE parentId = ? AND active = 1 ORDER BY ts DESC`)
      .all(parentId);
    const activeIncidentDetails = incidentRows.map((r) => ({
      id: r.id,
      type: r.type,
      severity: r.severity,
      ageSec: Math.round((Date.now() - r.ts) / 1000),
      triageReason: r.triage_json ? JSON.parse(r.triage_json).reasoning : null,
    }));

    // parentId IS NULL covers cross-family events (settlement/payout are not per-incident).
    const latestPayout = db
      .prepare(`SELECT * FROM events WHERE type = 'payout' AND (parentId = ? OR parentId IS NULL) ORDER BY ts DESC LIMIT 1`)
      .get(parentId);
    const recentEvents = db
      .prepare(`SELECT type, ts, title FROM events WHERE parentId = ? OR parentId IS NULL ORDER BY ts DESC, id DESC LIMIT 8`)
      .all(parentId);

    // Most recent completed-but-unpaid dispatch for this family — drives the Judge Console's
    // "Approve & Pay driver" button, which only appears once there's something to pay.
    const unpaidDispatch = db
      .prepare(
        `SELECT d.id, d.driver_json FROM dispatches d
         JOIN incidents i ON i.id = d.incidentId
         WHERE i.parentId = ? AND d.status = 'completed' AND d.driverPaidTxHash IS NULL
         ORDER BY d.createdTs DESC LIMIT 1`
      )
      .get(parentId);

    res.json({
      parentId,
      demoTimescale: parseFloat(process.env.DEMO_TIMESCALE) || 1,
      activeIncidents: activeIncidentDetails.length,
      activeIncidentDetails,
      latestPayout: latestPayout
        ? { title: latestPayout.title, deepLink: latestPayout.deepLink, ts: latestPayout.ts }
        : null,
      recentEvents,
      pendingDriverPayment: unpaidDispatch
        ? { dispatchId: unpaidDispatch.id, driverName: JSON.parse(unpaidDispatch.driver_json).name, amount: TAXI_RIDE_FEE_JPY }
        : null,
    });
  });

  router.post('/v1/demo/scenario/:name', asyncHandler(async (req, res) => {
    const parentId = req.body?.parentId || DEFAULT_PARENT_ID;
    // Optional: supply your own Anthropic key for this one scenario run instead of relying on a
    // standing ANTHROPIC_API_KEY env var, which would otherwise spend the operator's credits for
    // anyone hitting these public endpoints. Falls back to the stub exactly as before when omitted.
    armAnthropicKey(parentId, req.body?.anthropicApiKey);

    switch (req.params.name) {
      case 'wandering': {
        startWanderingWalk(parentId);
        return res.json({ ok: true, scenario: 'wandering', parentId });
      }

      case 'false-alarm': {
        const date = new Date().toISOString().slice(0, 10);
        db.prepare('DELETE FROM metrics WHERE parentId = ? AND date = ?').run(parentId, date);
        db.prepare('DELETE FROM frs_history WHERE parentId = ? AND date = ?').run(parentId, date);
        // checkFrsAlarms takes the armed key itself, at the point it actually calls Claude —
        // it's also invoked from the background geofence tick, so it must own that lookup.
        const review = await checkFrsAlarms(db, parentId, { callJson });
        return res.json({ ok: true, scenario: 'false-alarm', parentId, review });
      }

      case 'care-reply': {
        const { careRequestId } = req.body || {};
        let row = careRequestId
          ? db.prepare('SELECT id FROM care_requests WHERE id = ?').get(careRequestId)
          : db
              .prepare(`SELECT id FROM care_requests WHERE parentId = ? AND status = 'pending' ORDER BY slaDueTs DESC LIMIT 1`)
              .get(parentId);
        // The Judge Console (a public static page) can never hold x-api-key, so it has no way
        // to call POST /v1/careRequest first — this scenario has to be able to create its own
        // pending request when one wasn't explicitly named and none exists yet.
        if (!row && !careRequestId) {
          const newId = await createCareRequest(db, { parentId, needSummary: DEFAULT_CARE_NEED_SUMMARY, callJson });
          row = { id: newId };
        }
        if (!row) return res.status(404).json({ error: 'NO_PENDING_CARE_REQUEST' });
        const result = await parseCareReplyEmail(CANNED_REPLY, { callJson, apiKey: takeAnthropicKey(parentId) });
        applyParsedReply(
          db,
          row.id,
          result.ok ? { ...result, parsedByClaude: true } : { ok: true, plan: fallbackCannedPlan(), parsedByClaude: false }
        );
        return res.json({ ok: true, scenario: 'care-reply', careRequestId: row.id });
      }

      case 'pay-driver': {
        const { dispatchId, sakuraPrivateKey } = req.body || {};
        // The Judge Console can't hold x-api-key, so it can't call POST
        // /v1/uber/dispatch/:id/pay directly — same reasoning as care-reply above. When no
        // dispatchId is given, pay the family's most recent completed-but-unpaid dispatch (what
        // /v1/demo/status already surfaced as pendingDriverPayment). sakuraPrivateKey is an
        // optional per-request override typed into the console's own field — see
        // chain.js#getSakuraWallet — never persisted here, just passed straight through.
        const targetId =
          dispatchId ||
          db
            .prepare(
              `SELECT d.id FROM dispatches d
               JOIN incidents i ON i.id = d.incidentId
               WHERE i.parentId = ? AND d.status = 'completed' AND d.driverPaidTxHash IS NULL
               ORDER BY d.createdTs DESC LIMIT 1`
            )
            .get(parentId)?.id;
        if (!targetId) return res.status(404).json({ error: 'NO_UNPAID_DISPATCH' });
        const { status, body } = await payDriverForDispatch(db, chain, { dispatchId: targetId, sakuraPrivateKey });
        return res.status(status).json({ ok: status < 300, scenario: 'pay-driver', ...body });
      }

      default:
        return res.status(404).json({ error: 'UNKNOWN_SCENARIO' });
    }
  }));

  return router;
}
