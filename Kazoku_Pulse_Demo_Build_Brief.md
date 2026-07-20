# Kazoku Pulse — Hackathon Demo: Build Brief for Claude Code

> **How to use:** create an empty folder, run `claude`, and paste this entire file as the first prompt (or `claude "build per @Kazoku_Pulse_Demo_Build_Brief.md"` with the file in the repo). It is a complete, self-contained build specification. Build milestone by milestone; run the tests after each. Tier labels: **[REAL]** = real code + real data · **[REAL-LITE]** = real tech on test infrastructure (Avalanche Fuji) · **[STUB]** = simulator behind the real interface.

---

## 0. Project shape

Build a single deployable Node.js app (monorepo folders, one process) — demo-grade, not production:

```
kazoku-demo/
  src/
    server.js            # Express app + route mounting + CORS
    db.js                # better-sqlite3, schema + seed-on-boot if empty
    auth.js              # x-api-key middleware (env API_KEY)
    frs.js               # pure FRS math (unit-tested)
    routes/
      healthkit.js       # POST/GET /v1/healthkit/metrics
      frs.js             # GET /v1/frs/today, /v1/frs/history
      incidents.js       # GET /v1/incidents, PATCH /v1/incident/:id, POST /v1/sos
      telemetry.js       # GET /v1/telemetry (poll) + simulator tick
      dispatch.js        # POST/GET/DELETE /v1/uber/dispatch* + /v1/webhooks/uber
      care.js            # POST /v1/careRequest, GET /v1/careRequest/:id, PATCH /v1/carePlan/:id
      payments.js        # GET /v1/wallet/balance, POST /v1/jpyc/transfer, /v1/jpyc/batchTransfer, GET /v1/settlement/current
      attestation.js     # POST /v1/attestation/trigger, GET /v1/attestation/:id, POST /v1/attestation/settlement/batch, GET /v1/attestation/signer/current
      settings.js        # GET/PATCH /v1/settings + PATCH /v1/policy/monitoringConfig
      parent.js          # GET /v1/parent/status, PATCH /v1/consent, GET /v1/carePlan/next
      events.js          # GET /v1/events (unified W-01 feed)
      demo.js            # POST /v1/demo/reset, POST /v1/demo/scenario/:name
    claude/
      wandering-triage.js  # Claude rules: classify wandering, screen false alarms
      frs-review.js        # Claude rules: FRS anomaly review, void false LOW_FRS/INACTIVITY
      client.js            # shared Anthropic client, logging, JSON-schema guard
    protosure/
      rater-client.js      # API Rater call: validate parametric rules against Protosure backend
      stub.js              # deterministic fallback (same interface)
    sims/
      gps.js             # scripted GPS walk for the wandering scenario
      uber.js            # provider simulator: driver lifecycle -> signed webhooks
    chain/
      contracts/KazokuPayout.sol + DemoJPYC.sol
      deploy.js          # one-shot Fuji deploy script (ethers v6)
      chain.js           # ethers provider/signer helpers
  public/judge.html      # Judge Console (scenario buttons, no build tooling)
  test/                  # node --test
  scripts/seed.js, demo-reset.js
  .env.example  README.md
```

Stack: Node 20+, ESM, Express, better-sqlite3, ethers v6, @anthropic-ai/sdk, zod for validation, cors. No TypeScript (demo speed). Every route requires `x-api-key` except `/health`.

**Design deviation from the production spec (deliberate):** all WebSocket channels are replaced by **2-second polling GETs** — Mendix consumes REST easily, WS awkwardly. Poll endpoints return the same frame shapes as the spec'd WS channels.

## 1. Data (SQLite)

Tables: `metrics(parentId, date, dailySteps, sleepHours, heartRateAvg, heartRateResting, ts)` PK(parentId,date) · `frs_history(parentId, date, score, factors_json)` · `incidents(id, type, severity, ts, active, lat, lng, exitTs, dwellMin, escalationDueTs, pickupConfirmed, dropoffConfirmed, timeline_json, pt01Eligible)` · `dispatches(id, incidentId, status, driver_json, etaMin, lat, lng, retryCount)` · `care_requests(id, needSummary, windows_json, channelStatus_json, slaDueTs, plan_json, status)` · `settlements(id, period, lines_json, pt03Credit)` · `attestations(id, policyId, triggerCode, payoutAmount, recipient, timestamp, nonce, payloadHash, signature, signerAddress, txHash, status)` · `settings(singleton_json)` · `wallets(name, address)`.

Seed (also what `POST /v1/demo/reset` restores): parent `yoshiko-001` with 7 days of realistic metrics (today ≈ FRS 82), home at lat 35.6595/lng 139.7005, radius 500 m, June settlement with 4 lines (3 attested visits + 1 deferred reward), empty incidents, settings all `auto`.

## 2. Endpoints by tier

### [REAL] FRS pipeline
- `POST /v1/healthkit/metrics` — validate (steps 0–50000, sleep 0–16, HR 30–220), upsert per parentId+date, 201. Fed by the KazokuFeeder iOS app or seed.
- `GET /v1/frs/today?parentId=` — FRS = mobility 30% (steps vs 4000 target) + vitals 30% (resting HR 55–75 full) + sleep 20% (6.5–8.5 h full) + routine 20% (vs 7-day median). Response exactly: `{ score, statusText, emoticon: happy|neutral|concerned, factors:{mobility,vitals,sleep,routine}, dataSufficient }`. happy ≥70 / neutral 60–69 / concerned <60; statusText "Feeling good" / "Doing okay" / "Let's take care today"; no row today → `dataSufficient:false, statusText:"Please wear your watch"`.
- `GET /v1/frs/history?days=7` — `[ {date, score|null} ]`.

### [REAL] Incidents, geo-fence, 助けて!
- Geo-fence engine (real rule code, simulated coordinates): a background tick consumes `sims/gps.js`; positions with accuracy >50 m excluded; outside-radius dwell >10 min (demo: configurable to 20 s via env `DEMO_TIMESCALE`) creates a WANDERING incident with `escalationDueTs = now+10min`.
- `GET /v1/incidents?active=` · `PATCH /v1/incident/:id { pickupConfirmed }` (409 unless dispatch en_route; `dropoffConfirmed` set server-side when simulated position geo-matches home ≤50 m).
- On WANDERING creation the incident is enriched by **`claude/wandering-triage.js` [REAL]** (see §2b) before the alert is pushed; the incident JSON gains a `triage` object the W-02 screen can display.
- `POST /v1/sos` — creates SOS incident immediately, no dedupe, **and is exempt from triage**: 助けて! always alerts at severity `high`; Claude is never consulted. Claude failure anywhere else → severity `high` (fail-safe), never blocks.
- `GET /v1/telemetry?parentId=` — poll frame `{ lastLocation, accuracyM, dailySteps, sleepHours, lastHeartRate, sharingEnabled, ts }`.

### [STUB] Provider dispatch (real interface, simulated provider)
- `POST /v1/uber/dispatch { incidentId }` + Idempotency-Key — 409 on duplicate active dispatch; pickup from incident location, dropoff from home (server-derived). Starts `sims/uber.js`: driver "Kenji T." lifecycle `requested→accepted(3s)→en_route(6s)→arrived(15s)→completed` — each transition **POSTs a signed webhook to our own** `/v1/webhooks/uber` (HMAC `X-Uber-Signature`, verified — the webhook handler is real code).
- `GET /v1/uber/dispatch/:id` — poll: `{ status, driverName, rating, vehicle, plate, etaMin, driverLocation, routePolyline, driverWalletAddr, retryCount }`.
- `DELETE /v1/uber/dispatch/:id`; retry max 3; env `SIM_FAIL_DISPATCH=1` forces the timeout path for rehearsing the escalation banner.

### §2b [REAL] Claude decision modules — rules for wandering response & FRS false-alarm screening

**`claude/wandering-triage.js`** — called once when a WANDERING incident is created. Prompt context (pseudonymized): dwell minutes, distance from home, direction of travel, time of day, today's FRS + factors, the last 5 incident outcomes (e.g., "resolved: was at supermarket"), and any `knownSafePlaces` from settings. Claude must return **strict JSON** (validate with zod, retry once on schema failure):
```json
{ "severity": "low|medium|high",
  "falseAlarmLikelihood": 0.0-1.0,
  "recommendedAction": "notify_now | soft_check | dispatch_suggest",
  "reasoning": "one sentence, shown verbatim on W-02" }
```
**Hard guardrails (code, not prompt):** Claude may *downgrade* the alert to `soft_check` (a gentle "is everything okay?" card instead of the red alert) **only if** falseAlarmLikelihood ≥ 0.7 AND FRS ≥ 60 AND local time is 07:00–19:00 AND the position is moving toward a knownSafePlace. Everything else notifies immediately. The incident row is **always created** regardless of triage (nothing is ever silently dropped); `escalationDueTs` runs regardless; SOS bypasses this module entirely; Claude timeout (5 s) → `notify_now`/`high`.

**`claude/frs-review.js`** — runs before raising LOW_FRS or INACTIVITY incidents (and nightly over the day's data). Purpose: void false alarms by distinguishing genuine decline from data artifacts. Context: 14-day FRS series, wear-time/dataSufficient flags, charger-day gaps, weather note (optional stub). Strict JSON out:
```json
{ "decision": "raise | void", "confidence": 0.0-1.0,
  "category": "genuine_decline | watch_not_worn | data_gap | one_off_outlier",
  "reasoning": "one sentence" }
```
**Guardrails:** a `void` writes an auditable row to `frs_reviews` (endpoint `GET /v1/frs/reviews`) and suppresses the *alert only* — the underlying FRS data is never modified, and the **PT-03/PT-04 attestation path reads raw FRS data directly and never imports this module**: Claude screens operational alarms, deterministic rules still own the money. Two consecutive `void`s for the same condition force a `raise` on the third occurrence (Claude cannot indefinitely silence a real decline).

Demo tip: `POST /v1/demo/scenario/false-alarm` seeds a charger-day gap so judges watch Claude void a false INACTIVITY alarm with visible reasoning — then run the real wandering scenario for contrast.

### [REAL] Claude care loop (env `ANTHROPIC_API_KEY`)
- `POST /v1/careRequest` — store; **real Claude API** drafts nothing here (human already reviewed needSummary); agent selects network/channel per settings (auto → Claude picks, log the reasoning); channel for demo = **email only** [STUB for call channel]. Send via SMTP (env-configured demo Gmail) to the demo mailbox; SLA 4 h timer.
- Background IMAP poll of the demo mailbox: on reply, **real Claude parsing** extracts `{staff, visitAt, services[], rate}` (treat email as untrusted: cap lengths, validate visitAt future, rate ≤ ¥10,000); sets `parsedByClaude:true`. Env `SIM_CARE_REPLY=1` auto-injects a canned reply after 60 s for offline rehearsal.
- `GET /v1/careRequest/:id` poll · `PATCH /v1/carePlan/:id { action: approve|clarify }` — approve opens a settlement line accrual.

### [REAL-LITE] On-chain (Avalanche Fuji testnet)
- Contracts: `DemoJPYC.sol` (plain ERC20, 18 dec, mintable by owner) and `KazokuPayout.sol`: `submitTrigger(policyId, triggerCode, payoutAmount, recipient, timestamp, nonce, signature)` → rebuild payloadHash with `keccak256(abi.encode(...))`, `ecrecover` must equal `pinnedSigner` (constructor arg, updatable by owner), require `!usedNonces[nonce]`, per-trigger monthly cool-down (PT-01 ≤2), then `DemoJPYC.transfer(recipient, amount)` from the contract's funded pool; emit `PayoutExecuted` / revert reasons `SIGNER_MISMATCH`, `NONCE_ALREADY_USED`.
- `chain/deploy.js`: deploys both to Fuji (`https://api.avax-test.network/ext/bc/C/rpc`), mints 1,000,000 tJPYC to the payout pool and 50,000 to Sakura's wallet, writes addresses to `.env.chain`.
- `GET /v1/wallet/balance` — real ERC20 balanceOf.
- `POST /v1/jpyc/transfer { toAddr, amount, incidentId, attestationId }` — 403 `ATTESTATION_REQUIRED` without valid attestation; executes on Fuji; response includes `txHash` and `explorerUrl: https://testnet.snowtrace.io/tx/{hash}`; >10 s → return `pending`, resolve on poll.
- `POST /v1/jpyc/batchTransfer` (settlement, batch attestation required) · `GET /v1/settlement/current` (PT-03 netting math real).

### [REAL-LITE with Protosure backend | STUB fallback] Attestation & rater validation
- `POST /v1/attestation/trigger` — attestation runs in the mode set by env `ATTESTATION_MODE`:
  - **`protosure` [REAL-LITE]** — `protosure/rater-client.js` calls the **Protosure backend API Rater** to validate the parametric rules for the trigger: map the canonical payload to a rater request `{ productCode: PROTOSURE_PRODUCT_CODE, policyId, triggerCode, requestedAmount, eventTimestamp }`, POST to `PROTOSURE_BASE_URL` with bearer `PROTOSURE_API_TOKEN` (TLS), and accept only a response where the rater confirms: policy in force, trigger code configured on the product, **rated amount equals the fixed schedule** (PT-01 ¥3,000 / PT-02 ¥30,000 / PT-03 ¥20,000 / PT-04 ¥10,000 — mismatch → reject `RATER_AMOUNT_MISMATCH`), and cool-down/annual-cap counters pass. The rater response id is stored as `raterRef` on the attestation for the audit trail. Timeout 5 s, one retry (R-19); on failure behave per `ATTESTATION_FALLBACK=fail|stub` — `stub` continues with the local check and stamps `attestation.source:"stub-fallback"` (surfaced on the W-05 receipt: judge-transparency by design).
  - **`stub` [STUB]** — `protosure/stub.js`: the same deterministic rule check (trigger valid, fixed amount, cool-downs) entirely local. Identical interface, so flipping modes is one env var.
  - In **both** modes, **signing is REAL-LITE**: local ethers wallet (env `SIGNER_PRIVATE_KEY`, Fuji-only throwaway) signs the canonical payloadHash — the same signature the on-chain contract verifies via ecrecover.
- Before the hackathon: request Protosure sandbox credentials + confirm the exact API Rater request/response schema against last year's Solar Panel integration; adjust `rater-client.js` field mapping only (callers untouched). If credentials don't arrive, the demo runs `stub` and the transparency slide says so.
- `GET /v1/attestation/:id` (includes `source` and `raterRef`) · `POST /v1/attestation/settlement/batch` · `GET /v1/attestation/signer/current`.

### [REAL] Settings + demo control
- `GET/PATCH /v1/settings` — chips enums per OpenAPI; explicit prefs override agent.
- `POST /v1/demo/reset` — wipe + reseed everything except chain state (nonces monotonic). `POST /v1/demo/scenario/wandering` — starts the GPS walk that exits the geo-fence.

### §2c [REAL] Gap-fill endpoints (from the use-case re-check — required so every screen resolves)

These close the audit gaps against UC-01…UC-14 so judges using the apps unaided never hit a dead control:

- `PATCH /v1/policy/monitoringConfig { homeLatLng, geofenceRadius, monitoringActive }` — **UC-01**, called by W-10's geo-fence save (radius from slider OR meters field, validated identically 100–2000). 409 unless paired. Separate from `/v1/settings` to stay contract-compatible with the OpenAPI.
- `GET /v1/parent/status` — powers all W-08 cards in one call: `{ pairingStatus: "connected", sharingEnabled, geofenceConfigured, monitoringActive }` (**UC-02**; demo seed = paired). W-08 FINISH SETUP enables when `pairingStatus=connected && sharingEnabled`.
- `PATCH /v1/consent { sharingEnabled }` — the W-08 consent card and the W-09 sharing toggle both call this; `sharingEnabled:false` makes `GET /v1/telemetry` return `{ sharingEnabled:false }` frames only (consent gate is real).
- `PATCH /v1/settlement/:id/line/:lineId { disputed }` — **UC-11** dispute flag (⚑) persists server-side, so it survives refresh and two judges see the same state; `POST /v1/jpyc/batchTransfer` server-side re-derives exclusions = disputed ∪ unattested (rejects tampered lists).
- `GET /v1/events?limit=20` — **the W-01 unified feed** (**UC-12/13 visibility**): one merged, newest-first list of `{ type: wandering|sos|frs_dip|frs_void|visit_completed|payout|settlement, ts, title, deepLink, refId }`. Payout events carry the Snowtrace URL; `frs_void` rows make Claude's false-alarm saves visible in the feed. Every state change anywhere appends here — this is how polling judges "receive push."
- `GET /v1/carePlan/next?parentId=` — the W-09 next-visit card: `{ staff, visitAt } | null` (hidden when null), set on plan approval (**UC-09**).

## 3. Claude integration rules

Model `claude-sonnet-4-6` via @anthropic-ai/sdk; max_tokens ≤1000; prompts pseudonymized (`parent-001`, never names); every call logged `{purpose, promptHash, ms}`; hard rule in code comments and README: **Claude output never gates a payout** — the attestation/payment code path imports nothing from `src/claude/*`; triage and FRS review shape *alerts and severity only*, and every void/downgrade is an auditable row, never a deletion.

## 4. Tests (node --test) — the demo rehearsal in CI form

FRS boundaries 59/60/69/70 · dwell 9/10/11 min (timescaled) · idempotent dispatch · webhook bad-signature rejected · dispatch state machine cannot skip · transfer without attestationId → 403 · reused nonce → revert mapped to 409 NONCE_ALREADY_USED (chain tests run against a local hardhat node, `npm run test:chain`) · care email with prompt-injection text → sanitized fields only · settlement netting property test · **triage guardrails**: SOS never triaged; downgrade refused outside the 4 guard conditions; malformed Claude JSON → notify_now/high · **FRS review**: void writes an audit row and leaves raw data untouched; third consecutive occurrence forces raise · **rater client**: fixture-based contract test (recorded Protosure response), amount-mismatch rejection, timeout → fallback per `ATTESTATION_FALLBACK` with `source:"stub-fallback"` stamped · **gap-fill**: consent off closes telemetry; dispute flag persists and batch re-derives exclusions; every scenario appends the expected /v1/events rows; W-08 status endpoint reflects seed.

## 5. Milestones (build in this order)

1. **M1** scaffold + db + auth + seed + FRS routes + tests green
2. **M2** incidents + GPS sim + 助けて! + telemetry poll + **gap-fill endpoints** (§2c: parent/status, consent, monitoringConfig, events feed)
3. **M3** dispatch simulator + webhook handler + state machine
4. **M4** contracts + Fuji deploy + attestation module (stub mode) + payments (transfer visible on Snowtrace)
5. **M5** Claude care loop with demo mailbox + **Claude decision modules** (wandering triage, FRS review) with the false-alarm demo scenario
6. **M6** **Protosure rater client** (`ATTESTATION_MODE=protosure`) against sandbox credentials, with fixture tests and stub fallback
7. **M7** settlement (incl. dispute-line PATCH) + settings + carePlan/next + demo/reset + **Judge Console** (`public/judge.html`) + README with the 8-scene runbook mapping each scene to curl commands

Definition of done: `npm test` green; `bash scripts/demo-reset.js && curl` walkthrough of all 8 scenes succeeds end-to-end on a clean boot.

## 6. Environment (.env.example)

```
PORT=3000
API_KEY=change-me
ANTHROPIC_API_KEY=
SMTP_URL=            # demo gmail app-password URL
IMAP_URL=
FUJI_RPC=https://api.avax-test.network/ext/bc/C/rpc
SIGNER_PRIVATE_KEY=  # throwaway, Fuji only — never a real-funds key
DEPLOYER_PRIVATE_KEY=
JPYC_ADDR=           # filled by deploy.js
PAYOUT_ADDR=
DEMO_TIMESCALE=30    # 1 real second = 30 demo seconds
ATTESTATION_MODE=stub          # stub | protosure
ATTESTATION_FALLBACK=stub      # fail | stub (behavior when Protosure unreachable)
PROTOSURE_BASE_URL=            # sandbox URL (request credentials NOW - longest lead time)
PROTOSURE_API_TOKEN=
PROTOSURE_PRODUCT_CODE=KAZOKU-PARAM-001
SIM_CARE_REPLY=0
SIM_FAIL_DISPATCH=0
AUTO_RESET_MINUTES=0           # >0: cron-style auto reseed for unattended judging
MAX_DEMO_TX_PER_HOUR=20        # Fuji spend throttle across all judges
JUDGE_KEY=                     # optional simple key for /judge console actions
RATE_LIMIT_PER_MIN=120         # express-rate-limit, per IP
CORS_ORIGIN=*
```

---

## 8. Self-service judging (judges use the apps themselves via public URLs)

Design decisions that make unattended use safe and intuitive:

- **One shared family, embraced.** All judges act as Sakura watching Yoshiko (`yoshiko-001`). Concurrent actions are visible to everyone — that's a feature ("another judge just dispatched the taxi"). All state-changing endpoints accept an optional `familyId`; the seed also creates `yoshiko-002` so a second, independent family URL can be handed to a judge who wants a clean run (Mendix constant per deployment, or a URL parameter on the Judge Console).
- **Judge Console** — `public/judge.html`, a single dependency-free page served by the API at `/judge`: big buttons for *Start wandering scenario*, *Trigger false-alarm (charger-day)*, *Simulate care reply now*, *Reset demo*, plus live links to the two Mendix app URLs and the latest Snowtrace tx. Buttons call the `/v1/demo/*` endpoints (guarded by `JUDGE_KEY` if set). This replaces you standing behind each judge.
- **Idle-proofing:** `AUTO_RESET_MINUTES=30` reseeds automatically between judging sessions; `demo-reset` never touches chain state (nonces stay monotonic).
- **Abuse & cost guards:** per-IP rate limit; `MAX_DEMO_TX_PER_HOUR` caps Fuji transactions across all judges (excess payouts return a friendly `DEMO_TX_LIMIT` receipt without a chain call); pool pre-funded with ample tJPYC; PT cool-downs already limit per-trigger spam.
- **No secrets in judges' hands:** the `x-api-key` lives in a Mendix constant and is attached **server-side** by the Mendix runtime's consumed REST service — it never reaches the judge's browser. `CORS_ORIGIN` locked to the two Mendix domains + the Judge Console origin.
- **Every control resolves:** the §2c endpoints exist precisely so no wireframe element is dead — W-08 cards read `parent/status`, the W-07 flag persists, the W-01 feed updates within one 2-second poll of any action, and the W-09 visit card appears the moment a judge approves a plan in the other app.

# Publishing it to the internet (so Mendix + everything can connect)

## Recommended: Render.com (or Railway) — one service, public HTTPS, ~30 min

1. Push the repo to GitHub (private is fine). Ensure `.env` is git-ignored; commit only `.env.example`.
2. Render → **New → Web Service** → connect the repo → runtime Node → build `npm ci` → start `node src/server.js` → free instance.
3. Set every env var from §6 in the Render dashboard (never in git). Add `SEED_ON_BOOT=1` — free-tier disks are ephemeral, so the app reseeds on every deploy/restart; chain state persists on Fuji regardless, which is exactly what you want.
4. Deploy → you get `https://kazoku-demo.onrender.com`. Verify: `curl https://.../health` and one FRS call with the API key.
5. **Fuji deploy runs once from your Mac** (`node chain/deploy.js`), not on Render; paste the resulting contract addresses into Render env vars.
6. Free-tier note: Render spins down after idle (~50 s cold start). Before the demo, hit `/health` from your phone, or add a free cron ping (cron-job.org) every 10 min during demo day.

## Wire up each consumer

| Consumer | How it connects |
|---|---|
| **Mendix apps (UI as-is, PUBLIC URLs for judges)** | Deploy the Parent app and the Adult Child app as **two Mendix Free Cloud apps** (Studio Pro → Publish): each gets a shareable `https://<app>.mendixcloud.com` URL. Enable **anonymous/guest access** in both apps' security (demo entities only) or hand judges one shared demo login on a printed card. Free nodes sleep after ~1–2 h idle — open both URLs 10 minutes before judging (add them to the same cron ping as the API). Consumed REST: base URL = constant `KazokuApiBase` = your Render URL; `x-api-key` constant is attached server-side by the Mendix runtime, invisible to browsers. Replace every WS binding with a 2-second **microflow timer** polling the GETs (frames shape-identical). Bindings: W-01 → `/v1/frs/today` + `/v1/events`; W-08 → `/v1/parent/status`; W-03/W-04 → `/v1/uber/dispatch/:id`; W-06 → `/v1/careRequest/:id`; W-09 → `/v1/frs/today` + `/v1/carePlan/next`. |
| **Taxi "API"** | Nothing external to connect — the simulator lives inside the same service and calls your own webhook. To later swap in real Uber: register your Render URL + `/v1/webhooks/uber` in the Uber developer dashboard and replace `sims/uber.js` with real API calls; callers don't change. |
| **FRS / HealthKit feeder** | The KazokuFeeder iOS app POSTs to `https://kazoku-demo.onrender.com/v1/healthkit/metrics` — public HTTPS means no ATS exceptions and no same-Wi-Fi requirement at the venue. |
| **On-chain** | Already public: Fuji RPC is internet-hosted; the payout receipt's Snowtrace link works in any browser. Mendix never talks to the chain directly — only to your API. |
| **Protosure backend (rater)** | Outbound HTTPS from Render to `PROTOSURE_BASE_URL` — no inbound firewall work needed on your side. If the Protosure sandbox IP-allowlists callers, register Render's static outbound IPs (dashboard → service → Outbound) or route just this call through a fixed-IP proxy; verify with `GET /v1/attestation/signer/current` + one test attestation before demo day. |
| **Demo mailbox** | A Gmail address with an app password in `SMTP_URL`/`IMAP_URL`; the "caretaker" (a teammate's phone) just replies to the email live on stage. |

## Alternatives & fallbacks

- **ngrok from the MacBook** (`ngrok http 3000`, reserved domain on the paid tier): best for rehearsals and as **demo-day plan B** — if venue Wi-Fi blocks Render or Render misbehaves, run locally and flip the single `KazokuApiBase` constant in Mendix. Keep both URLs in the runbook.
- **Fly.io + volume**: choose this instead of Render if you want SQLite to survive restarts (adds ~20 min setup).
- **Don't** put the demo on a laptop-only setup for the actual judging: hotel/venue networks throttle tunnels; a hosted URL + hotspot fallback is the resilient combination.

## Security floor (even for a demo)

API key on every route · CORS locked to your Mendix domain before demo day (`CORS_ORIGIN`) · throwaway Fuji keys only, funded from the faucet (`https://core.app/tools/testnet-faucet/`) · never reuse any key that ever touched mainnet funds · secrets only in Render env vars, never in git.
