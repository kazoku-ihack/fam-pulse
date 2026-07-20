import test from 'node:test';
import assert from 'node:assert/strict';
import { triageWandering } from '../src/claude/wandering-triage.js';

function baseCtx(overrides = {}) {
  return {
    dwellMin: 12,
    distanceM: 600,
    direction: 'N',
    localTimeIso: new Date().toISOString(),
    localHour: 14,
    frsScore: 75,
    frsFactors: {},
    recentOutcomes: [],
    knownSafePlaces: [],
    movingTowardSafePlace: true,
    ...overrides,
  };
}

const softCheckReply = async () => ({
  severity: 'low',
  falseAlarmLikelihood: 0.9,
  recommendedAction: 'soft_check',
  reasoning: 'Likely a walk to the usual supermarket.',
});

test('downgrade allowed when all 4 guard conditions hold', async () => {
  const result = await triageWandering(baseCtx(), { callJson: softCheckReply });
  assert.equal(result.recommendedAction, 'soft_check');
  assert.equal(result.guardsPass, true);
});

test('downgrade refused when FRS is below 60', async () => {
  const result = await triageWandering(baseCtx({ frsScore: 50 }), { callJson: softCheckReply });
  assert.equal(result.recommendedAction, 'notify_now');
  assert.equal(result.guardsPass, false);
});

test('downgrade refused outside 07:00-19:00', async () => {
  const result = await triageWandering(baseCtx({ localHour: 22 }), { callJson: softCheckReply });
  assert.equal(result.recommendedAction, 'notify_now');
});

test('downgrade refused when not moving toward a known safe place', async () => {
  const result = await triageWandering(baseCtx({ movingTowardSafePlace: false }), { callJson: softCheckReply });
  assert.equal(result.recommendedAction, 'notify_now');
});

test('downgrade refused when falseAlarmLikelihood < 0.7', async () => {
  const lowLikelihood = async () => ({ ...(await softCheckReply()), falseAlarmLikelihood: 0.5 });
  const result = await triageWandering(baseCtx(), { callJson: lowLikelihood });
  assert.equal(result.recommendedAction, 'notify_now');
});

test('dispatch_suggest and notify_now pass through untouched even without guards', async () => {
  const notifyNow = async () => ({ severity: 'high', falseAlarmLikelihood: 0.1, recommendedAction: 'notify_now', reasoning: 'x' });
  const result = await triageWandering(baseCtx({ movingTowardSafePlace: false }), { callJson: notifyNow });
  assert.equal(result.recommendedAction, 'notify_now');
});

test('malformed Claude output (throws) -> fail-safe notify_now/high', async () => {
  const broken = async () => {
    throw new Error('schema validation failed twice');
  };
  const result = await triageWandering(baseCtx(), { callJson: broken });
  assert.equal(result.recommendedAction, 'notify_now');
  assert.equal(result.severity, 'high');
});
