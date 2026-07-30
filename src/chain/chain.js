// ethers v6 provider/relayer/contract helpers. Deliberately uses hand-written ABI fragments
// instead of importing Hardhat build artifacts, so the API server never depends on a
// `hardhat compile` step at runtime (Render just runs `npm ci && node src/server.js`).
//
// Signing an attestation (producing the ECDSA signature the contract verifies) is no longer
// this module's job — that's src/protosure/stub.js (offline) or src/protosure/rater-client.js
// (Protosure). This module only submits already-signed payloads on-chain, which requires a
// funded wallet to pay gas but has nothing to do with whose signature is inside the payload.

import { ethers } from 'ethers';

export class ChainNotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.code = 'CHAIN_NOT_CONFIGURED';
  }
}

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function mint(address to, uint256 amount)',
];

const PAYOUT_ABI = [
  'function submitTrigger(string policyIdStr, string triggerRefStr, bytes1 coverageCode, uint256 amountJpy, address recipient, uint256 monthKey, bytes signature)',
  'function isRegisteredSigner(address) view returns (bool)',
  'function usedNonce(bytes32) view returns (bool)',
  'function cap(bytes1) view returns (uint256)',
  'function monthSpend(bytes1, uint256) view returns (uint256)',
  'function setSigner(address signer, bool enabled)',
  'function setCap(bytes1 coverageCode, uint256 amount)',
  'event PayoutExecuted(bytes32 indexed triggerRef, bytes32 indexed policyId, bytes1 coverageCode, uint256 amountJpy, address recipient, uint256 monthKey, address signer)',
];

// The externally-deployed Rider contract used only for attestations sourced from the
// Mendix/Protosure-direct flow (source:"protosure-direct") — its submitTrigger takes two
// independently-verified signatures (oracleSig + attesterSig, each over its own digest), rather
// than PAYOUT_ABI's single `signature`. See routes/payments.js#executePayoutOnChain.
const RIDER_ABI = [
  'function submitTrigger(bytes32 evidenceHash, address beneficiary, uint256 incidentTimestamp, uint256 amount, bytes oracleSig, bytes attesterSig)',
];

let cachedProvider = null;
export function getProvider() {
  if (!process.env.FUJI_RPC) throw new ChainNotConfiguredError('FUJI_RPC not set');
  if (!cachedProvider) cachedProvider = new ethers.JsonRpcProvider(process.env.FUJI_RPC);
  return cachedProvider;
}

// The wallet that submits (pays gas for) submitTrigger transactions. submitTrigger has no
// msg.sender restriction — anyone can relay a validly-signed payload — so this is unrelated to
// the attestation signer. STUB_SIGNER_PRIVATE_KEY is the only private key left in this service's
// env (see .env.example); it doubles as the relayer wallet in both stub and protosure mode.
export function getRelayerWallet() {
  const key = process.env.STUB_SIGNER_PRIVATE_KEY;
  if (!key) throw new ChainNotConfiguredError('STUB_SIGNER_PRIVATE_KEY not set');
  try {
    return new ethers.Wallet(key, getProvider());
  } catch {
    return new ethers.Wallet(key);
  }
}

export function isChainDeployed() {
  return Boolean(process.env.FUJI_RPC && process.env.JPYC_ADDR && process.env.PAYOUT_ADDR);
}

export function isRiderDeployed() {
  return Boolean(process.env.FUJI_RPC && (process.env.RIDER_ADDR || process.env.PAYOUT_ADDR));
}

export function isRelayerConfigured() {
  return Boolean(process.env.STUB_SIGNER_PRIVATE_KEY || process.env.RELAYER_PRIVATE_KEY);
}

export function getJpycContract(runner) {
  if (!process.env.JPYC_ADDR) throw new ChainNotConfiguredError('JPYC_ADDR not set');
  return new ethers.Contract(process.env.JPYC_ADDR, ERC20_ABI, runner || getProvider());
}

export function getPayoutContract(runner) {
  if (!process.env.PAYOUT_ADDR) throw new ChainNotConfiguredError('PAYOUT_ADDR not set');
  return new ethers.Contract(process.env.PAYOUT_ADDR, PAYOUT_ABI, runner || getProvider());
}

export function getRiderContract(runner) {
  const riderAddr = process.env.RIDER_ADDR || process.env.PAYOUT_ADDR;
  if (!riderAddr) throw new ChainNotConfiguredError('RIDER_ADDR (or PAYOUT_ADDR) not set');
  return new ethers.Contract(riderAddr, RIDER_ABI, runner || getProvider());
}

export function explorerUrl(txHash) {
  return `https://testnet.snowtrace.io/tx/${txHash}`;
}

export const chain = {
  getProvider,
  getRelayerWallet,
  isChainDeployed,
  isRiderDeployed,
  isRelayerConfigured,
  getJpycContract,
  getPayoutContract,
  getRiderContract,
  explorerUrl,
};
