import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, seed, DEFAULT_PARENT_ID } from '../src/db.js';
import { runFrsReview } from '../src/claude/frs-review.js';

function db() {
  const d = openDb(':memory:');
  seed(d);
  return d;
}

const voidReply = async () => ({
  decision: 'void',
  confidence: 0.8,
  category: 'watch_not_worn',
  reasoning: 'Charger-day gap — no data, likely watch not worn overnight.',
});

test('a void decision writes an auditable frs_reviews row and never touches raw metrics', async () => {
  const d = db();
  const before = d.prepare('SELECT * FROM metrics WHERE parentId = ?').all(DEFAULT_PARENT_ID);

  const result = await runFrsReview(d, {
    parentId: DEFAULT_PARENT_ID,
    conditionType: 'INACTIVITY',
    ctx: {},
    callJson: voidReply,
  });
  assert.equal(result.decision, 'void');

  const reviews = d.prepare('SELECT * FROM frs_reviews WHERE parentId = ?').all(DEFAULT_PARENT_ID);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].decision, 'void');

  const after = d.prepare('SELECT * FROM metrics WHERE parentId = ?').all(DEFAULT_PARENT_ID);
  assert.deepEqual(before, after);
});

test('void suppresses the alert but the caller decides not to raise an incident', async () => {
  const d = db();
  const result = await runFrsReview(d, {
    parentId: DEFAULT_PARENT_ID,
    conditionType: 'INACTIVITY',
    ctx: {},
    callJson: voidReply,
  });
  assert.equal(result.decision, 'void');
  const incidents = d.prepare(`SELECT * FROM incidents WHERE type = 'INACTIVITY'`).all();
  assert.equal(incidents.length, 0);
});

test('two consecutive voids for the same condition force a raise on the third', async () => {
  const d = db();
  const ctx = { conditionType: 'LOW_FRS' };

  const r1 = await runFrsReview(d, { parentId: DEFAULT_PARENT_ID, conditionType: 'LOW_FRS', ctx, callJson: voidReply });
  assert.equal(r1.decision, 'void');
  const r2 = await runFrsReview(d, { parentId: DEFAULT_PARENT_ID, conditionType: 'LOW_FRS', ctx, callJson: voidReply });
  assert.equal(r2.decision, 'void');
  // Claude would still say "void" a third time, but the guardrail must force a raise.
  const r3 = await runFrsReview(d, { parentId: DEFAULT_PARENT_ID, conditionType: 'LOW_FRS', ctx, callJson: voidReply });
  assert.equal(r3.decision, 'raise');
});

test('a genuine decline (raise) is passed straight through', async () => {
  const d = db();
  const raiseReply = async () => ({
    decision: 'raise',
    confidence: 0.9,
    category: 'genuine_decline',
    reasoning: 'Sustained multi-day drop with full wear-time data.',
  });
  const result = await runFrsReview(d, {
    parentId: DEFAULT_PARENT_ID,
    conditionType: 'LOW_FRS',
    ctx: {},
    callJson: raiseReply,
  });
  assert.equal(result.decision, 'raise');
});

test('Claude failure fails safe to raise', async () => {
  const d = db();
  const broken = async () => {
    throw new Error('timeout');
  };
  const result = await runFrsReview(d, {
    parentId: DEFAULT_PARENT_ID,
    conditionType: 'LOW_FRS',
    ctx: {},
    callJson: broken,
  });
  assert.equal(result.decision, 'raise');
});
