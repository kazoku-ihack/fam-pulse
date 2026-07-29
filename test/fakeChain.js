// Offline stand-in for src/chain/chain.js, injected into routes via their `{ chain }` deps
// param. Lets attestation/payments tests exercise HTTP-level behavior (403s, error mapping,
// event logging) without any real network, funded key, or deployed contract.

export function makeFakeChain(overrides = {}) {
  const usedTriggerRefs = new Set(overrides.usedTriggerRefs || []);
  return {
    isRelayerConfigured: () => true,
    isChainDeployed: () => true,
    getRelayerWallet: () => ({ address: '0xFakeRelayerAddress00000000000000000001' }),
    getJpycContract: () => ({
      balanceOf: async () => 1_000_000n,
      decimals: async () => 0,
    }),
    getPayoutContract: () => ({
      submitTrigger: async (policyId, triggerRef, coverageCode, amountJpy, recipient, monthKey, signature) => {
        if (usedTriggerRefs.has(triggerRef)) {
          const err = new Error('execution reverted: NONCE_ALREADY_USED');
          err.reason = 'NONCE_ALREADY_USED';
          throw err;
        }
        usedTriggerRefs.add(triggerRef);
        return {
          wait: async () => ({ hash: '0x' + 'ab'.repeat(32) }),
        };
      },
      isRegisteredSigner: async () => true,
    }),
    explorerUrl: (hash) => `https://testnet.snowtrace.io/tx/${hash}`,
    ...overrides,
  };
}
