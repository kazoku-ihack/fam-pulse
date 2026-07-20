// Offline stand-in for src/chain/chain.js, injected into routes via their `{ chain }` deps
// param. Lets attestation/payments tests exercise HTTP-level behavior (403s, error mapping,
// event logging) without any real network, funded key, or deployed contract.

let nonceCounter = 0;

export function makeFakeChain(overrides = {}) {
  const usedNonces = new Set(overrides.usedNonces || []);
  return {
    isSignerConfigured: () => true,
    isChainDeployed: () => true,
    getSignerWallet: () => ({ address: '0xFakeSignerAddress000000000000000000001' }),
    getJpycContract: () => ({
      balanceOf: async () => 1_000_000n * 10n ** 18n,
      decimals: async () => 18,
    }),
    getPayoutContract: () => ({
      submitTrigger: async (policyId, triggerCode, amountUnits, recipient, timestamp, nonce, signature) => {
        if (usedNonces.has(nonce)) {
          const err = new Error('execution reverted: NONCE_ALREADY_USED');
          err.reason = 'NONCE_ALREADY_USED';
          throw err;
        }
        usedNonces.add(nonce);
        return {
          wait: async () => ({ hash: '0x' + 'ab'.repeat(32) }),
        };
      },
    }),
    buildPayloadHash: () => '0x' + 'cd'.repeat(32),
    signPayloadHash: async () => '0x' + 'ef'.repeat(65),
    randomNonce: () => '0xnonce' + String(nonceCounter++).padStart(58, '0'),
    explorerUrl: (hash) => `https://testnet.snowtrace.io/tx/${hash}`,
    ...overrides,
  };
}
