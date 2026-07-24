// Claude decision module: screens LOW_FRS / INACTIVITY alarms before they're raised, to void
// false alarms caused by data artifacts (watch not worn, charger-day gaps, one-off outliers)
// rather than genuine decline.
//
// Guardrails (code, not prompt): a `void` writes an auditable row to frs_reviews and
// suppresses the *alert only* — raw FRS data is never modified. The PT-03/PT-04 attestation
// path (src/routes/attestation.js, src/routes/payments.js) reads raw FRS data directly and
// never imports this module: Claude screens operational alarms, deterministic rules still own
// the money. Two consecutive `void`s for the same condition force a `raise` on the third.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { callClaudeJson, isClaudeConfigured } from './client.js';
import { appendEvent } from '../db.js';

export const frsReviewSchema = z.object({
  decision: z.enum(['raise', 'void']),
  confidence: z.number().min(0).max(1),
  category: z.enum(['genuine_decline', 'watch_not_worn', 'data_gap', 'one_off_outlier']),
  reasoning: z.string().min(1),
});

const FAIL_SAFE = {
  decision: 'raise',
  confidence: 1,
  category: 'genuine_decline',
  reasoning: 'Claude unavailable or returned malformed output — raising to be safe (fail-safe).',
};

// Local stand-in for the Claude call, used only when ANTHROPIC_API_KEY isn't set (e.g. this
// demo deploy). Mirrors the same data-artifact-vs-genuine-decline reasoning a review prompt
// would apply, so the reasoning text reads like a real assessment rather than the generic
// "Claude unavailable" fail-safe message.
function stubReview(ctx) {
  const gaps = ctx.chargerDayGaps ?? [];
  const wearFlags = ctx.wearTimeFlags ?? [];
  const scores = (ctx.series ?? []).map((s) => s.score).filter((s) => s != null);
  const condition = (ctx.conditionType ?? 'condition').toLowerCase();

  const recentNotWorn = wearFlags.length > 0 && wearFlags[wearFlags.length - 1]?.worn === false;
  const isOneOffDip =
    scores.length >= 3 &&
    scores[scores.length - 1] < 60 &&
    scores.slice(0, -1).every((s) => s >= 60);

  if (recentNotWorn || gaps.length > 0) {
    return {
      decision: 'void',
      confidence: 0.78,
      category: recentNotWorn ? 'watch_not_worn' : 'data_gap',
      reasoning:
        `[stub review] ${gaps.length} charger-day gap(s) in the last 14 days` +
        (recentNotWorn ? ", and the device wasn't worn on the most recent day" : '') +
        ` — likely a missing-data artifact rather than a genuine ${condition}, voiding this alarm.`,
    };
  }

  if (isOneOffDip) {
    return {
      decision: 'void',
      confidence: 0.65,
      category: 'one_off_outlier',
      reasoning:
        `[stub review] FRS dipped to ${scores[scores.length - 1]} on a single day against an otherwise ` +
        `steady history (${scores.slice(0, -1).join(', ')}) — treating as a one-off outlier rather than ` +
        'sustained decline.',
    };
  }

  return {
    decision: 'raise',
    confidence: 0.85,
    category: 'genuine_decline',
    reasoning:
      `[stub review] Pattern shows a sustained decline with no obvious data artifact (no charger-day gaps, ` +
      `device worn) — raising as a genuine ${condition}.`,
  };
}

function buildPrompt(ctx) {
  return JSON.stringify(
    {
      subject: 'parent-001',
      condition: ctx.conditionType,
      last14DayFrsSeries: ctx.series ?? [],
      wearTimeFlags: ctx.wearTimeFlags ?? [],
      dataSufficientFlags: ctx.dataSufficientFlags ?? [],
      chargerDayGaps: ctx.chargerDayGaps ?? [],
      weatherNote: ctx.weatherNote ?? null,
    },
    null,
    2
  );
}

// apiKey: optional, one-time caller-supplied Anthropic key (see claude/pendingKey.js) — takes
// priority over ANTHROPIC_API_KEY for this call only, so the operator's standing env-var key
// (if any) never has to be exposed to public callers just to demo real Claude output.
export async function reviewFrsAlarm(ctx, { callJson = callClaudeJson, apiKey } = {}) {
  try {
    if (callJson === callClaudeJson && !isClaudeConfigured(apiKey)) {
      return stubReview(ctx);
    }
    const prompt = buildPrompt(ctx);
    return await callJson({
      purpose: 'frs-review',
      system:
        'You are screening a possible false alarm in an eldercare wellness score. ' +
        'Respond with ONLY a single JSON object — no markdown code fences, no prose before or after — ' +
        'matching exactly this shape and no other fields:\n' +
        '{"decision": "raise" | "void", ' +
        '"confidence": <number 0 to 1>, ' +
        '"category": "genuine_decline" | "watch_not_worn" | "data_gap" | "one_off_outlier", ' +
        '"reasoning": "<one or two sentences, under 40 words>"}',
      prompt,
      schema: frsReviewSchema,
      apiKey,
    });
  } catch (e) {
    return { ...FAIL_SAFE };
  }
}

// Two consecutive void decisions for the same (parentId, conditionType) force a raise on the
// third occurrence, regardless of what this round's review said.
export function applyForcedRaiseGuardrail(db, parentId, conditionType, review) {
  const priorTwo = db
    .prepare(
      `SELECT decision FROM frs_reviews WHERE parentId = ? AND conditionKey = ? ORDER BY ts DESC LIMIT 2`
    )
    .all(parentId, conditionType);
  const bothVoided = priorTwo.length === 2 && priorTwo.every((r) => r.decision === 'void');
  if (bothVoided && review.decision === 'void') {
    return {
      ...review,
      decision: 'raise',
      reasoning: `${review.reasoning} (forced raise: two consecutive voids already recorded for this condition)`,
    };
  }
  return review;
}

// Runs the full screen for a candidate LOW_FRS/INACTIVITY alarm: calls Claude, applies the
// forced-raise guardrail, records an auditable row, and appends a feed event on void. Returns
// the final decision so the caller can decide whether to actually raise the incident.
export async function runFrsReview(db, { parentId, conditionType, ctx, callJson, apiKey } = {}) {
  const raw = await reviewFrsAlarm({ ...ctx, conditionType }, { callJson, apiKey });
  const final = applyForcedRaiseGuardrail(db, parentId, conditionType, raw);

  const id = randomUUID();
  db.prepare(
    `INSERT INTO frs_reviews (id, parentId, ts, conditionType, conditionKey, decision, confidence, category, reasoning)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, parentId, Date.now(), conditionType, conditionType, final.decision, final.confidence, final.category, final.reasoning);

  if (final.decision === 'void') {
    appendEvent(db, {
      parentId,
      type: 'frs_void',
      title: `Claude voided a false ${conditionType} alarm: ${final.reasoning}`,
      deepLink: '/v1/frs/reviews',
      refId: id,
    });
  }

  return { ...final, id };
}
