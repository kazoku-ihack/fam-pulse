// Offline stand-in for src/chain/chain.js, injected into routes via their `{ chain }` deps
// param. Lets attestation/payments tests exercise HTTP-level behavior (403s, error mapping,
// event logging) without any real network, funded key, or deployed contract.

export function makeFakeChain(overrides = {}) {
  const usedTriggerRefs = new Set(overrides.usedTriggerRefs || []);
  return {
    isRelayerConfigured: () => true,
    isChainDeployed: () => true,
    isRiderDeployed: () => true,
    isRiderFallbackConfigured: () => false,
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
    // Rider's submitTrigger verifies both oracleSig and attesterSig over the evidenceHash-based
    // digest — same replay-guard shape as getPayoutContract's mock above, keyed by evidenceHash
    // (derived from triggerRef) instead of triggerRef directly.
    getRiderContract: () => ({
      submitTrigger: async (evidenceHash, beneficiary, incidentTimestamp, amount, oracleSig, attesterSig) => {
        if (usedTriggerRefs.has(evidenceHash)) {
          const err = new Error('execution reverted: NONCE_ALREADY_USED');
          err.reason = 'NONCE_ALREADY_USED';
          throw err;
        }
        usedTriggerRefs.add(evidenceHash);
        return {
          wait: async () => ({ hash: '0x' + 'cd'.repeat(32) }),
        };
      },
    }),
    // Same single-sig shape as getPayoutContract's mock — RIDER_FALLBACK_ADDR wraps an unmodified
    // MimamorParametric instance, just a different address.
    getRiderFallbackContract: () => ({
      submitTrigger: async (policyId, triggerRef, coverageCode, amountJpy, recipient, monthKey, signature) => {
        if (usedTriggerRefs.has(triggerRef)) {
          const err = new Error('execution reverted: NONCE_ALREADY_USED');
          err.reason = 'NONCE_ALREADY_USED';
          throw err;
        }
        usedTriggerRefs.add(triggerRef);
        return {
          wait: async () => ({ hash: '0x' + 'ef'.repeat(32) }),
        };
      },
    }),
    explorerUrl: (hash) => `https://testnet.snowtrace.io/tx/${hash}`,
    ...overrides,
  };
}
