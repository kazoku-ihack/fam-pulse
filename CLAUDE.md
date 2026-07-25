# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Kazoku Pulse — a single deployable Node.js/Express backend for a hackathon demo: elder wellness
scoring (FRS), geo-fence wandering detection with a Claude triage layer, 助けて! SOS, simulated
taxi dispatch, a care-request loop with real Claude email parsing, and a parametric attestation
→ on-chain JPYC payout path on Avalanche Fuji testnet. `Kazoku_Pulse_Demo_Build_Brief.md` is the
full spec this implements; `FamPulse_API_Sync_Changes.md` documents the real Protosure rater's
wire contract as confirmed against a live call.

## Commands

```bash
npm install
cp .env.example .env        # edit API_KEY at minimum
npm test                    # node --test test/*.test.js — offline, no credentials needed
npm run compile              # compiles src/chain/contracts via hardhat
npm run test:chain           # hardhat test against a local Hardhat node (needs `npm run compile` first)
npm start                    # boots on :3000, seeds SQLite on first run
```

Run a single test file: `node --test test/attestation.test.js`. Run a single test by name:
`node --test test/attestation.test.js --test-name-pattern="fixed-schedule"`.

Everything above works with **zero external credentials**. Every real integration (Anthropic
Claude, ethers signing, SMTP/IMAP, Protosure) is env-gated — unset, it falls back to a
deterministic local path so the offline test suite never depends on a live network call. See the
table in `README.md` for what each env var unlocks and its specific fail-safe behavior.

`test/helpers.js` forces `ATTESTATION_MODE=stub` and a fixed golden-vector `STUB_SIGNER_PRIVATE_KEY`
for every test regardless of local `.env`, so tests stay deterministic even when the developer has
real Protosure credentials configured locally. `test/attestation-fallback.test.js` is the
exception — it overrides this per-test (via `withEnv`) to exercise the live-rater fallback path.

## Architecture

**Request flow.** `src/server.js` wires everything: CORS → JSON body parsing (raw body kept on
`req.rawBody` for HMAC verification) → rate limiting → the Uber webhook router (HMAC-authenticated,
mounted before `apiKeyAuth` since a real provider callback can't carry our internal key) → the
Judge Console's `/v1/demo/*` routes (gated by optional `JUDGE_KEY`, also mounted before
`apiKeyAuth` since the static console page has no server-side secret holder) → `apiKeyAuth` →
every other `routes/*` router. Route modules are factories: `xRouter(db, deps)` — `deps` lets
tests inject a fake chain/attestation/care/payments implementation without touching the network.

**Layering rule — Claude never gates money.** `src/routes/attestation.js`, `src/routes/payments.js`,
`src/protosure/*`, and `src/chain/*` import nothing from `src/claude/*`. The two Claude modules
(`src/claude/wandering-triage.js`, `src/claude/frs-review.js`) only shape alert severity and
review reasoning — every void or downgrade they produce is an auditable row, never a deletion.
Preserve this import boundary when adding features; it's load-bearing for the demo's judging
criteria, not incidental structure.

**Rule validation vs. signing are separate concerns.** `src/attestation-rules.js` is the single
source of truth for the fixed payout schedule (PT-01..PT-05, see `FIXED_SCHEDULE`), the PT-01
monthly cool-down, and monthly cap headroom (`cap_ledger`) — applied identically regardless of
`ATTESTATION_MODE`. The signer (`src/protosure/stub.js` offline, or `src/protosure/rater-client.js`
live) *only signs* the canonical digest; it never decides whether a payout is allowed. Coverage
code / trigger code / monthly-cap mappings live in one place, `src/coverage.js` — don't duplicate
them.

**Attestation modes.** `ATTESTATION_MODE=stub` signs offline with `STUB_SIGNER_PRIVATE_KEY` (pure
crypto, no network). `ATTESTATION_MODE=protosure` calls the real Protosure rater
(`src/protosure/rater-client.js`); its response is only accepted if `raterData.signer` matches
`REGISTERED_SIGNER` and the signature is 65 bytes. On an unreachable/invalid rater response,
`ATTESTATION_FALLBACK` (`stub` | `fail`) decides whether to fall back to the offline stub — a
fallback stamps `source:"stub-fallback"` on the resulting attestation, surfaced to judges rather
than hidden. `STUB_SIGNER_PRIVATE_KEY` also doubles as the on-chain relayer wallet
(`src/chain/chain.js`) that pays gas to submit already-signed payloads via `submitTrigger` in
*both* modes — `submitTrigger` has no `msg.sender` restriction, so the relayer identity is
unrelated to the attestation signer.

**Chain layer.** `src/chain/chain.js` hand-writes ABI fragments for `DemoJPYC` and
`MimamorParametric` rather than importing Hardhat build artifacts, so the API server never needs
a `hardhat compile` step at runtime (Render just runs `npm ci && node src/server.js`). Contracts
live in `src/chain/contracts/`; `src/chain/deploy.js` (run manually via
`npx hardhat run src/chain/deploy.js --network fuji`, never automatically) deploys them, registers
signers, sets caps per coverage code, and writes `.env.chain` with the resulting addresses.

**Data layer.** `src/db.js` is the only place that touches SQLite (`better-sqlite3`) — schema
migration, seeding, and a `wipe()`/`resetDb()` pair used by both `/v1/demo/reset` and
`AUTO_RESET_MINUTES`. `wipe()` deliberately never touches `wallets` (on-chain contract addresses
persist across a demo reset) or `cap_ledger` (mirrors on-chain `monthSpend`, which a reset also
doesn't touch — wiping one without the other would desync the local cap pre-check from reality).
Tests open `:memory:` databases via `test/helpers.js#setupApp`.

**Claude client.** `src/claude/client.js` is a shared wrapper around `@anthropic-ai/sdk`:
JSON-schema validation via zod with one retry on parse failure, a hard timeout, and
`{purpose, promptHash, ms}` logging on every call — no raw prompt/response content is logged. An
explicit per-call `apiKey` (see `src/claude/pendingKey.js`, used for judge-supplied keys) always
wins over `ANTHROPIC_API_KEY` and gets its own short-lived client instance, never the cached
shared one, so keys from different callers never cross. Callers own prompt construction and are
responsible for their own fail-safe fallback when `callClaudeJson` throws.

**Auth.** Two independent gates in `src/auth.js`: `apiKeyAuth` (fails closed — `500` if `API_KEY`
isn't set at all, `401` on mismatch) protects every real API route; `judgeKeyAuth` is optional
(no-op if `JUDGE_KEY` unset) and protects only `/v1/demo/*` and the Judge Console. `x-api-key`
must never reach a browser — that's precisely why the Judge Console (a plain static page) is
gated by `JUDGE_KEY` instead.

**Sims.** `src/sims/gps.js` and `src/sims/uber.js` are scripted, deterministic replacements for
real GPS tracking and a real Uber integration — driven by `DEMO_TIMESCALE` so a 10-minute dwell
threshold or driver ETA compresses into a live demo's timeframe.

**Project layout mirrors the build brief:** `routes/*` (one Express router per resource),
`claude/*` (the two decision modules + shared client), `protosure/*` (rater client + offline
stub), `sims/*` (GPS walk + Uber driver lifecycle), `chain/*` (contracts + deploy + ethers
helpers), `public/judge.html` (Judge Console), `test/*` (`node --test`, fully offline) and
`test/chain/*` (Hardhat, requires a local node).

## Working in this repo

- When touching payout logic, keep the Claude-never-gates-money import boundary intact — a new
  route or module under the payment/attestation/chain path should not import from `src/claude/*`.
- When touching payout amounts or caps, change `src/attestation-rules.js` and `src/coverage.js`
  only — don't hardcode schedule amounts elsewhere.
- Prefer the fail-safe pattern already used throughout: env-gated real integration, deterministic
  local fallback when unconfigured, and a `503` with a specific error code (`SIGNER_NOT_CONFIGURED`,
  `CHAIN_NOT_CONFIGURED`, etc.) rather than a generic error when a feature is unconfigured.
- `npm test` and `npm run test:chain` (after `npm run compile`) should both stay green; the
  README's "8-scene demo runbook" is the end-to-end acceptance check for demo-facing changes.
