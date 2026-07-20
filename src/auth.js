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
