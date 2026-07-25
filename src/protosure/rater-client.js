// Sign-only Protosure rater client. Rule validation (fixed schedule, cool-downs, cap headroom)
// lives in src/attestation-rules.js and applies identically regardless of which signer produces
// the signature — the rater's only job is to sign the canonical digest.
//
// Field/response shape confirmed against the real rater's golden reference vector (see
// FamPulse_API_Sync_Changes.md and test/protosure-stub.test.js) — not a guess.
//
// Wire contract verified against a live calculate_data call on 2026-07-25: the rater expects the
// eight fields nested under a top-level "data" key, authenticates via HTTP Basic (tenant
// username/password — no bearer token), and replies with the signed fields nested under
// "raterData" (plus a "chartsData" object this client ignores) rather than "calculation".

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

function basicAuthHeader() {
  const user = process.env.PROTOSURE_USERNAME || '';
  const pass = process.env.PROTOSURE_PASSWORD || '';
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
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
        authorization: basicAuthHeader(),
      },
      body: JSON.stringify({
        data: {
          policy_id: fields.policyId,
          trigger_ref: fields.triggerRef,
          coverage_code: fields.coverageCode,
          payout_amount: String(fields.payoutAmount),
          recipient: fields.recipient,
          month_key: String(fields.monthKey),
          contract_address: fields.contractAddress,
          chain_id: String(fields.chainId),
        },
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`RATER_HTTP_${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// Returns { payload_hash, signature, signer, nonce, source: 'protosure' }, or throws
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

  const calc = body?.raterData;
  if (!calc || typeof calc.signature !== 'string' || typeof calc.payload_hash !== 'string' || typeof calc.signer !== 'string') {
    throw new RaterUnavailableError('malformed rater response — missing raterData.{payload_hash,signature,signer}');
  }
  const registeredSigner = String(process.env.REGISTERED_SIGNER || '').toLowerCase();
  if (calc.signer.toLowerCase() !== registeredSigner) {
    throw new RaterUnavailableError('rater signer does not match REGISTERED_SIGNER');
  }
  if (sigByteLength(calc.signature) !== 65) {
    throw new RaterUnavailableError('rater signature is not 65 bytes');
  }

  return { payload_hash: calc.payload_hash, signature: calc.signature, signer: calc.signer, nonce: calc.nonce, source: 'protosure' };
}
