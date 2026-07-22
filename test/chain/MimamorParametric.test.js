import { expect } from 'chai';
import hre from 'hardhat';
import { ethers } from 'ethers';
import { computeInner, signInner } from '../../src/protosure/stub.js';

const DEMO_KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const GOLDEN_PAYLOAD_HASH = '0xc1b318da13d253576a3a51eb16289aa9ab31141cd8d3acd003049c087a77fd4d';
const GOLDEN_SIGNER = '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23';

describe('MimamorParametric', function () {
  async function deployFixture() {
    const hhEthers = hre.ethers;
    const [owner, recipient] = await hhEthers.getSigners();

    const DemoJPYC = await hhEthers.getContractFactory('DemoJPYC');
    const jpyc = await DemoJPYC.deploy(owner.address);
    await jpyc.waitForDeployment();
    const jpycAddr = await jpyc.getAddress();

    const MimamorParametric = await hhEthers.getContractFactory('MimamorParametric');
    const payout = await MimamorParametric.deploy(jpycAddr);
    await payout.waitForDeployment();
    const payoutAddr = await payout.getAddress();

    await (await jpyc.mint(payoutAddr, 10_000_000)).wait(); // whole-JPY, decimals=0

    return { owner, recipient, jpyc, payout, payoutAddr };
  }

  function fields(ctx, overrides = {}) {
    return {
      policyId: 'KP-2026-001',
      triggerRef: `TRG-${Math.random().toString(36).slice(2)}`,
      coverageCode: '0x01',
      payoutAmount: 3000,
      recipient: ctx.recipient.address,
      monthKey: '202608',
      contractAddress: ctx.payoutAddr,
      chainId: '43113',
      ...overrides,
    };
  }

  it('digest parity: the golden vector reproduces exactly, and the contract accepts it', async function () {
    const ctx = await deployFixture();
    await (await ctx.payout.setSigner(GOLDEN_SIGNER, true)).wait();
    await (await ctx.payout.setCap('0x01', 100000)).wait();

    const goldenFields = {
      policyId: 'KP-2026-001',
      triggerRef: 'TRG-0001',
      coverageCode: '0x01',
      payoutAmount: '3000',
      recipient: '0x742d35Cc6634C0532925a3b8D4C9C0f25B4f2F9a',
      monthKey: '202608',
      contractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      chainId: '43113',
    };
    const inner = computeInner(goldenFields);
    const { payload_hash, signature, signer } = signInner(inner, DEMO_KEY);
    expect(payload_hash).to.equal(GOLDEN_PAYLOAD_HASH);
    expect(signer.toLowerCase()).to.equal(GOLDEN_SIGNER);

    // Re-derive against THIS deployment's real address/chainId (Hardhat's chainId isn't 43113,
    // and the deployed contract address differs from the golden fixture's) to prove the contract
    // itself accepts a stub-signed payload built from live values, not just the fixed vector.
    const network = await hre.ethers.provider.getNetwork();
    const live = fields(ctx, { policyId: 'KP-2026-001', triggerRef: 'TRG-0001', chainId: String(network.chainId) });
    const liveInner = computeInner(live);
    const liveSigned = signInner(liveInner, DEMO_KEY);
    await (await ctx.payout.setSigner(liveSigned.signer, true)).wait();

    const before = await ctx.jpyc.balanceOf(live.recipient);
    await ctx.payout.submitTrigger(live.policyId, live.triggerRef, live.coverageCode, live.payoutAmount, live.recipient, live.monthKey, liveSigned.signature);
    const after = await ctx.jpyc.balanceOf(live.recipient);
    expect(after - before).to.equal(3000n);
  });

  it('reverts SIGNER_MISMATCH for an unregistered signer', async function () {
    const ctx = await deployFixture();
    const network = await hre.ethers.provider.getNetwork();
    const f = fields(ctx, { chainId: String(network.chainId) });
    const inner = computeInner(f);
    const unregisteredKey = ethers.Wallet.createRandom().privateKey.slice(2);
    const { signature } = signInner(inner, unregisteredKey);

    await expect(
      ctx.payout.submitTrigger(f.policyId, f.triggerRef, f.coverageCode, f.payoutAmount, f.recipient, f.monthKey, signature)
    ).to.be.revertedWith('SIGNER_MISMATCH');
  });

  it('reverts NONCE_ALREADY_USED on triggerRef replay', async function () {
    const ctx = await deployFixture();
    const network = await hre.ethers.provider.getNetwork();
    const f = fields(ctx, { chainId: String(network.chainId) });
    const inner = computeInner(f);
    const { signature, signer } = signInner(inner, DEMO_KEY);
    await (await ctx.payout.setSigner(signer, true)).wait();
    await (await ctx.payout.setCap('0x01', 100000)).wait();

    await ctx.payout.submitTrigger(f.policyId, f.triggerRef, f.coverageCode, f.payoutAmount, f.recipient, f.monthKey, signature);
    await expect(
      ctx.payout.submitTrigger(f.policyId, f.triggerRef, f.coverageCode, f.payoutAmount, f.recipient, f.monthKey, signature)
    ).to.be.revertedWith('NONCE_ALREADY_USED');
  });

  it('enforces the monthly cap per coverage code, and a new monthKey resets headroom', async function () {
    const ctx = await deployFixture();
    const network = await hre.ethers.provider.getNetwork();
    await (await ctx.payout.setCap('0x01', 6000)).wait(); // room for exactly two 3000 payouts

    async function submit(monthKey, triggerRef) {
      const f = fields(ctx, { chainId: String(network.chainId), monthKey, triggerRef, payoutAmount: 3000 });
      const inner = computeInner(f);
      const { signature, signer } = signInner(inner, DEMO_KEY);
      await (await ctx.payout.setSigner(signer, true)).wait();
      return ctx.payout.submitTrigger(f.policyId, f.triggerRef, f.coverageCode, f.payoutAmount, f.recipient, f.monthKey, signature);
    }

    await (await submit('202608', 'TRG-cap-1')).wait();
    await (await submit('202608', 'TRG-cap-2')).wait();
    await expect(submit('202608', 'TRG-cap-3')).to.be.revertedWith('CAP_EXCEEDED');

    // A new monthKey has fresh headroom.
    await expect(submit('202609', 'TRG-cap-4')).to.not.be.reverted;
  });

  it('EIP-191 guard: a signature over the raw (unprefixed) inner hash is rejected', async function () {
    const ctx = await deployFixture();
    const network = await hre.ethers.provider.getNetwork();
    const f = fields(ctx, { chainId: String(network.chainId) });
    const inner = computeInner(f);

    // Sign the raw inner hash directly, WITHOUT the "\x19Ethereum Signed Message:\n32" prefix
    // the contract expects — this is exactly the double-prefix-avoidance mistake in reverse.
    const signingKey = new ethers.SigningKey('0x' + DEMO_KEY);
    const rawSig = signingKey.sign(inner).serialized;
    await (await ctx.payout.setSigner(GOLDEN_SIGNER, true)).wait();

    await expect(
      ctx.payout.submitTrigger(f.policyId, f.triggerRef, f.coverageCode, f.payoutAmount, f.recipient, f.monthKey, rawSig)
    ).to.be.revertedWith('SIGNER_MISMATCH');
  });
});
