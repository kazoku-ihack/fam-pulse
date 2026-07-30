# knowledge.md

A living record of **business-logic learnings** about Kazoku Pulse — confirmed facts, gotchas,
and decisions discovered while building, that aren't obvious from reading the code once. This is
distinct from `CLAUDE.md` (static architecture map / dev commands): this file grows over time.
See `CLAUDE.md`'s "Knowledge base" section for the read/update rule Claude Code follows.

## Render deployment (`render.yaml`)

- **`REGISTERED_SIGNER` is tied 1:1 to whichever contract `PAYOUT_ADDR` currently points at** —
  it's whatever address was actually given `setSigner(..., true)` on that specific
  `MimamorParametric` deployment (`src/chain/deploy.js`), not a fixed constant. Until 2026-07-29 it
  was hardcoded as a non-secret value in `render.yaml`; when `PAYOUT_ADDR` was redeployed to a new
  contract with a different registered signer, `REGISTERED_SIGNER` silently kept the old value —
  every signer check (`isRegisteredOnChain` in `GET /v1/attestation/signer/current`, the
  `SIGNER_NOT_REGISTERED` gate in `POST /v1/jpyc/preTransferHash`) failed until this was caught
  manually. Now `sync: false` alongside `JPYC_ADDR`/`PAYOUT_ADDR`, same rationale.
- **Render env var changes don't reliably take effect via a plain `restart`** — observed directly:
  updating env vars through the Render API and calling `POST /services/:id/restart` left the
  running process still reading the old values (confirmed via a live on-chain error still
  referencing the pre-update contract address). A full `POST /services/:id/deploys` (same commit,
  fresh container) was required before the new env vars actually took effect. Prefer a real deploy
  over a bare restart when verifying an env var change actually landed.
  - Note: the `SIGNER_NOT_REGISTERED` gate this bullet originally referenced in
    `POST /v1/jpyc/preTransferHash` was removed 2026-07-30 (see "Mendix→Protosure-direct
    attestation flow" below) — `REGISTERED_SIGNER` drift is still real for
    `GET /v1/attestation/signer/current` and the live-rater path, just no longer for this endpoint.

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
  Mendix already has a Protosure-signed attestation and hands it to us to persist before calling
  the unchanged `POST /v1/jpyc/transfer` to execute it on-chain.
- **Scope change (2026-07-30): local rule validation and signature re-verification were removed
  from this endpoint at the requester's explicit direction** — Mendix now validates against
  Protosure separately, upstream, and `preTransferHash`/`transfer` are called sequentially trusting
  that upstream result. This reverses the 2026-07-29 design decision below it used to make
  (`validateRules()` no longer runs here). The `contract_address`/`chain_id` cross-checks against
  `PAYOUT_ADDR`/`CHAIN_ID` were deliberately kept (out of scope of that direction — they're
  deployment sanity checks, not attestation validation). `validateRules()` is still very much in
  force on `POST /v1/attestation/trigger` and the live-rater path (`rater-client.js`) — this change
  is scoped to the Mendix-direct endpoint only; don't assume it generalizes elsewhere in the payout
  path without checking.
- **Scope change (2026-07-30, later same day): attester verification was partially reinstated, but
  checks the `attester.signer` field directly — not an ECDSA recovery.** `preTransferHash` requires
  `attester.signer.toLowerCase() === expectedSigner`, where `expectedSigner = ATTESTER_ADDRESS ||
  REGISTERED_SIGNER` — **`ATTESTER_ADDRESS` is referred to first**, confirmed explicitly by the
  request author; `REGISTERED_SIGNER` is a fallback only, for deployments that haven't set
  `ATTESTER_ADDRESS` yet (they're the same value, `0x2c75...`, in this deployment today, but
  conceptually distinct — `ATTESTER_ADDRESS` is the Rider contract's own expected attester,
  `REGISTERED_SIGNER` is `MimamorParametric`'s registered signer). Missing both env vars fails
  safe: `503 ATTESTER_ADDRESS_NOT_CONFIGURED`. A mismatch is `422 ATTESTER_ADDRESS_MISMATCH`.
  - **An earlier version of this check (same day) instead did `ethers.recoverAddress(payload_hash,
    signature)` and compared the recovered address** — reverted at the request author's explicit
    instruction to check `attester.signer` directly instead. Rationale, confirmed live during the
    "bad attester sig" investigation below: recovery only proves the signature is self-consistent
    with whatever `payload_hash` Protosure computed — it says nothing about whether that digest
    matches what the Rider contract reconstructs on-chain, so it bought no real assurance while
    looking more rigorous than it was. `attester.signer` is simply the field Protosure sends and
    is what's actually checked now; the persisted `attestations.signer` column and the response's
    `attester` field both echo it verbatim (not a recovered value).
  - `validateRules()` (fixed schedule / cool-down / cap) is still **not** re-run by any version of
    this check — signer/attester verification and rules validation are separate concerns; see the
    2026-07-30 (earlier) bullet above.
- **`coverage_code` arrives as the on-chain hex byte** (e.g. `"0x01"`), not the human `triggerCode`
  (`"PT-01"`) — reverse-mapped via `COVERAGE_CODE` since every local rule is keyed by
  `triggerCode`. An unrecognized byte is `400 UNKNOWN_COVERAGE_CODE`, not a 422 rule failure.
- **`attester.nonce` is a separate value from `trigger_ref`, not an alias for it** — confirmed by
  the request author, not derived independently. It's stored in a new `attestations.attesterNonce`
  column (Protosure's own signing-scheme nonce, for audit only); `trigger_ref` remains the sole
  on-chain dedup key (`usedNonce[triggerRef]` in `MimamorParametric.sol`), exactly as before this
  endpoint existed.
- **`oracle`/`oracleSig` in the `preTransferHash` *response* are still just metadata, always
  `null`/`REGISTERED_SIGNER`-echo** — nothing changed here by the 2026-07-30 Rider addition below.
  The *real* `oracleSig` used on-chain doesn't exist yet at `preTransferHash` time; it's produced
  fresh at `POST /v1/jpyc/transfer` time (see next bullet), against a completely different signer
  (`ORACLE_SIGNER_PRIVATE_KEY`, not `REGISTERED_SIGNER`). Don't confuse the two `oracleSig`s.
- **Scope change (2026-07-30): `POST /v1/jpyc/transfer` now calls a different, externally-deployed
  "Rider" contract for `source:"protosure-direct"` attestations only**, because that contract's
  `submitTrigger` verifies *two* signatures (`oracleSig`, `attesterSig` — independently, over
  different digests each, see the 2026-07-30 update below), unlike `MimamorParametric.sol`'s
  single `signature` param — confirmed by the request author, not
  derivable from this repo (Rider's Solidity source isn't here; only the ABI fragment
  `src/chain/chain.js#RIDER_ABI` is, hand-written from the confirmed function signature). Mechanics:
  - Routing is keyed on the stored `attestations.source` column, checked in
    `executePayoutOnChain`/`isChainReadyFor` (`src/routes/payments.js`) — `'protosure-direct'` (only
    ever set by `preTransferHash`) → `chain.getRiderContract()` at `RIDER_ADDR`; every other source
    (`stub`/`protosure`/`stub-fallback`, from `POST /v1/attestation/trigger`) → unchanged
    `chain.getPayoutContract()` at `PAYOUT_ADDR`.
  - `attesterSig` is exactly `attestations.signature` (Protosure's, stored verbatim at
    `preTransferHash` time, never regenerated) — **it is trusted as-is and never re-verified or
    re-derived by this service.** `src/protosure/stub.js`'s `computeInner`/`signInner` are not part
    of this path at all (they remain in use only for the older `MimamorParametric` flow via
    `POST /v1/attestation/trigger`) — don't assume attesterSig verifies against anything this repo
    computes.
  - **Update (2026-07-30, supersedes the "identical digest" note below): `oracleSig` and
    `attesterSig` are two independently-computed digests, not a shared one** — confirmed by the
    request author. `oracleSig` is generated **fresh at transfer time** in
    `executePayoutOnChain` (`src/routes/payments.js`) over a digest built specifically for it:
    `evidenceHash = keccak256(triggerRef)`, then
    `inner = keccak256(AbiCoder.encode(['address','uint256','bytes32','address','uint256','uint256'], [riderAddr, chainId, evidenceHash, recipient, incidentTimestamp, amount]))`
    (`riderAddr` = `RIDER_ADDR || PAYOUT_ADDR`), then EIP-191-wrapped via `ethers.hashMessage` and
    signed with `ORACLE_SIGNER_PRIVATE_KEY` via `signDigest()`. `amount` is **unscaled**
    (`BigInt(payoutAmount)`, no decimals) — see the `amountWei` bullet below, same rule applies
    here. Rider's `submitTrigger` is expected to verify the two signatures independently, not
    against one shared digest.
  - `contract_address` in the `preTransferHash` request body is still checked against `PAYOUT_ADDR`,
    **not** `RIDER_ADDR` — confirmed by the request author, even though the actual on-chain call at
    transfer time targets Rider (and the oracle digest above binds to `RIDER_ADDR`/`PAYOUT_ADDR`
    fallback, separately). These are deliberately two different checks on two different digests now
    — not a gap to reconcile.
  - Missing `ORACLE_SIGNER_PRIVATE_KEY` fails safe: `503 ORACLE_SIGNER_NOT_CONFIGURED` from
    `/v1/jpyc/transfer`, same fail-safe pattern as `CHAIN_NOT_CONFIGURED` elsewhere — see
    `OracleSignerNotConfiguredError` in `src/routes/payments.js`.
  - **Live-verified finding (2026-07-30, Render logs on `fam-pulse-api`, `[chain] payout submission
    failed: bad attester sig`)**: on every real `/v1/jpyc/transfer` attempt for a `protosure-direct`
    attestation so far, Rider's on-chain revert reason has been consistently `bad attester sig`,
    **never** `bad oracle sig` — i.e. the oracle digest formula above is confirmed correct (Rider
    accepts it), but Protosure's `attesterSig` fails Rider's on-chain attester check every time.
    Likely cause: Rider's `submitTrigger` receives no digest/hash argument for `attesterSig` to be
    checked against directly — it must reconstruct whatever digest it verifies purely from
    `(evidenceHash, beneficiary, incidentTimestamp, amount)` plus its own address/chain id, the same
    way this service derives the oracle digest above. If Protosure is still signing attestations
    against a different digest (e.g. the older `policyId`/`coverageCode`/`monthKey`/`PAYOUT_ADDR`-
    bound `computeInner` scheme — see the "Signature digest" section below), that signature is
    valid but for the wrong message, so on-chain `ECDSA.recover` returns some other address and the
    registered-attester check fails. **Not fixable in this repo alone** — `attesterSig` is produced
    by Protosure, not this service, and is trusted verbatim (see above). Needs either (a) Protosure
    signing attestations against the same evidence-based digest formula confirmed working for
    `oracleSig`, or (b) the real Rider Solidity source, to confirm the actual digest scheme it
    expects for `attesterSig` if it's genuinely different from the oracle one.
  - **Root cause CONFIRMED (2026-07-30), not just hypothesized**: added a temporary diagnostic log
    to `preTransferHash` (`[preTransferHash] diagnostic`, since removed — see the
    `RIDER_FALLBACK_ADDR` bullet below for why it's no longer needed), captured two real Mendix
    calls, and recomputed `protosure/stub.js#computeInner`'s digest offline for each using the
    logged fields. Call #2 (`trigger_ref:"TRG-004-20260730-22"`, `monthKey="202607"`) matched
    `attester.payload_hash` **exactly, byte-for-byte**. Protosure is signing the classic
    `MimamorParametric` digest (this repo's own `computeInner`), not whatever Rider reconstructs
    on-chain — confirmed, not a guess. `RIDER_ADDR` and `PAYOUT_ADDR` were also confirmed to be the
    *same* deployed address at the time of this test, so it isn't a contract-address-binding issue
    either — it's a genuinely different field/digest structure. A read-only `staticCall` of the old
    single-sig `submitTrigger`/`isRegisteredSigner` selectors directly against that address both
    reverted with empty returndata (selector not found) — the deployed Rider contract is not a
    superset/backward-compatible `MimamorParametric`, it's a genuinely different contract; there is
    no way to reach the old code path at that address.
  - **Workaround shipped (2026-07-30): `RIDER_FALLBACK_ADDR`** — a freshly-deployed, *unmodified*
    `MimamorParametric.sol` (this repo's own contract, via the one-off
    `src/chain/deploy-rider-fallback.js`, NOT the primary `deploy.js`), wrapping the **real,
    externally-deployed `JPYC_ADDR` token** (`"Mock JPY Coin"`, confirmed **18 decimals** — NOT
    this repo's 0-decimal `DemoJPYC`, a real mismatch if the two token families are ever mixed)
    instead of minting a new one, funded directly from the relayer wallet's existing balance (it
    already held ~937,000 tokens). `REGISTERED_SIGNER` (`0x2c75...`) is registered as an authorized
    signer on this fallback contract — since that's exactly the digest/signer Protosure's real
    output already matches, transfers against it succeed for real, are relayer-gas-paid, and are
    visible on Snowtrace, without needing anything from Protosure or Rider's owner. Routing
    (`isChainReadyFor`/`executePayoutOnChain` in `src/routes/payments.js`): if
    `RIDER_FALLBACK_ADDR` is set, `protosure-direct` attestations go through
    `chain.getRiderFallbackContract()` with the plain single-sig `submitTrigger` (same shape as the
    non-`protosure-direct` path — no `oracleSig`, no `ORACLE_SIGNER_PRIVATE_KEY` needed for this
    branch) instead of the dual-sig Rider path; unset (default), behavior is unchanged from before
    this bullet. **Caveat**: `amountJpy` still moves unscaled (see the `amountWei` bullet below)
    against an **18-decimal** token here — e.g. `payout_amount=30000` moves `30000` raw units =
    `0.00000000000003` tokens, a real but dust-sized transfer. Fine for proving the pipeline
    produces a genuine, mined, Snowtrace-visible transaction; not fine if a JPY-equivalent amount
    ever needs to actually move — would need the fallback contract modified to scale by decimals
    (careful: `amountJpy` is part of what `attesterSig`'s digest covers, so scaling must happen
    only at the `jpyc.transfer()` call site, never touch the digest-input value). This is a
    stopgap, not a fix for the real Rider integration — revert to the Rider path by unsetting
    `RIDER_FALLBACK_ADDR` once Protosure/Rider's actual digest mismatch is reconciled upstream.
  - **Repeatable rehearsal script: `src/chain/rehearse-protosure-direct.js`** — drives the real
    `POST /v1/jpyc/preTransferHash` → `POST /v1/jpyc/transfer` HTTP flow against a live deployment
    end-to-end, signing with the registered rehearsal signer (`STUB_SIGNER_PRIVATE_KEY`'s address)
    since this repo doesn't hold Protosure's real key. Two things a naive rehearsal script gets
    wrong (confirmed by hitting both live): (1) the claimed `attester.signer` field must equal
    `ATTESTER_ADDRESS` — checked directly, not by recovery, so this is set explicitly rather than
    derived from the signing key; (2) the digest itself must bind to whatever contract actually
    verifies it on-chain (`RIDER_FALLBACK_ADDR`, via `computeInner`'s `contractAddress` param) —
    **not** `PAYOUT_ADDR`, even though the request body's separate `contract_address` field must
    still be `PAYOUT_ADDR` to pass `CONTRACT_ADDRESS_MISMATCH`. Confirmed live: signing against
    `PAYOUT_ADDR` (matching the request body) produced `502 SIGNER_MISMATCH` — recovers to a
    different address than intended once the real fallback contract recomputes its own digest with
    its own `address(this)`. Each run generates a fresh `trigger_ref` so repeats never collide on
    `NONCE_ALREADY_USED`.
  - **`POST /v1/jpyc/rehearseTransfer`** (`src/routes/payments.js`) — the same rehearsal flow as an
    API endpoint instead of a standalone script, requested explicitly so it could be triggered
    without needing local env values at all. Deliberately accepts only one input,
    `attestationId` (optional) — every signing detail (`STUB_SIGNER_PRIVATE_KEY`,
    `RIDER_FALLBACK_ADDR`/`RIDER_ADDR`/`PAYOUT_ADDR`, `ATTESTER_ADDRESS`/`REGISTERED_SIGNER`,
    `CHAIN_ID`) is read from server-side env at request time, and the generated attestation is
    always PT-01/¥3,000 to the seeded `sakura` wallet (`SAKURA_WALLET_ADDR`) — so this can't be
    used to mint an attestation for an arbitrary amount/recipient/coverage code. Mounted under
    `/v1/jpyc/*` (requires `x-api-key`, same as `preTransferHash`/`transfer`), **not**
    `/v1/demo/*` — `/v1/demo/*` is mounted before `apiKeyAuth` (so the public Judge Console can
    reach it with no key at all), which would be the wrong gate for a route that moves real funds.
    Shares its actual on-chain submission logic (`performTransfer`) with `POST /v1/jpyc/transfer`
    — refactored out of that route rather than duplicated, since this made a third near-identical
    caller.
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
