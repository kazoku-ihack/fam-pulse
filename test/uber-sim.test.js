import test from 'node:test';
import assert from 'node:assert/strict';
import { startDispatchSimulation } from '../src/sims/uber.js';

function withMockedFetch(run) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(JSON.parse(opts.body).status);
    return { ok: true };
  };
  return run(calls).finally(() => {
    globalThis.fetch = original;
  });
}

test('normal lifecycle posts accepted -> en_route -> arrived -> completed', async () => {
  const prevScale = process.env.DEMO_TIMESCALE;
  const prevFail = process.env.SIM_FAIL_DISPATCH;
  process.env.DEMO_TIMESCALE = '100000';
  delete process.env.SIM_FAIL_DISPATCH;

  await withMockedFetch(async (calls) => {
    startDispatchSimulation({
      dispatchId: 'd1',
      incidentId: 'i1',
      baseUrl: 'http://internal.test',
      secret: 's',
      pickup: { lat: 0, lng: 0 },
      dropoff: { lat: 1, lng: 1 },
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(calls, ['accepted', 'en_route', 'arrived', 'completed']);
  });

  if (prevScale === undefined) delete process.env.DEMO_TIMESCALE;
  else process.env.DEMO_TIMESCALE = prevScale;
  if (prevFail !== undefined) process.env.SIM_FAIL_DISPATCH = prevFail;
});

test('SIM_FAIL_DISPATCH=1 stops after accepted (rehearses the escalation banner)', async () => {
  const prevScale = process.env.DEMO_TIMESCALE;
  const prevFail = process.env.SIM_FAIL_DISPATCH;
  process.env.DEMO_TIMESCALE = '100000';
  process.env.SIM_FAIL_DISPATCH = '1';

  await withMockedFetch(async (calls) => {
    startDispatchSimulation({
      dispatchId: 'd2',
      incidentId: 'i2',
      baseUrl: 'http://internal.test',
      secret: 's',
      pickup: { lat: 0, lng: 0 },
      dropoff: { lat: 1, lng: 1 },
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(calls, ['accepted']);
  });

  if (prevScale === undefined) delete process.env.DEMO_TIMESCALE;
  else process.env.DEMO_TIMESCALE = prevScale;
  if (prevFail === undefined) delete process.env.SIM_FAIL_DISPATCH;
  else process.env.SIM_FAIL_DISPATCH = prevFail;
});
