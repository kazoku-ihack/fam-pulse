// One-shot Fuji deploy script. Run via:
//   npx hardhat run src/chain/deploy.js --network fuji
// Requires DEPLOYER_PRIVATE_KEY (funded from https://core.app/tools/testnet-faucet/) and
// SIGNER_PRIVATE_KEY (throwaway, Fuji-only) in .env. Not run automatically — paste the
// resulting addresses from .env.chain into Render env vars (JPYC_ADDR, PAYOUT_ADDR).

import hre from 'hardhat';
import fs from 'node:fs';
import path from 'node:path';

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  console.log('Deploying with', deployer.address);

  if (!process.env.SIGNER_PRIVATE_KEY) {
    throw new Error('SIGNER_PRIVATE_KEY not set — needed to pin the attestation signer address');
  }
  const signerAddr = new ethers.Wallet(process.env.SIGNER_PRIVATE_KEY).address;
  const sakuraAddr = process.env.SAKURA_WALLET_ADDR || deployer.address;

  const DemoJPYC = await ethers.getContractFactory('DemoJPYC');
  const jpyc = await DemoJPYC.deploy(deployer.address);
  await jpyc.waitForDeployment();
  const jpycAddr = await jpyc.getAddress();
  console.log('DemoJPYC deployed to', jpycAddr);

  const KazokuPayout = await ethers.getContractFactory('KazokuPayout');
  const payout = await KazokuPayout.deploy(deployer.address, jpycAddr, signerAddr);
  await payout.waitForDeployment();
  const payoutAddr = await payout.getAddress();
  console.log('KazokuPayout deployed to', payoutAddr);

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
    [`JPYC_ADDR=${jpycAddr}`, `PAYOUT_ADDR=${payoutAddr}`, `SAKURA_WALLET_ADDR=${sakuraAddr}`, `PINNED_SIGNER_ADDR=${signerAddr}`].join(
      '\n'
    ) + '\n'
  );
  console.log('Wrote', envPath);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
