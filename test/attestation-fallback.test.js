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

function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const failingFetch = async () => {
  throw new Error('ECONNREFUSED');
};

test('protosure mode: a successful rater response (golden-vector fixture shape) is accepted, source:"protosure"', async () => {
  await withEnv(
    { ATTESTATION_MODE: 'protosure', PROTOSURE_RATER_URL: 'https://sandbox.test/sign', PROTOSURE_USERNAME: 'u', PROTOSURE_PASSWORD: 'p' },
    () =>
      withFetch(
        async () => ({
          ok: true,
          json: async () => ({
            raterData: {
              payload_hash: '0xc1b318da13d253576a3a51eb16289aa9ab31141cd8d3acd003049c087a77fd4d',
              signature: '0x' + '11'.repeat(65),
              signer: process.env.REGISTERED_SIGNER,
            },
          }),
        }),
        async () => {
          const chain = makeFakeChain();
          const { app } = setupApp({ attestation: { chain } });
          const res = await request(app)
            .post('/v1/attestation/trigger')
            .set('x-api-key', API_KEY)
            .send({ policyId: 'KP-2026-001', triggerCode: 'PT-02', recipient: RECIPIENT });
          assert.equal(res.status, 201);
          assert.equal(res.body.source, 'protosure');
          assert.equal(res.body.payloadHash, '0xc1b318da13d253576a3a51eb16289aa9ab31141cd8d3acd003049c087a77fd4d');
          assert.equal(res.body.signer.toLowerCase(), process.env.REGISTERED_SIGNER);
        }
      )
  );
});

test('protosure mode: a response signed by an unregistered signer is treated as unavailable and falls back', async () => {
  await withEnv(
    { ATTESTATION_MODE: 'protosure', ATTESTATION_FALLBACK: 'stub', PROTOSURE_RATER_URL: 'https://sandbox.test/sign', PROTOSURE_USERNAME: 'u', PROTOSURE_PASSWORD: 'p' },
    () =>
      withFetch(
        async () => ({
          ok: true,
          json: async () => ({
            raterData: {
              payload_hash: '0xdeadbeef',
              signature: '0x' + '11'.repeat(65),
              signer: '0x0000000000000000000000000000000000dEaD', // not REGISTERED_SIGNER
            },
          }),
        }),
        async () => {
          const chain = makeFakeChain();
          const { app } = setupApp({ attestation: { chain } });
          const res = await request(app)
            .post('/v1/attestation/trigger')
            .set('x-api-key', API_KEY)
            .send({ policyId: 'KP-2026-001', triggerCode: 'PT-02', recipient: RECIPIENT });
          assert.equal(res.status, 201);
          assert.equal(res.body.source, 'stub-fallback');
        }
      )
  );
});

test('protosure mode + ATTESTATION_FALLBACK=stub: rater unreachable falls back to local stub, source stamped', async () => {
  await withEnv(
    { ATTESTATION_MODE: 'protosure', ATTESTATION_FALLBACK: 'stub', PROTOSURE_RATER_URL: 'https://sandbox.test/sign', PROTOSURE_USERNAME: 'u', PROTOSURE_PASSWORD: 'p' },
    () =>
      withFetch(failingFetch, async () => {
        const chain = makeFakeChain();
        const { app } = setupApp({ attestation: { chain } });
        const res = await request(app)
          .post('/v1/attestation/trigger')
          .set('x-api-key', API_KEY)
          .send({ policyId: 'KP-2026-001', triggerCode: 'PT-02', recipient: RECIPIENT });
        assert.equal(res.status, 201);
        assert.equal(res.body.source, 'stub-fallback');
      })
  );
});

test('protosure mode + ATTESTATION_FALLBACK=fail: rater unreachable rejects the attestation', async () => {
  await withEnv(
    { ATTESTATION_MODE: 'protosure', ATTESTATION_FALLBACK: 'fail', PROTOSURE_RATER_URL: 'https://sandbox.test/sign', PROTOSURE_USERNAME: 'u', PROTOSURE_PASSWORD: 'p' },
    () =>
      withFetch(failingFetch, async () => {
        const chain = makeFakeChain();
        const { app } = setupApp({ attestation: { chain } });
        const res = await request(app)
          .post('/v1/attestation/trigger')
          .set('x-api-key', API_KEY)
          .send({ policyId: 'KP-2026-001', triggerCode: 'PT-02', recipient: RECIPIENT });
        assert.equal(res.status, 422);
        assert.equal(res.body.error, 'RATER_UNAVAILABLE');
      })
  );
});
