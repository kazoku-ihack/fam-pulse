// One-shot Fuji deploy script. Run via:
//   npx hardhat run src/chain/deploy.js --network fuji
// Requires DEPLOYER_PRIVATE_KEY (funded from https://core.app/tools/testnet-faucet/) and
// REGISTERED_SIGNER (the Protosure rater's signing address) in .env. Not run automatically —
// paste the resulting addresses from .env.chain into Render env vars (JPYC_ADDR, PAYOUT_ADDR)
// and into the Protosure/Mendix mapping.

import hre from 'hardhat';
import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE_CODE, MONTHLY_CAP } from '../coverage.js';

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  console.log('Deploying with', deployer.address);

  if (!process.env.REGISTERED_SIGNER) {
    throw new Error('REGISTERED_SIGNER not set — needed to register the Protosure rater signer on-chain');
  }
  const registeredSigner = process.env.REGISTERED_SIGNER;
  const sakuraAddr = process.env.SAKURA_WALLET_ADDR || deployer.address;

  const DemoJPYC = await ethers.getContractFactory('DemoJPYC');
  const jpyc = await DemoJPYC.deploy(deployer.address);
  await jpyc.waitForDeployment();
  const jpycAddr = await jpyc.getAddress();
  console.log('DemoJPYC deployed to', jpycAddr);

  const MimamorParametric = await ethers.getContractFactory('MimamorParametric');
  const payout = await MimamorParametric.deploy(jpycAddr);
  await payout.waitForDeployment();
  const payoutAddr = await payout.getAddress();
  console.log('MimamorParametric deployed to', payoutAddr);

  await (await payout.setSigner(registeredSigner, true)).wait();
  console.log('Registered signer (Protosure rater)', registeredSigner);

  // Rehearsal-only: also register the local offline stub signer, if configured, so
  // ATTESTATION_MODE=stub can submit real payouts on Fuji for the demo.
  if (process.env.STUB_SIGNER_PRIVATE_KEY) {
    const stubSignerAddr = new ethers.Wallet(process.env.STUB_SIGNER_PRIVATE_KEY).address;
    await (await payout.setSigner(stubSignerAddr, true)).wait();
    console.log('Registered stub rehearsal signer', stubSignerAddr);
  }

  for (const [triggerCode, coverageCode] of Object.entries(COVERAGE_CODE)) {
    const amount = BigInt(MONTHLY_CAP[triggerCode]);
    await (await payout.setCap(coverageCode, amount)).wait();
    console.log(`Set monthly cap for ${triggerCode} (${coverageCode}) -> ${amount} JPY`);
  }

  const decimals = await jpyc.decimals();
  const poolAmount = ethers.parseUnits('1000000', decimals);
  const sakuraAmount = ethers.parseUnits('50000', decimals);

  await (await jpyc.mint(payoutAddr, poolAmount)).wait();
  console.log('Minted 1,000,000 tJPYC to payout pool');
  await (await jpyc.mint(sakuraAddr, sakuraAmount)).wait();
  console.log('Minted 50,000 tJPYC to', sakuraAddr);

  const envPath = path.join(process.cwd(), '.env.chain');
  fs.writeFileSync(
    envPath,
    [
      `JPYC_ADDR=${jpycAddr}`,
      `PAYOUT_ADDR=${payoutAddr}`,
      `SAKURA_WALLET_ADDR=${sakuraAddr}`,
      `REGISTERED_SIGNER=${registeredSigner}`,
    ].join('\n') + '\n'
  );
  console.log('Wrote', envPath);
  console.log('Paste JPYC_ADDR and PAYOUT_ADDR into Render env vars and the Protosure/Mendix mapping.');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
