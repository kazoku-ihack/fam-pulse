import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyScore, computeFRS } from '../src/frs.js';

test('FRS boundary classification at 59/60/69/70', () => {
  assert.equal(classifyScore(59).emoticon, 'concerned');
  assert.equal(classifyScore(59).statusText, "Let's take care today");
  assert.equal(classifyScore(60).emoticon, 'neutral');
  assert.equal(classifyScore(60).statusText, 'Doing okay');
  assert.equal(classifyScore(69).emoticon, 'neutral');
  assert.equal(classifyScore(70).emoticon, 'happy');
  assert.equal(classifyScore(70).statusText, 'Feeling good');
});

test('no metrics row today -> dataSufficient false, "Please wear your watch"', () => {
  const r = computeFRS({ today: null });
  assert.equal(r.dataSufficient, false);
  assert.equal(r.statusText, 'Please wear your watch');
  assert.equal(r.emoticon, 'concerned');
});

test('all factors in full-credit band -> score 100', () => {
  const r = computeFRS({
    today: { dailySteps: 4200, sleepHours: 7.5, heartRateResting: 65 },
    historySteps: [4000, 4100, 4200],
  });
  assert.equal(r.score, 100);
  assert.equal(r.dataSufficient, true);
  assert.equal(r.emoticon, 'happy');
});

test('routine factor uses median of prior days, capped at full credit', () => {
  const r = computeFRS({
    today: { dailySteps: 8000, sleepHours: 7.5, heartRateResting: 65 },
    historySteps: [4000, 4000, 4000],
  });
  // steps far exceed target and median -> mobility and routine both cap at their max
  assert.equal(r.factors.mobility, 30);
  assert.equal(r.factors.routine, 20);
});

test('vitals and sleep fall off outside their bands', () => {
  const r = computeFRS({
    today: { dailySteps: 4000, sleepHours: 4, heartRateResting: 100 },
    historySteps: [4000],
  });
  assert.ok(r.factors.sleep < 20);
  assert.ok(r.factors.vitals < 30);
});
