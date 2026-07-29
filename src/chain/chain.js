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

let cachedProvider = null;
export function getProvider() {
  if (!process.env.FUJI_RPC) throw new ChainNotConfiguredError('FUJI_RPC not set');
  if (!cachedProvider) cachedProvider = new ethers.JsonRpcProvider(process.env.FUJI_RPC);
  return cachedProvider;
}

// The wallet that submits (pays gas for) submitTrigger transactions. submitTrigger has no
// msg.sender restriction — anyone can relay a validly-signed payload — so this is unrelated to
// the attestation signer. STUB_SIGNER_PRIVATE_KEY doubles as the relayer wallet in both stub and
// protosure mode.
export function getRelayerWallet() {
  const key = process.env.STUB_SIGNER_PRIVATE_KEY;
  if (!key) throw new ChainNotConfiguredError('STUB_SIGNER_PRIVATE_KEY not set');
  try {
    return new ethers.Wallet(key, getProvider());
  } catch {
    return new ethers.Wallet(key);
  }
}

// Sakura's own wallet key — a second, deliberate private key alongside STUB_SIGNER_PRIVATE_KEY.
// Unlike every other payout in this service (funded from MimamorParametric's own pool via a
// signed attestation), the taxi ride-fee payment (routes/dispatch.js#payDriverForDispatch) is a
// literal transfer out of Sakura's own JPYC balance, which only her own key can authorize — the
// relayer wallet has no authority over her funds.
//
// `privateKey`, if given, is an explicit per-request key (e.g. typed into the Judge Console) and
// always wins over SAKURA_WALLET_PRIVATE_KEY — same "explicit per-call value beats the standing
// env var" convention as src/claude/client.js's per-call apiKey. Never cached, never persisted;
// it lives only for the duration of the ethers.Wallet instance built here.
export function getSakuraWallet(privateKey) {
  const key = privateKey || process.env.SAKURA_WALLET_PRIVATE_KEY;
  if (!key) throw new ChainNotConfiguredError('SAKURA_WALLET_PRIVATE_KEY not set');
  const wallet = (() => {
    try {
      return new ethers.Wallet(key, getProvider());
    } catch {
      return new ethers.Wallet(key);
    }
  })();
  if (process.env.SAKURA_WALLET_ADDR && wallet.address.toLowerCase() !== process.env.SAKURA_WALLET_ADDR.toLowerCase()) {
    console.warn(
      `Sakura signing key recovers to ${wallet.address}, which does not match SAKURA_WALLET_ADDR ` +
      `(${process.env.SAKURA_WALLET_ADDR}) — driver payments will be sent from the key's address, not the ` +
      `configured display address.`
    );
  }
  return wallet;
}

export function isChainDeployed() {
  return Boolean(process.env.FUJI_RPC && process.env.JPYC_ADDR && process.env.PAYOUT_ADDR);
}

export function isRelayerConfigured() {
  return Boolean(process.env.STUB_SIGNER_PRIVATE_KEY);
}

export function isSakuraWalletConfigured(privateKey) {
  return Boolean(privateKey || process.env.SAKURA_WALLET_PRIVATE_KEY);
}

export function getJpycContract(runner) {
  if (!process.env.JPYC_ADDR) throw new ChainNotConfiguredError('JPYC_ADDR not set');
  return new ethers.Contract(process.env.JPYC_ADDR, ERC20_ABI, runner || getProvider());
}

export function getPayoutContract(runner) {
  if (!process.env.PAYOUT_ADDR) throw new ChainNotConfiguredError('PAYOUT_ADDR not set');
  return new ethers.Contract(process.env.PAYOUT_ADDR, PAYOUT_ABI, runner || getProvider());
}

export function explorerUrl(txHash) {
  return `https://testnet.snowtrace.io/tx/${txHash}`;
}

export const chain = {
  getProvider,
  getRelayerWallet,
  getSakuraWallet,
  isChainDeployed,
  isRelayerConfigured,
  isSakuraWalletConfigured,
  getJpycContract,
  getPayoutContract,
  explorerUrl,
};
