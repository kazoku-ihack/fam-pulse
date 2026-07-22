# fam-pulse — API Sync Changes (feed to Claude Code in the repo root)

> **Context:** this repo (kazoku-ihack/fam-pulse) was audited against the current Kazoku Pulse spec on 2026-07-22. All 36 routes, the judge console, sims, Claude modules, and gap-fill endpoints are present and correct — do NOT rebuild them. Two change waves are missing: (A) the **Protosure JS rater now signs attestations** with a specific digest the current contract cannot verify, and (B) **geo-fence config propagation** to the Parent app. Apply changes S1→S10 in order; run the named tests after each step. Files are referenced by their actual paths in this repo.
>
> **Golden reference vector (verified against the real rater — use it in tests):**
> inputs `{policy_id:"KP-2026-001", trigger_ref:"TRG-0001", coverage_code:"0x01", payout_amount:"3000", recipient:"0x742d35Cc6634C0532925a3b8D4C9C0f25B4f2F9a", month_key:"202608", contract_address:"0x5FbDB2315678afecb367f032d93F642f64180aa3", chain_id:"43113"}`
> → `payload_hash = 0xc1b318da13d253576a3a51eb16289aa9ab31141cd8d3acd003049c087a77fd4d`
> → signature recovers to `0x2c7536e3605d9c16a7a3d7b1898e529396a65c23`

---

## S1 — Replace the contract: `src/chain/contracts/KazokuPayout.sol` → `MimamorParametric.sol`

**Why:** the current contract hashes `abi.encode(policyId, triggerCode, payoutAmount, recipient, timestamp, nonce)` — a completely different digest from what the delivered Protosure rater signs. Every rater signature will revert with SIGNER_MISMATCH. Delete `KazokuPayout.sol` and create `src/chain/contracts/MimamorParametric.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
interface IERC20 { function transfer(address to, uint256 amt) external returns (bool); }

contract MimamorParametric is Ownable {
    IERC20 public immutable jpyc;
    mapping(address => bool) public isRegisteredSigner;              // replaces single pinnedSigner
    mapping(bytes32 => bool) public usedNonce;                       // key = triggerRef = keccak(trigger_ref)
    mapping(bytes1 => uint256) public cap;                           // per coverage code, per month
    mapping(bytes1 => mapping(uint256 => uint256)) public monthSpend;

    event PayoutExecuted(bytes32 indexed triggerRef, bytes32 indexed policyId,
        bytes1 coverageCode, uint256 amountJpy, address recipient, uint256 monthKey, address signer);
    event SignerSet(address signer, bool enabled);
    event CapSet(bytes1 coverageCode, uint256 amount);

    constructor(address jpyc_) Ownable(msg.sender) { jpyc = IERC20(jpyc_); }
    function setSigner(address s, bool on) external onlyOwner { isRegisteredSigner[s] = on; emit SignerSet(s, on); }
    function setCap(bytes1 c, uint256 a) external onlyOwner { cap[c] = a; emit CapSet(c, a); }

    function computeInner(string calldata policyIdStr, string calldata triggerRefStr,
        bytes1 coverageCode, uint256 amountJpy, address recipient, uint256 monthKey)
        public view returns (bytes32 triggerRef, bytes32 inner)
    {
        triggerRef = keccak256(bytes(triggerRefStr));
        bytes32 policyId = keccak256(bytes(policyIdStr));
        // EXACT packed order/widths (201 bytes): bytes32,bytes32,bytes1,uint256,address,uint256,address,uint256
        inner = keccak256(abi.encodePacked(
            triggerRef, policyId, coverageCode, amountJpy, recipient, monthKey,
            address(this), block.chainid));
    }

    function submitTrigger(string calldata policyIdStr, string calldata triggerRefStr,
        bytes1 coverageCode, uint256 amountJpy, address recipient, uint256 monthKey,
        bytes calldata signature) external
    {
        (bytes32 triggerRef, bytes32 inner) = computeInner(
            policyIdStr, triggerRefStr, coverageCode, amountJpy, recipient, monthKey);
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(inner);  // EIP-191 prefix — required
        address rec = ECDSA.recover(digest, signature);
        require(isRegisteredSigner[rec], "SIGNER_MISMATCH");
        require(!usedNonce[triggerRef], "NONCE_ALREADY_USED");
        usedNonce[triggerRef] = true;
        require(monthSpend[coverageCode][monthKey] + amountJpy <= cap[coverageCode], "CAP_EXCEEDED");
        monthSpend[coverageCode][monthKey] += amountJpy;
        require(jpyc.transfer(recipient, amountJpy), "TRANSFER_FAILED");
        emit PayoutExecuted(triggerRef, keccak256(bytes(policyIdStr)), coverageCode,
            amountJpy, recipient, monthKey, rec);
    }
}
```

Notes: `address(this)` and `block.chainid` are inside the digest — the rater must receive the deployed address and 43113. Amounts are whole-JPY integers; make `DemoJPYC` mint accordingly (check `src/chain/contracts/DemoJPYC.sol` decimals and align — pick whole-JPY, assert in a test). Add `@openzeppelin/contracts` to devDependencies if absent; `npm run compile`.

## S2 — Update `src/chain/deploy.js`

After deploying DemoJPYC + MimamorParametric: (1) `setSigner("0x2c7536e3605d9c16a7a3d7b1898e529396a65c23", true)`; (2) also register `STUB_SIGNER_PRIVATE_KEY`'s address when that env is set (rehearsal payouts); (3) `setCap`: `0x01→6000, 0x02→30000, 0x03→20000, 0x04→10000, 0x05→5000, 0x06→100000`; (4) fund the contract with tJPYC; (5) write `PAYOUT_ADDR`/`JPYC_ADDR` to `.env.chain` and print the values to paste into the Protosure/Mendix mapping.

## S3 — Rewrite `src/protosure/stub.js` as a **digest-building offline signer**

Currently it only validates rules. Split responsibilities:
- Move rule validation (fixed schedule, cool-down count) into a new `src/attestation-rules.js` (called by the route in S5 for BOTH modes — the rater never validates rules).
- `stub.js` becomes the offline signer reproducing the rater's digest EXACTLY: `inner = keccak256(concat(keccak(utf8(trigger_ref)), keccak(utf8(policy_id)), byte(coverage_code), uint256(payout_amount), address(recipient), uint256(month_key), address(contract_address), uint256(chain_id)))`; `digest = keccak256("\x19Ethereum Signed Message:\n32" || inner)`; sign with `STUB_SIGNER_PRIVATE_KEY` using ethers `new SigningKey(pk).sign(digest)` serialized to 65-byte r‖s‖v — **NOT `wallet.signMessage`** (double-prefix bug). Return `{ payload_hash, signature, signer, source:"stub" }`.
- Unit test: with the demo key `4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318` and the golden inputs, `payload_hash` must equal `0xc1b318…fd4d` and the signature must recover `0x2c7536…5c23`.

## S4 — Rewrite `src/protosure/rater-client.js` as a **sign-only client**

Delete the `productCode`/`requestedAmount` validation-request shape. New contract: `sign(fields)` sends the eight exact snake_case fields — `policy_id, trigger_ref, coverage_code, payout_amount, recipient, month_key, contract_address, chain_id` (all strings) — to `PROTOSURE_RATER_URL` with `PROTOSURE_API_TOKEN`; reads the response `calculation` object; requires `calculation.signer === process.env.REGISTERED_SIGNER` and signature length 65 bytes; returns `{ payload_hash, signature, signer, source:"protosure" }`. Timeout 5 s, one retry; on failure fall back to `stub.js` per existing `ATTESTATION_MODE` fallback logic (keep the `source` stamp — the route already surfaces it).

## S5 — Rework `src/routes/attestation.js` (POST /v1/attestation/trigger)

New sequence: (1) validate rules via `src/attestation-rules.js` (schedule PT-01 ¥3,000 / PT-02 ¥30,000 / PT-03 ¥20,000 / PT-04 ¥10,000 / PT-05 ¥1,000 fraud-reward / PT-06 settlement; cool-downs; rolling monthly cap headroom per coverage×month from a local `cap_ledger` table); (2) derive `month_key` = YYYYMM in **Asia/Tokyo**, `trigger_ref` = incident/settlement UUID, `coverage_code` via a single constants map `PT-01→0x01 … PT-06→0x06` in a new `src/coverage.js` (import it everywhere — one source of truth); `contract_address`/`chain_id` from env; (3) call rater-client (or stub per mode); (4) persist attestation with `payload_hash, signature, signer, source, month_key, coverage_code`; (5) record intended spend in `cap_ledger` (release on permanent submit failure). `GET /v1/attestation/signer/current` → return `env.REGISTERED_SIGNER` plus a live `isRegisteredSigner` read from the contract when chain config exists. Add the needed columns to `src/db.js` (attestations: payload_hash, signature, signer, source, month_key, coverage_code; new table cap_ledger).

## S6 — Update `src/routes/payments.js` chain call

`/v1/jpyc/transfer` and `batchTransfer` now call `submitTrigger(policy_id, trigger_ref, coverage_code, payout_amount, recipient, month_key, signature)` with values **echoed from the stored attestation** (never recomputed). Update `src/chain/chain.js` ABI/encoding accordingly (`coverage_code` as bytes1, e.g. `"0x01"`). Map revert reasons: `SIGNER_MISMATCH → 502` (message: "signer not registered on contract — run setSigner"), `NONCE_ALREADY_USED → 409`, `CAP_EXCEEDED → 422`. Receipts add `{ signer, source, payloadHash }`.

## S7 — Env + render.yaml

`.env.example` diff:
```diff
- SIGNER_PRIVATE_KEY=  # throwaway, Fuji only — never a real-funds key
+ # No signing key in the service in protosure mode — the Protosure JS rater signs.
+ STUB_SIGNER_PRIVATE_KEY=      # rehearsal only; deploy.js registers its address too
+ PROTOSURE_RATER_URL=
+ PROTOSURE_API_TOKEN=
+ REGISTERED_SIGNER=0x2c7536e3605d9c16a7a3d7b1898e529396a65c23
+ CHAIN_ID=43113
- ATTESTATION_MODE=stub          # stub | protosure
+ ATTESTATION_MODE=protosure     # protosure (rater signs) | stub (offline rehearsal)
```
Remove every `SIGNER_PRIVATE_KEY` reference in code; mirror the env changes in `render.yaml`. **Never commit `kazoku_attestation_rater*.js` into this repo** (it embeds the demo private key; it lives in the Protosure tenant).

## S8 — Geo-fence config propagation (Child → Parent)

1. **`GET /v1/policy/monitoringConfig`** in `src/routes/settings.js` (or `parent.js`): returns `{ homeLatLng:{lat,lng}, geofenceRadius, monitoringActive, configVersion, updatedAt, updatedBy:"sakura" }`. Add `configVersion INTEGER DEFAULT 1` + `updatedAt` to the policy/settings storage in `src/db.js`; seed sets version 1.
2. **PATCH bumps the version**: existing `PATCH /v1/policy/monitoringConfig` increments `configVersion`, sets `updatedAt`, and appends a `geofence_updated` row to the events table (extend the type enum in `src/routes/events.js`).
3. **Telemetry carries the version**: add `configVersion` to every frame in `src/routes/telemetry.js` (including the `sharingEnabled:false` short frame) — the Parent app watches it and re-fetches the config on change.
4. **Live re-evaluation in `src/geofence.js`**: the engine must read current config each tick (no boot-time caching). Mid-dwell radius change: shrinking can create a WANDERING incident on the next tick; enlarging resolves the in-progress dwell (and closes an active incident with a `resolved: geofence enlarged` timeline entry).

## S9 — Tests

- **Delete/replace** `test/chain/KazokuPayout.test.js` and `test/chain-crypto.test.js` (they test the dead digest).
- **New `test/chain/MimamorParametric.test.js` — run FIRST:** digest parity: `computeInner(golden inputs)` + stub-signed (demo key) signature is accepted and recovers `0x2c7536…5c23`; stub `payload_hash === 0xc1b318…fd4d`; unregistered signer → SIGNER_MISMATCH; replay → NONCE_ALREADY_USED; cap: two PT-01 in one monthKey pass, third fails CAP_EXCEEDED, next monthKey resets; **EIP-191 guard**: a signature over raw `inner` (unprefixed) must be rejected.
- Update `test/attestation.test.js` / `attestation-fallback.test.js` / `rater-client.test.js` for the sign-only client (fixture = the golden vector response), rules module split, cap ledger, and `source` stamping.
- New `test/config-propagation.test.js`: PATCH bumps configVersion; telemetry frame carries it; GET returns new values; mid-dwell shrink creates the incident, enlargement resolves it.
- Keep every other existing test passing untouched.

## S10 — Acceptance (definition of done)

1. `npm run compile && npm run test:chain` — MimamorParametric suite green, digest-parity first.
2. `npm test` — full suite green including config-propagation.
3. `node src/chain/deploy.js` on Fuji → prints addresses; `curl /v1/attestation/signer/current` shows the registered signer as live on-chain.
4. End-to-end in stub mode: wandering scenario → attestation (source:stub) → `submitTrigger` on Fuji → Snowtrace link in the receipt.
5. Flip `ATTESTATION_MODE=protosure` with the tenant URL → same flow, `source:protosure`, signer `0x2c7536…5c23` in the receipt.
6. `grep -r SIGNER_PRIVATE_KEY src/` returns nothing.
