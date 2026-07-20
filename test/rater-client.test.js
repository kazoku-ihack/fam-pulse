import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWithRater, RaterUnavailableError } from '../src/protosure/rater-client.js';

// PROVISIONAL fixture: modeled on the described shape of last year's Solar Panel integration,
// since no real Protosure sandbox credentials were available at build time (see
// src/protosure/rater-client.js header comment). Adjust once real credentials confirm the
// schema — validateWithRater's return shape is what callers depend on, not this fixture.
const FIXTURE_OK = {
  policyInForce: true,
  triggerConfigured: true,
  ratedAmount: 30000,
  cooldownOk: true,
  raterRef: 'rater-ref-12345',
};

function jsonFetch(body, ok = true) {
  return async () => ({ ok, status: ok ? 200 : 500, json: async () => body });
}

test('fixture-based contract test: a valid rater response is accepted', async () => {
  process.env.PROTOSURE_BASE_URL = 'https://sandbox.protosure.test';
  process.env.PROTOSURE_API_TOKEN = 'token';
  const result = await validateWithRater(
    { policyId: 'p1', triggerCode: 'PT-02', payoutAmount: 30000, eventTimestamp: Date.now() },
    { fetchImpl: jsonFetch(FIXTURE_OK) }
  );
  assert.equal(result.ok, true);
  assert.equal(result.raterRef, 'rater-ref-12345');
  assert.equal(result.source, 'protosure');
});

test('amount mismatch is rejected even if the rater call otherwise succeeds', async () => {
  const badAmount = { ...FIXTURE_OK, ratedAmount: 999 };
  const result = await validateWithRater(
    { policyId: 'p1', triggerCode: 'PT-02', payoutAmount: 30000, eventTimestamp: Date.now() },
    { fetchImpl: jsonFetch(badAmount) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'RATER_AMOUNT_MISMATCH');
});

test('policy not in force is rejected', async () => {
  const result = await validateWithRater(
    { policyId: 'p1', triggerCode: 'PT-02', payoutAmount: 30000, eventTimestamp: Date.now() },
    { fetchImpl: jsonFetch({ ...FIXTURE_OK, policyInForce: false }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'POLICY_NOT_IN_FORCE');
});

test('cool-down failure from the rater is rejected', async () => {
  const result = await validateWithRater(
    { policyId: 'p1', triggerCode: 'PT-01', payoutAmount: 3000, eventTimestamp: Date.now() },
    { fetchImpl: jsonFetch({ ...FIXTURE_OK, ratedAmount: 3000, cooldownOk: false }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'COOLDOWN_EXCEEDED');
});

test('timeout/unreachable rater retries once (R-19) then throws RaterUnavailableError', async () => {
  let calls = 0;
  const flakyFetch = async () => {
    calls++;
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(
    () =>
      validateWithRater(
        { policyId: 'p1', triggerCode: 'PT-02', payoutAmount: 30000, eventTimestamp: Date.now() },
        { fetchImpl: flakyFetch }
      ),
    RaterUnavailableError
  );
  assert.equal(calls, 2); // one retry, per R-19
});
