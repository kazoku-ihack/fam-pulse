import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setupApp, API_KEY } from './helpers.js';
import { makeFakeChain } from './fakeChain.js';

const RECIPIENT = '0x' + '22'.repeat(20);

function withEnv(vars, run) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  return run().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function withFailingFetch(run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test('protosure mode + ATTESTATION_FALLBACK=stub: rater unreachable falls back to local stub, source stamped', async () => {
  await withEnv(
    { ATTESTATION_MODE: 'protosure', ATTESTATION_FALLBACK: 'stub', PROTOSURE_BASE_URL: 'https://sandbox.test', PROTOSURE_API_TOKEN: 't' },
    () =>
      withFailingFetch(async () => {
        const chain = makeFakeChain();
        const { app } = setupApp({ attestation: { chain } });
        const res = await request(app)
          .post('/v1/attestation/trigger')
          .set('x-api-key', API_KEY)
          .send({ policyId: 'p1', triggerCode: 'PT-02', recipient: RECIPIENT });
        assert.equal(res.status, 201);
        assert.equal(res.body.source, 'stub-fallback');
      })
  );
});

test('protosure mode + ATTESTATION_FALLBACK=fail: rater unreachable rejects the attestation', async () => {
  await withEnv(
    { ATTESTATION_MODE: 'protosure', ATTESTATION_FALLBACK: 'fail', PROTOSURE_BASE_URL: 'https://sandbox.test', PROTOSURE_API_TOKEN: 't' },
    () =>
      withFailingFetch(async () => {
        const chain = makeFakeChain();
        const { app } = setupApp({ attestation: { chain } });
        const res = await request(app)
          .post('/v1/attestation/trigger')
          .set('x-api-key', API_KEY)
          .send({ policyId: 'p1', triggerCode: 'PT-02', recipient: RECIPIENT });
        assert.equal(res.status, 422);
        assert.equal(res.body.error, 'RATER_UNAVAILABLE');
      })
  );
});
