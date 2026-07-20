// Calls the Protosure backend API Rater to validate the parametric rules for a trigger.
//
// PROVISIONAL: no Protosure sandbox credentials were available at build time. The request/
// response shape below is our best guess, modeled loosely on the description of last year's
// Solar Panel integration. Before the hackathon: request sandbox credentials and confirm the
// exact schema, then adjust only the field mapping in this file — callers (routes/attestation.js)
// are written against `validateWithRater`'s return shape and don't need to change.

import { FIXED_SCHEDULE } from './stub.js';

export class RaterUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.code = 'RATER_UNAVAILABLE';
  }
}

async function callRaterOnce({ policyId, triggerCode, payoutAmount, eventTimestamp }, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`${process.env.PROTOSURE_BASE_URL}/v1/rate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.PROTOSURE_API_TOKEN}`,
      },
      body: JSON.stringify({
        productCode: process.env.PROTOSURE_PRODUCT_CODE,
        policyId,
        triggerCode,
        requestedAmount: payoutAmount,
        eventTimestamp,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`RATER_HTTP_${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// Returns { ok, reason?, raterRef?, source } — same shape as protosure/stub.js's
// validateTrigger, so routes/attestation.js can treat both modes identically.
export async function validateWithRater(
  { policyId, triggerCode, payoutAmount, eventTimestamp = Date.now() },
  { fetchImpl = fetch, timeoutMs = 5000 } = {}
) {
  let result;
  try {
    result = await callRaterOnce({ policyId, triggerCode, payoutAmount, eventTimestamp }, fetchImpl, timeoutMs);
  } catch (firstErr) {
    try {
      result = await callRaterOnce({ policyId, triggerCode, payoutAmount, eventTimestamp }, fetchImpl, timeoutMs); // R-19: one retry
    } catch (secondErr) {
      throw new RaterUnavailableError(secondErr.message);
    }
  }

  if (!result.policyInForce) return { ok: false, reason: 'POLICY_NOT_IN_FORCE' };
  if (!result.triggerConfigured) return { ok: false, reason: 'TRIGGER_NOT_CONFIGURED' };
  if (result.ratedAmount !== FIXED_SCHEDULE[triggerCode]) return { ok: false, reason: 'RATER_AMOUNT_MISMATCH' };
  if (!result.cooldownOk) return { ok: false, reason: 'COOLDOWN_EXCEEDED' };
  return { ok: true, raterRef: result.raterRef, source: 'protosure' };
}
