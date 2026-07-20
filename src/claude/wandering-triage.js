// Claude decision module: classify a WANDERING incident, screen for false alarms.
// Called once when a WANDERING incident is created. Never called for SOS (helper bypasses
// this module entirely by design — see routes/incidents.js).
//
// Hard guardrails live here in code, not in the prompt: Claude may only *downgrade* an alert
// to `soft_check` when ALL FOUR conditions hold. Everything else notifies immediately. Claude
// timeout/failure/malformed-JSON (even after one retry) fails safe to notify_now/high.

import { z } from 'zod';
import { callClaudeJson } from './client.js';

export const triageSchema = z.object({
  severity: z.enum(['low', 'medium', 'high']),
  falseAlarmLikelihood: z.number().min(0).max(1),
  recommendedAction: z.enum(['notify_now', 'soft_check', 'dispatch_suggest']),
  reasoning: z.string().min(1),
});

const FAIL_SAFE = {
  severity: 'high',
  falseAlarmLikelihood: 0,
  recommendedAction: 'notify_now',
  reasoning: 'Claude unavailable or returned malformed output — defaulting to immediate notification (fail-safe).',
};

function buildPrompt(ctx) {
  return JSON.stringify(
    {
      subject: 'parent-001', // pseudonymized, never a real name
      dwellMinutes: ctx.dwellMin,
      distanceFromHomeM: ctx.distanceM,
      directionOfTravel: ctx.direction,
      localTime: ctx.localTimeIso,
      todayFRS: ctx.frsScore,
      frsFactors: ctx.frsFactors,
      lastFiveIncidentOutcomes: ctx.recentOutcomes ?? [],
      knownSafePlaces: ctx.knownSafePlaces ?? [],
      movingTowardKnownSafePlace: Boolean(ctx.movingTowardSafePlace),
    },
    null,
    2
  );
}

// ctx: { dwellMin, distanceM, direction, localTimeIso, localHour, frsScore, frsFactors,
//        recentOutcomes, knownSafePlaces, movingTowardSafePlace }
export async function triageWandering(ctx, { callJson = callClaudeJson } = {}) {
  let triage;
  try {
    const prompt = buildPrompt(ctx);
    triage = await callJson({
      purpose: 'wandering-triage',
      system:
        'You are a cautious eldercare monitoring assistant screening a possible wandering event. ' +
        'Respond with strict JSON only, matching the schema exactly. No prose outside the JSON object.',
      prompt,
      schema: triageSchema,
    });
  } catch (e) {
    return { ...FAIL_SAFE, guardsPass: false };
  }

  const guardsPass =
    triage.falseAlarmLikelihood >= 0.7 &&
    ctx.frsScore >= 60 &&
    ctx.localHour >= 7 &&
    ctx.localHour < 19 &&
    ctx.movingTowardSafePlace === true;

  let recommendedAction = triage.recommendedAction;
  if (recommendedAction === 'soft_check' && !guardsPass) {
    recommendedAction = 'notify_now';
  }

  return { ...triage, recommendedAction, guardsPass };
}
