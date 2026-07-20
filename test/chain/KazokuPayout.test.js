import { expect } from 'chai';
import hre from 'hardhat';
import { ethers } from 'ethers';
import { buildPayloadHash, signPayloadHash, randomNonce } from '../../src/chain/chain.js';

describe('KazokuPayout', function () {
  async function deployFixture() {
    const hhEthers = hre.ethers;
    const [owner, recipient] = await hhEthers.getSigners();
    const pinnedSigner = ethers.Wallet.createRandom();

    const DemoJPYC = await hhEthers.getContractFactory('DemoJPYC');
    const jpyc = await DemoJPYC.deploy(owner.address);
    await jpyc.waitForDeployment();

    const KazokuPayout = await hhEthers.getContractFactory('KazokuPayout');
    const payout = await KazokuPayout.deploy(owner.address, await jpyc.getAddress(), pinnedSigner.address);
    await payout.waitForDeployment();

    const decimals = await jpyc.decimals();
    await (await jpyc.mint(await payout.getAddress(), ethers.parseUnits('1000000', decimals))).wait();

    return { owner, recipient, pinnedSigner, jpyc, payout, decimals };
  }

  async function signedTrigger({ pinnedSigner, payout }, overrides = {}) {
    const base = {
      policyId: 'policy-1',
      triggerCode: 'PT-02',
      payoutAmount: ethers.parseUnits('30000', 18),
      recipient: overrides.recipient,
      timestamp: overrides.timestamp ?? Math.floor(Date.now() / 1000),
      nonce: overrides.nonce ?? randomNonce(),
    };
    const payload = { ...base, ...overrides };
    const hash = buildPayloadHash(payload);
    const signature = await signPayloadHash(overrides.signer ?? pinnedSigner, hash);
    return { payload, signature };
  }

  it('pays out DemoJPYC on a validly signed trigger and emits PayoutExecuted', async function () {
    const ctx = await deployFixture();
    const { payload, signature } = await signedTrigger(ctx, { recipient: ctx.recipient.address });

    const before = await ctx.jpyc.balanceOf(ctx.recipient.address);
    const tx = await ctx.payout.submitTrigger(
      payload.policyId,
      payload.triggerCode,
      payload.payoutAmount,
      payload.recipient,
      payload.timestamp,
      payload.nonce,
      signature
    );
    const receipt = await tx.wait();
    const after = await ctx.jpyc.balanceOf(ctx.recipient.address);
    expect(after - before).to.equal(payload.payoutAmount);

    const event = receipt.logs.find((l) => l.fragment && l.fragment.name === 'PayoutExecuted');
    expect(event).to.not.equal(undefined);
  });

  it('reverts SIGNER_MISMATCH for a signature from the wrong key', async function () {
    const ctx = await deployFixture();
    const wrongSigner = ethers.Wallet.createRandom();
    const { payload, signature } = await signedTrigger(ctx, { recipient: ctx.recipient.address, signer: wrongSigner });

    await expect(
      ctx.payout.submitTrigger(payload.policyId, payload.triggerCode, payload.payoutAmount, payload.recipient, payload.timestamp, payload.nonce, signature)
    ).to.be.revertedWith('SIGNER_MISMATCH');
  });

  it('reverts NONCE_ALREADY_USED on nonce reuse', async function () {
    const ctx = await deployFixture();
    const nonce = randomNonce();
    const { payload, signature } = await signedTrigger(ctx, { recipient: ctx.recipient.address, nonce });

    await ctx.payout.submitTrigger(payload.policyId, payload.triggerCode, payload.payoutAmount, payload.recipient, payload.timestamp, payload.nonce, signature);

    await expect(
      ctx.payout.submitTrigger(payload.policyId, payload.triggerCode, payload.payoutAmount, payload.recipient, payload.timestamp, payload.nonce, signature)
    ).to.be.revertedWith('NONCE_ALREADY_USED');
  });

  it('enforces the PT-01 monthly cool-down (max 2 per 30-day bucket)', async function () {
    const ctx = await deployFixture();
    const bucketTs = 1_800_000_000; // fixed timestamp so both calls land in the same 30-day bucket

    for (let i = 0; i < 2; i++) {
      const { payload, signature } = await signedTrigger(ctx, {
        recipient: ctx.recipient.address,
        triggerCode: 'PT-01',
        payoutAmount: ethers.parseUnits('3000', 18),
        timestamp: bucketTs + i, // distinct nonces/timestamps, same 30-day bucket
      });
      await ctx.payout.submitTrigger(payload.policyId, payload.triggerCode, payload.payoutAmount, payload.recipient, payload.timestamp, payload.nonce, signature);
    }

    const { payload, signature } = await signedTrigger(ctx, {
      recipient: ctx.recipient.address,
      triggerCode: 'PT-01',
      payoutAmount: ethers.parseUnits('3000', 18),
      timestamp: bucketTs + 2,
    });
    await expect(
      ctx.payout.submitTrigger(payload.policyId, payload.triggerCode, payload.payoutAmount, payload.recipient, payload.timestamp, payload.nonce, signature)
    ).to.be.revertedWith('COOLDOWN_EXCEEDED');
  });

  it('owner can update the pinned signer', async function () {
    const ctx = await deployFixture();
    const newSigner = ethers.Wallet.createRandom();
    await ctx.payout.setPinnedSigner(newSigner.address);
    expect(await ctx.payout.pinnedSigner()).to.equal(newSigner.address);

    const { payload, signature } = await signedTrigger(ctx, { recipient: ctx.recipient.address, signer: newSigner });
    await expect(
      ctx.payout.submitTrigger(payload.policyId, payload.triggerCode, payload.payoutAmount, payload.recipient, payload.timestamp, payload.nonce, signature)
    ).to.not.be.reverted;
  });
});
