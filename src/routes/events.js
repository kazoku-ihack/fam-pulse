import { Router } from 'express';
import { getParentId } from '../db.js';

export function eventsRouter(db) {
  const router = Router();

  router.get('/v1/events', (req, res) => {
    const parentId = getParentId(req);
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 20));
    const rows = db
      .prepare('SELECT * FROM events WHERE parentId = ? OR parentId IS NULL ORDER BY ts DESC, id DESC LIMIT ?')
      .all(parentId, limit);
    res.json(
      rows.map((r) => ({
        type: r.type,
        ts: r.ts,
        title: r.title,
        deepLink: r.deepLink,
        refId: r.refId,
      }))
    );
  });

  return router;
}
