// Offline signer reproducing the Protosure rater's exact digest scheme — used for
// ATTESTATION_MODE=stub (local rehearsal, zero external dependency) and as the fallback path
// when the live rater is unreachable in ATTESTATION_MODE=protosure. Rule validation does NOT
// live here — see src/attestation-rules.js, shared identically by both modes.
//
// Digest scheme (must match MimamorParametric.sol's computeInner + EIP-191 wrapping exactly):
//   inner  = keccak256(abi.encodePacked(
//              keccak256(triggerRef), keccak256(policyId), coverageCode, payoutAmount,
//              recipient, monthKey, contractAddress, chainId))
//   digest = keccak256("\x19Ethereum Signed Message:\n32" || inner)   // EIP-191
// `payload_hash` (as returned to callers and stored on the attestation) is `digest`, not
// `inner` — that's what the contract's ECDSA.recover verifies against.

import { ethers } from 'ethers';

export class StubSignerNotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.code = 'STUB_SIGNER_NOT_CONFIGURED';
  }
}

function normalizeKey(key) {
  return key.startsWith('0x') ? key : `0x${key}`;
}

// fields: { policyId, triggerRef, coverageCode, payoutAmount, recipient, monthKey, contractAddress, chainId }
export function computeInner({ policyId, triggerRef, coverageCode, payoutAmount, recipient, monthKey, contractAddress, chainId }) {
  const triggerRefHash = ethers.keccak256(ethers.toUtf8Bytes(triggerRef));
  const policyIdHash = ethers.keccak256(ethers.toUtf8Bytes(policyId));
  return ethers.keccak256(
    ethers.solidityPacked(
      ['bytes32', 'bytes32', 'bytes1', 'uint256', 'address', 'uint256', 'address', 'uint256'],
      [
        triggerRefHash,
        policyIdHash,
        coverageCode,
        BigInt(payoutAmount),
        recipient.toLowerCase(),
        BigInt(monthKey),
        contractAddress.toLowerCase(),
        BigInt(chainId),
      ]
    )
  );
}

// Signs a precomputed `inner` hash directly via SigningKey — NOT wallet.signMessage, which
// would re-apply the EIP-191 prefix on top of our already-prefixed digest (double-prefix bug).
export function signInner(inner, privateKey) {
  const digest = ethers.hashMessage(ethers.getBytes(inner));
  const signingKey = new ethers.SigningKey(normalizeKey(privateKey));
  const signature = signingKey.sign(digest).serialized;
  const signer = ethers.recoverAddress(digest, signature);
  return { payload_hash: digest, signature, signer };
}

export function signTrigger(fields) {
  const privateKey = process.env.STUB_SIGNER_PRIVATE_KEY;
  if (!privateKey) {
    throw new StubSignerNotConfiguredError('STUB_SIGNER_PRIVATE_KEY not set');
  }
  const inner = computeInner(fields);
  const { payload_hash, signature, signer } = signInner(inner, privateKey);
  return { payload_hash, signature, signer, source: 'stub' };
}
