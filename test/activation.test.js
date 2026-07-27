import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupApp, API_KEY } from './helpers.js';

const GOOD = {
  role: 'adult_child',
  policyNumber: 'KP-2026-001',
  insuredDob: '1948-03-12',
  phone: '+819012345678',
  email: 'sakura.tanaka@example.jp',
};

function creds(deviceId, role, overrides = {}) {
  return { ...GOOD, role, deviceId, ...overrides };
}

async function verify(app, body) {
  return request(app).post('/v1/activation/verify').set('x-api-key', API_KEY).send(body);
}
async function complete(app, body) {
  return request(app).post('/v1/activation/complete').set('x-api-key', API_KEY).send(body);
}

test('happy path: verify -> complete -> status -> household, in stub mode', async () => {
  const { app } = setupApp();
  const v = await verify(app, creds('device-happy', 'adult_child'));
  assert.equal(v.status, 200);
  assert.equal(v.body.customerId, 'CUST-DEMO-001');
  assert.equal(v.body.householdId, 'yoshiko-001');
  assert.equal(v.body.deviceToken, null);

  const c = await complete(app, { activationId: v.body.activationId, deviceId: 'device-happy' });
  assert.equal(c.status, 200);
  assert.equal(c.body.role, 'adult_child');
  assert.equal(c.body.nextScreen, 'W-01');
  assert.ok(c.body.deviceToken);

  const status = await request(app).get('/v1/activation/status?deviceId=device-happy').set('x-api-key', API_KEY);
  assert.equal(status.body.state, 'active');

  const household = await request(app).get(`/v1/household/${v.body.householdId}`).set('x-api-key', API_KEY);
  assert.equal(household.status, 200);
  assert.equal(household.body.customerId, 'CUST-DEMO-001');
  assert.equal(household.body.devices.length, 1);
});

test('R-20 uniformity: wrong field / nonexistent policy all produce byte-identical bodies and similar timing', async () => {
  const { app } = setupApp();
  const variants = [
    creds('device-u1', 'adult_child', { policyNumber: 'KP-2026-999' }),
    creds('device-u2', 'adult_child', { insuredDob: '1948-03-13' }),
    creds('device-u3', 'adult_child', { phone: '+819012345679' }),
    creds('device-u4', 'adult_child', { email: 'someone.else@example.jp' }),
    creds('device-u5', 'adult_child', {
      policyNumber: 'KP-0000-000',
      insuredDob: '1900-01-01',
      phone: '+810000000000',
      email: 'nobody@example.jp',
    }),
  ];

  const results = [];
  for (const body of variants) {
    const start = Date.now();
    const res = await verify(app, body);
    results.push({ status: res.status, body: res.body, elapsed: Date.now() - start });
  }

  for (const r of results) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'AUTH_NO_MATCH' });
  }
  const elapsed = results.map((r) => r.elapsed);
  assert.ok(Math.max(...elapsed) - Math.min(...elapsed) < 100, `timing variance too high: ${JSON.stringify(elapsed)}`);
});

test('R-21 lock: the 5th recorded failure locks further attempts, even with correct credentials', async () => {
  const { app } = setupApp();
  const bad = creds('device-lock', 'adult_child', { insuredDob: '1999-01-01' });
  for (let i = 0; i < 5; i++) {
    const res = await verify(app, bad);
    assert.equal(res.status, 401);
  }
  const locked = await verify(app, creds('device-lock', 'adult_child'));
  assert.equal(locked.status, 423);
  assert.equal(locked.body.error, 'ACTIVATION_LOCKED');
  assert.ok(locked.body.retryAfter > 0);
});

test('R-21 lock: expires once the counted failures age out of the window', async () => {
  const { app, db } = setupApp();
  const bad = creds('device-lock-2', 'adult_child', { insuredDob: '1999-01-01' });
  for (let i = 0; i < 5; i++) {
    await verify(app, bad);
  }
  const locked = await verify(app, bad);
  assert.equal(locked.status, 423);

  const lockMinutes = parseInt(process.env.ACTIVATION_LOCK_MINUTES, 10) || 15;
  const past = Date.now() - lockMinutes * 60 * 1000 - 1000;
  db.prepare('UPDATE activation_attempts SET ts = ?').run(past);

  const unlocked = await verify(app, bad);
  assert.equal(unlocked.status, 401); // back to a normal no-match, not 423
});

test('fail closed: an unreachable Protosure creates no household/device/activation rows', async () => {
  const prevMode = process.env.ACTIVATION_MODE;
  const prevUrl = process.env.PROTOSURE_BASE_URL;
  const prevToken = process.env.PROTOSURE_API_TOKEN;
  const originalFetch = global.fetch;
  process.env.ACTIVATION_MODE = 'protosure';
  process.env.PROTOSURE_BASE_URL = 'https://example.invalid/verify';
  process.env.PROTOSURE_API_TOKEN = 'test-token';
  global.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  try {
    const { app, db } = setupApp();
    const res = await verify(app, creds('device-fail-closed', 'adult_child'));
    assert.equal(res.status, 502);
    assert.equal(res.body.error, 'PROTOSURE_UNAVAILABLE');

    const newHouseholds = db.prepare(`SELECT COUNT(*) c FROM households WHERE customerId != 'CUST-DEMO-001'`).get().c;
    assert.equal(newHouseholds, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM activations').get().c, 0);
    assert.equal(
      db.prepare(`SELECT COUNT(*) c FROM devices WHERE deviceId = 'device-fail-closed'`).get().c,
      0
    );
  } finally {
    global.fetch = originalFetch;
    process.env.ACTIVATION_MODE = prevMode;
    process.env.PROTOSURE_BASE_URL = prevUrl;
    process.env.PROTOSURE_API_TOKEN = prevToken;
  }
});

test('stub parity: all four credentials must match — flipping any single field fails', async () => {
  const { app } = setupApp();
  const ok = await verify(app, creds('device-parity-ok', 'adult_child'));
  assert.equal(ok.status, 200);

  const wrongValues = {
    policyNumber: 'KP-2026-999',
    insuredDob: '1948-03-13',
    phone: '+819012345679',
    email: 'someone.else@example.jp',
  };
  for (const field of Object.keys(wrongValues)) {
    const res = await verify(app, creds(`device-parity-${field}`, 'adult_child', { [field]: wrongValues[field] }));
    assert.equal(res.status, 401, `expected mismatch for ${field}`);
  }
});

test('second device joins: adult_child then parent share one household; re-activating parent revokes the old token', async () => {
  const { app, db } = setupApp();

  const v1 = await verify(app, creds('device-1', 'adult_child'));
  const c1 = await complete(app, { activationId: v1.body.activationId, deviceId: 'device-1' });
  assert.equal(c1.status, 200);

  const v2 = await verify(app, creds('device-2', 'parent'));
  assert.equal(v2.body.householdId, v1.body.householdId);
  const c2 = await complete(app, { activationId: v2.body.activationId, deviceId: 'device-2' });
  assert.equal(c2.status, 200);

  const devices = db
    .prepare('SELECT * FROM devices WHERE householdId = ? AND revokedAt IS NULL')
    .all(v1.body.householdId);
  assert.equal(devices.length, 2);

  const v3 = await verify(app, creds('device-3', 'parent'));
  const c3 = await complete(app, { activationId: v3.body.activationId, deviceId: 'device-3' });
  assert.equal(c3.status, 200);

  const oldTokenCall = await request(app)
    .get('/v1/parent/status')
    .set('x-api-key', API_KEY)
    .set('authorization', `Bearer ${c2.body.deviceToken}`);
  assert.equal(oldTokenCall.status, 401);
  assert.equal(oldTokenCall.body.error, 'DEVICE_REVOKED');

  const newTokenCall = await request(app)
    .get('/v1/parent/status')
    .set('x-api-key', API_KEY)
    .set('authorization', `Bearer ${c3.body.deviceToken}`);
  assert.equal(newTokenCall.status, 200);
});

test('gating: parent-role token gets 403 on PATCH /v1/settings; GET /v1/frs/today carries no score for that role', async () => {
  const { app } = setupApp();
  const v = await verify(app, creds('device-gate', 'parent'));
  const c = await complete(app, { activationId: v.body.activationId, deviceId: 'device-gate' });
  const token = c.body.deviceToken;

  const patch = await request(app)
    .patch('/v1/settings')
    .set('x-api-key', API_KEY)
    .set('authorization', `Bearer ${token}`)
    .send({ chips: { careNetwork: 'manual' } });
  assert.equal(patch.status, 403);
  assert.equal(patch.body.error, 'FORBIDDEN_ROLE');

  const frs = await request(app)
    .get('/v1/frs/today')
    .set('x-api-key', API_KEY)
    .set('authorization', `Bearer ${token}`);
  assert.equal(frs.status, 200);
  assert.equal('score' in frs.body, false);
  assert.equal('factors' in frs.body, false);
  assert.ok('statusText' in frs.body && 'emoticon' in frs.body);
});

test('gating: adult_child-role token gets 403 on PATCH /v1/consent', async () => {
  const { app } = setupApp();
  const v = await verify(app, creds('device-gate-2', 'adult_child'));
  const c = await complete(app, { activationId: v.body.activationId, deviceId: 'device-gate-2' });
  const token = c.body.deviceToken;

  const patch = await request(app)
    .patch('/v1/consent')
    .set('x-api-key', API_KEY)
    .set('authorization', `Bearer ${token}`)
    .send({ sharingEnabled: false });
  assert.equal(patch.status, 403);
  assert.equal(patch.body.error, 'FORBIDDEN_ROLE');
});

test('a revoked device token is rejected with 401 DEVICE_REVOKED, an unknown token is too', async () => {
  const { app } = setupApp();
  const res = await request(app)
    .get('/v1/parent/status')
    .set('x-api-key', API_KEY)
    .set('authorization', 'Bearer not-a-real-token');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'DEVICE_REVOKED');
});

test('requests with no device token keep working exactly as before (additive, not required)', async () => {
  const { app } = setupApp();
  const res = await request(app).get('/v1/frs/today').set('x-api-key', API_KEY);
  assert.equal(res.status, 200);
  assert.ok('score' in res.body);
});
