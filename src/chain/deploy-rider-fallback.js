// SUPERSEDED (2026-07-30, same day) by deploy-rider-fallback-bind.js — this version's
// MimamorParametric.sol binds address(this) into its digest, which only ever verifies signatures
// signed against ITS OWN address. That only worked for attestations the rehearsal script/endpoint
// generated themselves; every real Mendix/Protosure-originated attestation (signed against
// PAYOUT_ADDR) failed SIGNER_MISMATCH against a contract deployed here. Kept for history — do not
// deploy from this file again. See knowledge.md's RIDER_FALLBACK_ADDR/MimamorParametricBind
// investigation.
//
// One-off fallback deploy script — NOT the primary deploy path (see deploy.js for that). Run via:
//   npx hardhat run src/chain/deploy-rider-fallback.js --network fuji
//
// Why this exists (2026-07-30): the externally-deployed Rider contract (RIDER_ADDR) verifies
// attesterSig against a digest this repo can't reproduce or influence — Protosure signs
// attestations using the classic MimamorParametric digest (confirmed byte-for-byte against real
// preTransferHash traffic, see knowledge.md), which is NOT what Rider checks on-chain, so every
// real protosure-direct transfer reverts with "bad attester sig". This script deploys this repo's
// own (unmodified) MimamorParametric.sol — which DOES verify that exact digest — as a fallback
// target, wrapping the REAL, already-deployed JPYC_ADDR token (an externally-deployed 18-decimal
// "Mock JPY Coin", not this repo's 0-decimal DemoJPYC) instead of minting a new one, so the
// relayer's existing JPYC balance can fund it directly.
//
// Caveat: amountJpy is passed to jpyc.transfer() unscaled, exactly as this repo does everywhere
// else (see the amountWei notes in knowledge.md) — against an 18-decimal token that moves a dust
// amount (e.g. amountJpy=30000 raw units = 0.00000000000003 tokens), not a JPY-equivalent value.
// Acceptable for proving the pipeline produces a real, successful, Snowtrace-visible transaction;
// revisit if a real JPY-equivalent amount needs to move.
//
// Requires DEPLOYER_PRIVATE_KEY (funded on Fuji), REGISTERED_SIGNER, and JPYC_ADDR (the existing
// real token, not deploy.js's own DemoJPYC) in the environment. Paste the resulting address into
// RIDER_FALLBACK_ADDR on Render — it does not touch RIDER_ADDR/PAYOUT_ADDR.

import hre from 'hardhat';
import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE_CODE } from '../coverage.js';

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  console.log('Deploying with', deployer.address);

  if (!process.env.REGISTERED_SIGNER) {
    throw new Error('REGISTERED_SIGNER not set');
  }
  if (!process.env.JPYC_ADDR) {
    throw new Error('JPYC_ADDR not set — this script wraps the existing token, it does not deploy a new one');
  }
  const registeredSigner = process.env.REGISTERED_SIGNER;
  const jpycAddr = process.env.JPYC_ADDR;

  const MimamorParametric = await ethers.getContractFactory('MimamorParametric');
  // Explicit gasLimit — the public Fuji RPC endpoint doesn't reliably support eth_estimateGas
  // against the "pending" block tag that hardhat-ethers defaults to.
  const payout = await MimamorParametric.deploy(jpycAddr, { gasLimit: 3_000_000 });
  await payout.waitForDeployment();
  const payoutAddr = await payout.getAddress();
  console.log('MimamorParametric (Rider fallback) deployed to', payoutAddr, 'wrapping JPYC', jpycAddr);

  await (await payout.setSigner(registeredSigner, true, { gasLimit: 200_000 })).wait();
  console.log('Registered signer (Protosure rater)', registeredSigner);

  if (process.env.STUB_SIGNER_PRIVATE_KEY) {
    const stubSignerAddr = new ethers.Wallet(process.env.STUB_SIGNER_PRIVATE_KEY).address;
    await (await payout.setSigner(stubSignerAddr, true, { gasLimit: 200_000 })).wait();
    console.log('Registered stub rehearsal signer', stubSignerAddr);
  }

  // Generous caps (not this repo's usual MONTHLY_CAP JPY-denominated values) — this deployment
  // moves raw/dust units against an 18-decimal token, not real JPY, so headroom isn't meaningful
  // in the same way; sized just to avoid CAP_EXCEEDED friction during rehearsal.
  const generousCap = 10_000_000n;
  for (const [triggerCode, coverageCode] of Object.entries(COVERAGE_CODE)) {
    await (await payout.setCap(coverageCode, generousCap, { gasLimit: 200_000 })).wait();
    console.log(`Set monthly cap for ${triggerCode} (${coverageCode}) -> ${generousCap}`);
  }

  const envPath = path.join(process.cwd(), '.env.rider-fallback');
  fs.writeFileSync(
    envPath,
    [
      `RIDER_FALLBACK_ADDR=${payoutAddr}`,
      `# wraps existing JPYC_ADDR=${jpycAddr}`,
    ].join('\n') + '\n'
  );
  console.log('Wrote', envPath);
  console.log('Paste RIDER_FALLBACK_ADDR into Render env vars. Fund the contract with JPYC next (transfer, not mint).');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
