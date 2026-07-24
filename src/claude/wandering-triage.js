// Claude decision module: classify a WANDERING incident, screen for false alarms.
// Called once when a WANDERING incident is created. Never called for SOS (helper bypasses
// this module entirely by design — see routes/incidents.js).
//
// Hard guardrails live here in code, not in the prompt: Claude may only *downgrade* an alert
// to `soft_check` when ALL FOUR conditions hold. Everything else notifies immediately. Claude
// timeout/failure/malformed-JSON (even after one retry) fails safe to notify_now/high.

import { z } from 'zod';
import { callClaudeJson, isClaudeConfigured } from './client.js';

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

// Local stand-in for the Claude call, used only when ANTHROPIC_API_KEY isn't set (e.g. this
// demo deploy). Applies the same reasoning a triage prompt would, so the reasoning text reads
// like a real assessment instead of the generic "Claude unavailable" fail-safe message.
function stubTriage(ctx) {
  const safe =
    ctx.movingTowardSafePlace &&
    ctx.frsScore >= 60 &&
    ctx.localHour >= 7 &&
    ctx.localHour < 19 &&
    ctx.dwellMin < 20;

  const situation =
    `Subject has been ${ctx.distanceM}m from home for ${ctx.dwellMin} min, heading ${ctx.direction}, ` +
    `today's FRS is ${ctx.frsScore}. ` +
    (ctx.movingTowardSafePlace
      ? 'Currently moving toward a known safe place.'
      : 'Not moving toward any known safe place.');

  if (safe) {
    return {
      severity: 'low',
      falseAlarmLikelihood: 0.82,
      recommendedAction: 'soft_check',
      reasoning:
        `[stub triage] ${situation} Pattern matches a routine daytime outing with a healthy FRS — ` +
        'likely a false alarm, recommending a soft check-in rather than an immediate alert.',
    };
  }

  return {
    severity: ctx.dwellMin >= 20 || ctx.frsScore < 50 ? 'high' : 'medium',
    falseAlarmLikelihood: 0.15,
    recommendedAction: 'notify_now',
    reasoning:
      `[stub triage] ${situation} Pattern is inconsistent with a routine outing — recommending ` +
      'immediate caregiver notification.',
  };
}

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
    if (callJson === callClaudeJson && !isClaudeConfigured()) {
      triage = stubTriage(ctx);
    } else {
      const prompt = buildPrompt(ctx);
      triage = await callJson({
        purpose: 'wandering-triage',
        system:
          'You are a cautious eldercare monitoring assistant screening a possible wandering event. ' +
          'Respond with strict JSON only, matching the schema exactly. No prose outside the JSON object.',
        prompt,
        schema: triageSchema,
      });
    }
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
