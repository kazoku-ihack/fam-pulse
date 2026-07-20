import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { buildPayloadHash, signPayloadHash, randomNonce } from '../src/chain/chain.js';

// Pure crypto, no network/credentials needed — this is the REAL-LITE signing path exercised
// offline. Confirms our JS-side hash/signature scheme is exactly what KazokuPayout.sol's
// ecrecover reconstruction expects (see test/chain/KazokuPayout.test.js for the on-chain half).
test('buildPayloadHash + signPayloadHash round-trip verifies via ethers.verifyMessage', async () => {
  const wallet = ethers.Wallet.createRandom();
  const payload = {
    policyId: 'policy-1',
    triggerCode: 'PT-02',
    payoutAmount: 30000n * 10n ** 18n,
    recipient: ethers.Wallet.createRandom().address,
    timestamp: Date.now(),
    nonce: randomNonce(),
  };
  const hash = buildPayloadHash(payload);
  const signature = await signPayloadHash(wallet, hash);
  const recovered = ethers.verifyMessage(ethers.getBytes(hash), signature);
  assert.equal(recovered, wallet.address);
});

test('changing any payload field changes the hash', () => {
  const base = {
    policyId: 'policy-1',
    triggerCode: 'PT-02',
    payoutAmount: 30000,
    recipient: '0x' + '11'.repeat(20),
    timestamp: 1000,
    nonce: '0x' + '00'.repeat(32),
  };
  const h1 = buildPayloadHash(base);
  const h2 = buildPayloadHash({ ...base, payoutAmount: 30001 });
  assert.notEqual(h1, h2);
});

test('randomNonce produces distinct 32-byte hex values', () => {
  const a = randomNonce();
  const b = randomNonce();
  assert.notEqual(a, b);
  assert.equal(a.length, 66); // 0x + 64 hex chars
});
