// One-off fallback deploy script v2 — supersedes deploy-rider-fallback.js. Run via:
//   npx hardhat run src/chain/deploy-rider-fallback-bind.js --network fuji
//
// Why this exists (2026-07-30, later same day): the first RIDER_FALLBACK_ADDR deployment
// (deploy-rider-fallback.js, MimamorParametric.sol unmodified) only worked for attestations we
// generated ourselves, because it binds its digest to its own address(this). Protosure signs real
// attestations against PAYOUT_ADDR regardless of where any fallback contract lives, so a real
// Mendix-originated attesterSig would never match what the first fallback reconstructs on-chain —
// confirmed live: recomputed a real attestation's digest bound to PAYOUT_ADDR (exact match,
// recovers to the real registered signer) vs bound to the old fallback address (no match at all).
// MimamorParametricBind.sol fixes this: its digest binds a settable `bindAddress` (set to
// PAYOUT_ADDR here) instead of address(this), so it can be deployed anywhere and still verify
// signatures signed against PAYOUT_ADDR. See knowledge.md.
//
// Requires DEPLOYER_PRIVATE_KEY (funded on Fuji), REGISTERED_SIGNER, PAYOUT_ADDR (the bind
// target — what Protosure actually signs against), and JPYC_ADDR (the existing real token, not a
// new one) in the environment. Paste the resulting address into RIDER_FALLBACK_ADDR on Render.

import hre from 'hardhat';
import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE_CODE } from '../coverage.js';

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  console.log('Deploying with', deployer.address);

  if (!process.env.REGISTERED_SIGNER) throw new Error('REGISTERED_SIGNER not set');
  if (!process.env.JPYC_ADDR) throw new Error('JPYC_ADDR not set — wraps the existing token, does not deploy a new one');
  if (!process.env.PAYOUT_ADDR) throw new Error('PAYOUT_ADDR not set — this is the bind target');
  const registeredSigner = process.env.REGISTERED_SIGNER;
  const jpycAddr = process.env.JPYC_ADDR;
  const bindAddr = process.env.PAYOUT_ADDR;

  const MimamorParametricBind = await ethers.getContractFactory('MimamorParametricBind');
  const payout = await MimamorParametricBind.deploy(jpycAddr, bindAddr, { gasLimit: 3_000_000 });
  await payout.waitForDeployment();
  const payoutAddr = await payout.getAddress();
  console.log('MimamorParametricBind deployed to', payoutAddr, 'bound to', bindAddr, 'wrapping JPYC', jpycAddr);

  await (await payout.setSigner(registeredSigner, true, { gasLimit: 200_000 })).wait();
  console.log('Registered signer (Protosure rater)', registeredSigner);

  if (process.env.STUB_SIGNER_PRIVATE_KEY) {
    const stubSignerAddr = new ethers.Wallet(process.env.STUB_SIGNER_PRIVATE_KEY).address;
    await (await payout.setSigner(stubSignerAddr, true, { gasLimit: 200_000 })).wait();
    console.log('Registered stub rehearsal signer', stubSignerAddr);
  }

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
      `# bound to PAYOUT_ADDR=${bindAddr}, wraps JPYC_ADDR=${jpycAddr}`,
    ].join('\n') + '\n'
  );
  console.log('Wrote', envPath);
  console.log('Paste RIDER_FALLBACK_ADDR into Render env vars. Fund the contract with JPYC next (transfer, not mint).');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
