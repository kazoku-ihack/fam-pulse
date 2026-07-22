// Sign-only Protosure rater client. Rule validation (fixed schedule, cool-downs, cap headroom)
// lives in src/attestation-rules.js and applies identically regardless of which signer produces
// the signature — the rater's only job is to sign the canonical digest.
//
// Field/response shape confirmed against the real rater's golden reference vector (see
// FamPulse_API_Sync_Changes.md and test/protosure-stub.test.js) — not a guess.

export class RaterUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.code = 'RATER_UNAVAILABLE';
  }
}

function sigByteLength(sig) {
  const hex = sig.startsWith('0x') ? sig.slice(2) : sig;
  return hex.length / 2;
}

// fields: { policyId, triggerRef, coverageCode, payoutAmount, recipient, monthKey, contractAddress, chainId }
async function signOnce(fields, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(process.env.PROTOSURE_RATER_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.PROTOSURE_API_TOKEN}`,
      },
      body: JSON.stringify({
        policy_id: fields.policyId,
        trigger_ref: fields.triggerRef,
        coverage_code: fields.coverageCode,
        payout_amount: String(fields.payoutAmount),
        recipient: fields.recipient,
        month_key: String(fields.monthKey),
        contract_address: fields.contractAddress,
        chain_id: String(fields.chainId),
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`RATER_HTTP_${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// Returns { payload_hash, signature, signer, source: 'protosure' }, or throws
// RaterUnavailableError — callers (routes/attestation.js) fall back to protosure/stub.js per
// ATTESTATION_FALLBACK, stamping the source themselves.
export async function sign(fields, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  let body;
  try {
    body = await signOnce(fields, fetchImpl, timeoutMs);
  } catch (firstErr) {
    try {
      body = await signOnce(fields, fetchImpl, timeoutMs); // one retry (R-19)
    } catch (secondErr) {
      throw new RaterUnavailableError(secondErr.message);
    }
  }

  const calc = body?.calculation;
  if (!calc || typeof calc.signature !== 'string' || typeof calc.payload_hash !== 'string' || typeof calc.signer !== 'string') {
    throw new RaterUnavailableError('malformed rater response — missing calculation.{payload_hash,signature,signer}');
  }
  const registeredSigner = String(process.env.REGISTERED_SIGNER || '').toLowerCase();
  if (calc.signer.toLowerCase() !== registeredSigner) {
    throw new RaterUnavailableError('rater signer does not match REGISTERED_SIGNER');
  }
  if (sigByteLength(calc.signature) !== 65) {
    throw new RaterUnavailableError('rater signature is not 65 bytes');
  }

  return { payload_hash: calc.payload_hash, signature: calc.signature, signer: calc.signer, source: 'protosure' };
}
