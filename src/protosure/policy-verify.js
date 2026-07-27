// Real Protosure policy-verification client for ACTIVATION_MODE=protosure. Mirrors the
// rater-client.js/stub.js split used by attestation: one interface — verifyPolicy(...) returning
// exactly { customerId, originalQuoteId, smartContractId, policyStatus, insuredDisplayName,
// coverages } or throwing NoMatchError/UpstreamError — with the mode choice made by the caller
// (src/routes/activation.js), not by this module.
//
// AUTH CAVEAT (unconfirmed against a live call): this uses bearer PROTOSURE_API_TOKEN per the
// activation build-plan spec. The existing rater endpoint (src/protosure/rater-client.js) was
// originally specced the same way (see FamPulse_API_Sync_Changes.md) but the real integration
// turned out to use HTTP Basic auth instead once verified against a live call — see knowledge.md.
// Policy-verification may be a different API surface with different auth; re-verify this before
// trusting it, same lesson as the rater endpoint. Auth header construction is isolated in
// authHeader() below so a swap (e.g. to Basic auth) only touches one function.
//
// FIELD_MAP names are the tenant's response field names — confirm with Protosure; likely to
// differ from this guess, same caveat the build plan itself calls out.
const FIELD_MAP = {
  customerId: 'customer_id',
  originalQuoteId: 'original_quote_id',
  smartContractId: 'smart_contract_id',
  policyStatus: 'policy_status',
  insuredName: 'insured_name',
  coverages: 'coverages',
};

export class NoMatchError extends Error {
  constructor(message) {
    super(message);
    this.code = 'AUTH_NO_MATCH';
  }
}

export class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.code = 'PROTOSURE_UNAVAILABLE';
  }
}

function authHeader() {
  return `Bearer ${process.env.PROTOSURE_API_TOKEN || ''}`;
}

async function verifyOnce(fields, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`${process.env.PROTOSURE_BASE_URL}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: authHeader(),
      },
      body: JSON.stringify({
        policy_number: fields.policyNumber,
        insured_dob: fields.insuredDob,
        phone: fields.phone,
        email: fields.email,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`POLICY_VERIFY_HTTP_${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// fields must already be normalised (src/activation-normalise.js) by the caller.
export async function verifyPolicy(fields, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  let body;
  try {
    body = await verifyOnce(fields, fetchImpl, timeoutMs);
  } catch (firstErr) {
    try {
      body = await verifyOnce(fields, fetchImpl, timeoutMs); // one retry, matching rater-client.js's R-19 pattern
    } catch (secondErr) {
      throw new UpstreamError(secondErr.message);
    }
  }

  // Any response that isn't an exact single-policy match is a NoMatchError — no fuzzy matching,
  // per the build plan. A results array with !== 1 entries covers "zero results" and "multiple
  // results"; a single result with a non-in_force status is also treated as no-match.
  const results = Array.isArray(body?.results) ? body.results : body?.result ? [body.result] : [];
  if (results.length !== 1) {
    throw new NoMatchError('policy-verification did not return an exact single-policy match');
  }
  const r = results[0];
  const policyStatus = r[FIELD_MAP.policyStatus];
  if (policyStatus !== 'in_force') {
    throw new NoMatchError('matched policy is not in force');
  }

  return {
    customerId: r[FIELD_MAP.customerId],
    originalQuoteId: r[FIELD_MAP.originalQuoteId],
    smartContractId: r[FIELD_MAP.smartContractId],
    policyStatus,
    insuredDisplayName: r[FIELD_MAP.insuredName],
    coverages: r[FIELD_MAP.coverages] || [],
  };
}
