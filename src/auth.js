import { createHash } from 'node:crypto';

export function hashDeviceToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function apiKeyAuth(req, res, next) {
  const expected = process.env.API_KEY;
  const provided = req.header('x-api-key');
  if (!expected) {
    // Demo-grade fail-closed: refuse to run unauthenticated even if misconfigured.
    return res.status(500).json({ error: 'SERVER_MISCONFIGURED', message: 'API_KEY not set' });
  }
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  next();
}

export function judgeKeyAuth(req, res, next) {
  const expected = process.env.JUDGE_KEY;
  if (!expected) return next(); // optional gate, per brief §8
  const provided = req.header('x-judge-key') || req.query.judgeKey;
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  next();
}

// Resolves an optional `Authorization: Bearer <deviceToken>` into `req.household =
// {householdId, role, parentId}`. Additive on top of apiKeyAuth, not a replacement — no header
// means no-op (existing curl/demo workflows and the full pre-activation test suite are
// unaffected), a header means household-scoped + role-gated. Kept as a factory (not a bare
// function) so it can look up the presented token against `devices` without every route needing
// its own db handle.
export function requireDevice(db) {
  return (req, res, next) => {
    const header = req.header('authorization');
    if (!header || !header.startsWith('Bearer ')) return next();
    const token = header.slice('Bearer '.length);
    const tokenHash = hashDeviceToken(token);
    const device = db
      .prepare('SELECT * FROM devices WHERE deviceTokenHash = ? AND revokedAt IS NULL')
      .get(tokenHash);
    if (!device) return res.status(401).json({ error: 'DEVICE_REVOKED' });
    db.prepare('UPDATE devices SET lastSeen = ? WHERE deviceId = ?').run(Date.now(), device.deviceId);
    // parentId === householdId for the demo's 1:1 household<->parent mapping (see db.js seed()).
    req.household = { householdId: device.householdId, role: device.role, parentId: device.householdId };
    next();
  };
}

// 403s only when a device token IS presented and its role doesn't match — a no-op when
// `req.household` is unset, so unauthenticated-by-device demo calls keep working exactly as
// before (requireDevice being additive means this must be too).
export function requireRole(role) {
  return (req, res, next) => {
    if (req.household && req.household.role !== role) {
      return res.status(403).json({ error: 'FORBIDDEN_ROLE' });
    }
    next();
  };
}
