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
import { callClaudeJson } from './client.js';
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

export async function reviewFrsAlarm(ctx, { callJson = callClaudeJson } = {}) {
  try {
    const prompt = buildPrompt(ctx);
    return await callJson({
      purpose: 'frs-review',
      system:
        'You are screening a possible false alarm in an eldercare wellness score. ' +
        'Respond with strict JSON only, matching the schema exactly. No prose outside the JSON object.',
      prompt,
      schema: frsReviewSchema,
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
export async function runFrsReview(db, { parentId, conditionType, ctx, callJson } = {}) {
  const raw = await reviewFrsAlarm({ ...ctx, conditionType }, callJson ? { callJson } : undefined);
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
