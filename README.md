# Kazoku Pulse — Demo Backend

A single deployable Node.js/Express app powering the Kazoku Pulse hackathon demo: elder wellness
scoring (FRS), geo-fence wandering detection with a Claude triage layer, 助けて! SOS, a simulated
taxi dispatch, a care-request loop with real Claude email parsing, and a REAL-LITE on-chain
payout path on Avalanche Fuji testnet gated by a parametric attestation (stub or Protosure rater).

See `Kazoku_Pulse_Demo_Build_Brief.md` for the full spec this implements. Tier labels used below:
**[REAL]** real code + real data · **[REAL-LITE]** real tech on test infra (Fuji, or real crypto
exercised offline) · **[STUB]** a simulator behind the real interface.

## Quick start

```bash
npm install
cp .env.example .env        # edit API_KEY at minimum
npm test                    # 77 offline tests, no credentials needed
npm run compile              # compiles src/chain/contracts
npm run test:chain           # 5 tests against a local Hardhat node
npm start                    # boots on :3000, seeds SQLite on first run
```

Everything above works with **zero external credentials**. The app is stub-first by design:
every real integration (Anthropic Claude, ethers signing, SMTP/IMAP, Protosure) is env-gated —
unset, it falls back to a deterministic local path so the demo (and its test suite) never
depends on a live network call. Flip on real credentials in `.env` to light up:

| Env var | Unlocks |
|---|---|
| `ANTHROPIC_API_KEY` | Real Claude calls for wandering triage, FRS review, care channel selection, and care-reply parsing. Unset → each module fails safe (see below) and demo scenarios use injected/canned responses instead. |
| `SIGNER_PRIVATE_KEY` | Real ethers signing of attestation payloads (works offline, no funded key needed — pure crypto). Unset → `503 SIGNER_NOT_CONFIGURED` on `/v1/attestation/trigger`. |
| `FUJI_RPC` + `JPYC_ADDR` + `PAYOUT_ADDR` | Real on-chain reads/writes (`/v1/wallet/balance`, `/v1/jpyc/transfer`, `/v1/jpyc/batchTransfer`). Deploy first via `chain/deploy.js`. Unset → `503 CHAIN_NOT_CONFIGURED` on transfer, `configured:false` on balance. |
| `SMTP_URL` / `IMAP_URL` | Real care-request email send / reply polling. Unset → logged only; use `SIM_CARE_REPLY=1` or the Judge Console's "Simulate care reply now" button to rehearse offline. |
| `PROTOSURE_BASE_URL` + `PROTOSURE_API_TOKEN` | Real Protosure API Rater validation when `ATTESTATION_MODE=protosure`. Unreachable → falls back per `ATTESTATION_FALLBACK`, stamping `source:"stub-fallback"` on the resulting attestation (surfaced to judges, not hidden). |

**Claude output never gates a payout.** `src/routes/attestation.js`, `src/routes/payments.js`,
`src/protosure/*`, and `src/chain/*` import nothing from `src/claude/*`. Triage and FRS review
shape *alerts and severity only*; every void or downgrade is an auditable row, never a deletion.

## Project layout

Matches the build brief's `src/` tree: `routes/*` (Express routers, one per resource),
`claude/*` (the two decision modules + shared client), `protosure/*` (rater client + stub
fallback), `sims/*` (GPS walk + Uber driver lifecycle), `chain/*` (contracts + deploy + ethers
helpers), `public/judge.html` (Judge Console), `test/*` (`node --test`, offline) and
`test/chain/*` (Hardhat, local node only).

## The 8-scene demo runbook

Run `bash -c 'curl -s -X POST localhost:3000/v1/demo/reset -H "x-api-key: $API_KEY"'` (or the
Judge Console's **Reset demo** button) before starting. All commands assume
`API_KEY=change-me` and the server running on `:3000` — adjust as needed. Every scene appends
to `GET /v1/events`, which is how a polling Mendix app "receives push."

**Scene 1 — Baseline.** Today's FRS (~80s, deliberately short of 100 so there's room to move) and the parent pairing status.
```bash
curl -s localhost:3000/v1/frs/today -H "x-api-key: $API_KEY"
curl -s localhost:3000/v1/parent/status -H "x-api-key: $API_KEY"
```

**Scene 2 — Wandering + Claude triage.** Starts the scripted GPS walk; after it clears the
geo-fence and the (timescaled) dwell threshold, an incident appears with a `triage` object.
```bash
curl -s -X POST localhost:3000/v1/demo/scenario/wandering -H "x-api-key: $API_KEY" -d '{}' -H "Content-Type: application/json"
sleep 2   # DEMO_TIMESCALE compresses the 10-minute dwell threshold — see .env
curl -s "localhost:3000/v1/incidents?active=1" -H "x-api-key: $API_KEY"
```

**Scene 3 — 助けて! SOS.** Bypasses triage entirely — always `severity:"high"`, no dedupe.
```bash
curl -s -X POST localhost:3000/v1/sos -H "x-api-key: $API_KEY" -d '{}' -H "Content-Type: application/json"
```

**Scene 4 — Taxi dispatch lifecycle.** Kenji T.'s driver state machine plays out via signed
webhooks to our own `/v1/webhooks/uber`; poll to watch it advance.
```bash
INCIDENT_ID=$(curl -s "localhost:3000/v1/incidents?active=1" -H "x-api-key: $API_KEY" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d)[0].id))")
DISPATCH=$(curl -s -X POST localhost:3000/v1/uber/dispatch -H "x-api-key: $API_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: demo-1" -d "{\"incidentId\":\"$INCIDENT_ID\"}")
echo "$DISPATCH"
curl -s "localhost:3000/v1/uber/dispatch/$(echo $DISPATCH | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")" -H "x-api-key: $API_KEY"
```

**Scene 5 — False-alarm rehearsal.** Seeds a charger-day gap (today's metrics deleted) and
runs `claude/frs-review.js` — with `ANTHROPIC_API_KEY` set, watch it void the false INACTIVITY
alarm with visible reasoning; the void is still an auditable row.
```bash
curl -s -X POST localhost:3000/v1/demo/scenario/false-alarm -H "x-api-key: $API_KEY" -d '{}' -H "Content-Type: application/json"
curl -s localhost:3000/v1/frs/reviews -H "x-api-key: $API_KEY"
```

**Scene 6 — Care request → reply → approved plan.** Real Claude parses the (simulated or real)
caretaker reply into structured fields; approving opens a settlement line accrual.
```bash
CARE=$(curl -s -X POST localhost:3000/v1/careRequest -H "x-api-key: $API_KEY" -H "Content-Type: application/json" -d '{"needSummary":"grocery help + wellness check"}')
CARE_ID=$(echo $CARE | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).id))")
curl -s -X POST localhost:3000/v1/demo/scenario/care-reply -H "x-api-key: $API_KEY" -H "Content-Type: application/json" -d "{\"careRequestId\":\"$CARE_ID\"}"
curl -s -X PATCH localhost:3000/v1/carePlan/$CARE_ID -H "x-api-key: $API_KEY" -H "Content-Type: application/json" -d '{"action":"approve"}'
```

**Scene 7 — Attestation + on-chain payout.** REAL-LITE: signing works offline; the actual
transfer needs `chain/deploy.js` run once against Fuji first.
```bash
curl -s -X POST localhost:3000/v1/attestation/trigger -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"policyId":"policy-yoshiko-001","triggerCode":"PT-02","recipient":"0xYourFujiWalletHere"}'
# ATTESTATION_ID=<id from above>
curl -s -X POST localhost:3000/v1/jpyc/transfer -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d "{\"attestationId\":\"$ATTESTATION_ID\"}"
```

**Scene 8 — Settlement review.** Flag a line as disputed, batch-attest the rest, and confirm the
server (not the client) decides what's excluded from the transfer.
```bash
curl -s -X PATCH localhost:3000/v1/settlement/settlement-2026-06/line/L2 -H "x-api-key: $API_KEY" -H "Content-Type: application/json" -d '{"disputed":true}'
curl -s -X POST localhost:3000/v1/attestation/settlement/batch -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"settlementId":"settlement-2026-06","recipient":"0xYourFujiWalletHere"}'
curl -s -X POST localhost:3000/v1/jpyc/batchTransfer -H "x-api-key: $API_KEY" -H "Content-Type: application/json" -d '{"settlementId":"settlement-2026-06"}'
curl -s "localhost:3000/v1/settlement/current?parentId=yoshiko-001" -H "x-api-key: $API_KEY"
```

**Definition of done:** `npm test` green, `npm run test:chain` green, and this 8-scene
walkthrough succeeds end-to-end against a freshly reset local boot.

## Judge Console

`GET /judge/judge.html` — a dependency-free static page with buttons for each demo scenario
plus a reset button, gated only by the optional `JUDGE_KEY` (never by `x-api-key`, which must
never reach a browser). It calls `/v1/demo/*`, which is deliberately mounted **before** the
`x-api-key` middleware for exactly that reason. Query params: `?family=`, `?apiBase=`,
`?judgeKey=`, `?parentApp=`, `?childApp=` (the last two are just informational links to your
deployed Mendix apps).

## Deploying the chain contracts

Not run automatically. Once you have a funded Fuji deployer key:
```bash
npx hardhat run src/chain/deploy.js --network fuji
```
Writes `.env.chain` with `JPYC_ADDR` / `PAYOUT_ADDR` / `SAKURA_WALLET_ADDR` — copy those into
your real `.env` (or your hosting provider's env vars).

## Publishing

See the build brief's "Publishing it to the internet" section for the full Render/Mendix wiring
guide (not part of this repo's automated setup — it's a manual, one-time deploy step).
