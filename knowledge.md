# knowledge.md

A living record of **business-logic learnings** about Kazoku Pulse — confirmed facts, gotchas,
and decisions discovered while building, that aren't obvious from reading the code once. This is
distinct from `CLAUDE.md` (static architecture map / dev commands): this file grows over time.
See `CLAUDE.md`'s "Knowledge base" section for the read/update rule Claude Code follows.

## Payout schedule & rules (`src/attestation-rules.js`, `src/coverage.js`)

- Fixed schedule is per `triggerCode`, not client-suppliable: PT-01 ¥3,000 · PT-02 ¥30,000 ·
  PT-03 ¥20,000 · PT-04 ¥10,000 · PT-05 ¥1,000 (fraud-reward). **PT-06 (settlement) is the one
  exception** — it has no fixed amount; the caller supplies the actual netted settlement credit.
- PT-01 has a monthly cool-down: max 2 per `monthKey` (`PT01_MONTHLY_COUNT_CAP`), counted from
  existing `attestations` rows, not `cap_ledger`.
- Monthly caps (`MONTHLY_CAP` in `src/coverage.js`) are a **local pre-check only**, read from
  `cap_ledger` (rows with status `reserved`/`confirmed`). The on-chain contract enforces the real
  cap independently via `monthSpend` — the local check exists purely to avoid a wasted gas-costing
  round-trip, not as the source of truth.
- `month_key` is always `YYYYMM` derived in **Asia/Tokyo**, regardless of the server host's
  timezone (`monthKeyTokyo()` in `src/attestation-rules.js` — moved here from
  `routes/attestation.js` so `routes/payments.js` can import it too, without a circular
  dependency; see the "Mendix→Protosure direct" section below) — matters because Render's default
  host timezone is UTC, and Tokyo is UTC+9, so a payout near local midnight could land in the
  wrong month-key bucket if this weren't pinned explicitly.

## Mendix→Protosure-direct attestation flow (`POST /v1/jpyc/preTransferHash`)

- **Scope change (2026-07-29): Mendix now calls Protosure directly for the attestation itself.**
  This service no longer signs via `protosure/rater-client.js` for that flow — `POST
  /v1/attestation/trigger` (this service asks Protosure/stub to sign) still exists for other
  callers, but is a separate, still-valid path. `preTransferHash` is the new step in between:
  Mendix already has a Protosure-signed attestation and hands it to us to verify + persist before
  calling the unchanged `POST /v1/jpyc/transfer` to execute it on-chain.
- **Deterministic rules still own the money even here** — `validateRules()` runs against the
  incoming `coverage_code`/`payout_amount` exactly as it does for `/v1/attestation/trigger`,
  despite Protosure having already attested it. This was a deliberate design decision (not an
  oversight): an external attestation is not itself sufficient authorization by this repo's
  architecture ("Claude never gates money" — and neither does an unverified external service).
- **The attester's signature is independently re-verified, not trusted as a channel-authenticated
  blob.** Unlike the live-rater path (`rater-client.js`, which trusts an HTTPS+Basic-auth call
  *we* made), Mendix relays the attestation to us over a channel we don't control — so this
  endpoint recomputes the canonical digest via `protosure/stub.js#computeInner` (the same function
  `MimamorParametric.sol`/the offline stub use) and calls `ethers.recoverAddress(digest,
  signature)`, rejecting on any mismatch (`PAYLOAD_HASH_MISMATCH`, `SIGNATURE_SIGNER_MISMATCH`) —
  never a bare string comparison of the given fields.
- **`coverage_code` arrives as the on-chain hex byte** (e.g. `"0x01"`), not the human `triggerCode`
  (`"PT-01"`) — reverse-mapped via `COVERAGE_CODE` since every local rule is keyed by
  `triggerCode`. An unrecognized byte is `400 UNKNOWN_COVERAGE_CODE`, not a 422 rule failure.
- **`attester.nonce` is a separate value from `trigger_ref`, not an alias for it** — confirmed by
  the request author, not derived independently. It's stored in a new `attestations.attesterNonce`
  column (Protosure's own signing-scheme nonce, for audit only); `trigger_ref` remains the sole
  on-chain dedup key (`usedNonce[triggerRef]` in `MimamorParametric.sol`), exactly as before this
  endpoint existed.
- **`oracle`/`oracleSig` in the response are metadata, not a second cryptographic signature** —
  confirmed by the request author. `oracle` echoes this service's own configured signer identity
  (`REGISTERED_SIGNER`) for audit purposes; `oracleSig` is always `null`. Only the attester's
  (Protosure's) signature actually authorizes `submitTrigger` on-chain — `MimamorParametric.sol`
  has no dual-signature verification and none was added for this endpoint.
- **`amountWei` is not wei-scaled** — confirmed by the request author. It's `payoutAmount`
  unchanged, under a Wei-sounding field name only. This repo's `DemoJPYC.sol` is hardcoded to
  `decimals() == 0` (whole-JPY units); a real 18-decimal token would be a much wider change than
  this one endpoint, not something to infer from a single field name.
- `contract_address`/`chain_id` are cross-checked against this deployment's `PAYOUT_ADDR`/
  `CHAIN_ID` **before** any digest/signature work, specifically to fail fast with a clear error
  rather than let a cross-network/cross-contract mismatch surface later as a wasted, gas-costing
  on-chain revert.

## Signature digest (`src/protosure/stub.js`, `MimamorParametric.sol`)

- The digest is a packed-encoding hash over exactly 8 fields in this order: `triggerRef`
  (keccak of the UTF-8 trigger ref string), `policyId` (keccak of the UTF-8 policy id string),
  `coverageCode` (1 byte), `payoutAmount` (uint256), `recipient` (address), `monthKey` (uint256),
  `contractAddress` (address), `chainId` (uint256) — then EIP-191-prefixed
  (`"\x19Ethereum Signed Message:\n32" || inner`) before signing/recovery.
- **Sign with `ethers.SigningKey(...).sign(digest)`, never `wallet.signMessage(...)`** —
  `signMessage` applies its own EIP-191 prefix on top of the digest, double-prefixing and
  producing a signature the contract can't recover correctly. This was a real bug caught during
  the S1-S4 rewrite (see `FamPulse_API_Sync_Changes.md`).
- Golden reference vector (confirmed against the real Protosure rater, used as the test fixture
  in `test/protosure-stub.test.js` and `test/chain/MimamorParametric.test.js`): inputs
  `{policy_id:"KP-2026-001", trigger_ref:"TRG-0001", coverage_code:"0x01", payout_amount:"3000",
  recipient:"0x742d35Cc6634C0532925a3b8D4C9C0f25B4f2F9a", month_key:"202608",
  contract_address:"0x5FbDB2315678afecb367f032d93F642f64180aa3", chain_id:"43113"}` →
  `payload_hash = 0xc1b318da13d253576a3a51eb16289aa9ab31141cd8d3acd003049c087a77fd4d`, signature
  recovers to `0x2c7536e3605d9c16a7a3d7b1898e529396a65c23`.
- `MimamorParametric.submitTrigger` has **no `msg.sender` restriction** — any wallet can relay a
  validly-signed payload. That's why `STUB_SIGNER_PRIVATE_KEY` can double as both the offline
  stub-signing key and the on-chain relayer wallet without those two roles conflicting.

## Protosure rater wire contract — superseded once already, verify before trusting either doc

- `FamPulse_API_Sync_Changes.md` (audited 2026-07-22, S4) describes an **earlier, now-wrong**
  shape: bearer-token auth (`PROTOSURE_API_TOKEN`), a flat `data` payload, and a response keyed
  `calculation`.
- The **current, live-verified** contract (confirmed against a real `calculate_data` call on
  2026-07-25 — see the header comment in `src/protosure/rater-client.js`) is different: HTTP
  Basic auth (`PROTOSURE_USERNAME`/`PROTOSURE_PASSWORD`, tenant login — no bearer token), the
  eight fields nested under a top-level `"data"` key, and the signed fields nested under
  `"raterData"` in the response (plus an ignored `"chartsData"` object).
- Lesson: this wire contract has already drifted once between "spec doc" and "verified against a
  live call." Treat `.env.example` + `src/protosure/rater-client.js`'s header comment as the
  current source of truth over any older sync/brief doc, and re-verify against a live call before
  trusting either if the rater's behavior seems to have changed again.

## Fallback & fail-safe behavior

- `ATTESTATION_FALLBACK` (`stub` | `fail`) governs what happens when the live Protosure rater is
  unreachable or returns an invalid response (wrong signer, wrong signature length, malformed
  body). On fallback, the resulting attestation is stamped `source: "stub-fallback"` — this is
  **surfaced to judges deliberately**, not hidden, so a demo run can be audited for whether a real
  or a fallback signature produced a given payout.
- A demo reset (`wipe()` in `src/db.js`) never touches `wallets` or `cap_ledger`. Rationale:
  `wallets` holds on-chain contract addresses that persist across resets by design; `cap_ledger`
  mirrors on-chain `monthSpend`, which a reset also can't touch — wiping the local ledger without
  the chain state would let the local cap pre-check drift out of sync with on-chain reality.

## Geo-fence config propagation

- The geofence engine (`src/geofence.js`) re-reads config on every tick — it does not cache config
  at boot. A radius change mid-dwell has an immediate effect: shrinking the radius can create a
  new WANDERING incident on the very next tick; enlarging it can resolve an in-progress dwell (and
  closes an already-active incident with a `resolved: geofence enlarged` timeline entry).
- `configVersion` is bumped on every `PATCH /v1/policy/monitoringConfig` and threaded through every
  telemetry frame (including the `sharingEnabled:false` short frame) so the Parent app can detect
  a stale config and re-fetch, rather than polling on a timer.

## Device activation & household identity (`src/routes/activation.js`, `src/auth.js`, `src/db.js`)

- **`householdId` and `parentId` are 1:1 and interchangeable for this demo.** Every parentId-keyed
  table (`metrics`, `frs_history`, `incidents`, `care_requests`, `settlements`) got an additional,
  denormalized `householdId` column (backfilled `= parentId`), but `parentId` itself was never
  removed and no existing route's SQL was rewritten to filter on `householdId`. The seed
  household's `householdId` literally reuses the `DEFAULT_PARENT_ID` string (`yoshiko-001`) so the
  mapping needs no lookup table. If a future feature ever needs a household with *multiple* insured
  parents, this 1:1 assumption breaks and `getParentId`/`req.household.parentId` would need to
  become a real one-to-many resolution — it currently is not.
- **`requireDevice` (src/auth.js) is additive, not a replacement for query/body `parentId`.** A
  request with no `Authorization: Bearer <deviceToken>` header behaves exactly as it did before
  activation existed (`getParentId` falls through to `req.query.parentId` → `DEFAULT_PARENT_ID`).
  This was a deliberate choice to avoid rewriting every route's scoping logic and to keep the
  entire pre-activation test suite and demo runbook green — do not assume every route requires a
  device token; only the routes gated by `requireRole(...)` reject on a *wrong* role, and only when
  a token is actually presented.
- **Protosure policy-verification auth is unconfirmed.** `src/protosure/policy-verify.js` uses
  bearer `PROTOSURE_API_TOKEN` per the activation build plan's spec, but the *existing* rater
  endpoint (`calculate_data`) was originally specced the same bearer-token way and turned out, once
  verified against a live call, to use HTTP Basic auth instead (see the "Protosure rater wire
  contract" section above). This exact assumption has already been wrong once for a sibling
  endpoint — treat the bearer-token auth and the `FIELD_MAP` response field names in
  `policy-verify.js` as unconfirmed guesses, and re-verify both against a live Protosure call
  before trusting them, same as the rater endpoint's lesson.
- **Reconciliation is a wiring stub, not a live integration.** `reconcileHousehold()` in
  `activation.js` is guarded behind `ACTIVATION_MODE=protosure` and called from a periodic
  `setInterval` in `server.js`, but it currently only logs — there is no confirmed Protosure
  contract for "look up a policy by customerId alone" (the four original credentials are
  deliberately never retained past the verify call, per the "never store raw DOB/phone/email"
  rule, so a full re-verify isn't possible for a background job). Implement the real call here once
  that contract exists; don't assume it already reconciles anything today.
- **Masked DOB is a constant placeholder, not a partial real date.** `GET /v1/household/:id`
  returns `insuredDobMasked: '**-**-**'` always — the raw DOB is never stored (only
  `insuredDobHash`, a one-way HMAC), so there are no real digits available to partially reveal.
- Device tokens are opaque HMAC-SHA256 strings (`node:crypto`, no JWT library), verified by
  looking up `sha256(token)` against `devices.deviceTokenHash` — the HMAC at generation time binds
  the token to its `deviceId` but isn't re-derived at auth time, it's a lookup-by-hash.
- The activation lock (R-21) uses a single `ACTIVATION_LOCK_MINUTES` knob as both the
  failure-counting window and the lock duration (a sliding window), rather than the build plan's
  separate "trailing hour" count vs. lock-duration language — simpler and the lock still
  naturally "expires" once the oldest counted failure ages out of that same window.
