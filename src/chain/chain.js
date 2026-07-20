// ethers v6 provider/signer/contract helpers. Deliberately uses hand-written ABI fragments
// instead of importing Hardhat build artifacts, so the API server never depends on a
// `hardhat compile` step at runtime (Render just runs `npm ci && node src/server.js`).

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
  'function submitTrigger(string policyId, string triggerCode, uint256 payoutAmount, address recipient, uint256 timestamp, bytes32 nonce, bytes signature)',
  'function usedNonces(bytes32) view returns (bool)',
  'function pinnedSigner() view returns (address)',
  'function setPinnedSigner(address signer)',
  'event PayoutExecuted(string policyId, string triggerCode, uint256 payoutAmount, address recipient, uint256 timestamp, bytes32 nonce, bytes32 payloadHash, address signer)',
];

let cachedProvider = null;
export function getProvider() {
  if (!process.env.FUJI_RPC) throw new ChainNotConfiguredError('FUJI_RPC not set');
  if (!cachedProvider) cachedProvider = new ethers.JsonRpcProvider(process.env.FUJI_RPC);
  return cachedProvider;
}

// Signing a payloadHash is pure crypto and needs no network access — only attach a provider
// (for balance reads / tx submission elsewhere) when FUJI_RPC happens to be configured too.
export function getSignerWallet(privateKeyEnvVar = 'SIGNER_PRIVATE_KEY') {
  const key = process.env[privateKeyEnvVar];
  if (!key) throw new ChainNotConfiguredError(`${privateKeyEnvVar} not set`);
  try {
    return new ethers.Wallet(key, getProvider());
  } catch {
    return new ethers.Wallet(key);
  }
}

export function isChainDeployed() {
  return Boolean(process.env.FUJI_RPC && process.env.JPYC_ADDR && process.env.PAYOUT_ADDR);
}

export function isSignerConfigured() {
  return Boolean(process.env.SIGNER_PRIVATE_KEY);
}

export function getJpycContract(runner) {
  if (!process.env.JPYC_ADDR) throw new ChainNotConfiguredError('JPYC_ADDR not set');
  return new ethers.Contract(process.env.JPYC_ADDR, ERC20_ABI, runner || getProvider());
}

export function getPayoutContract(runner) {
  if (!process.env.PAYOUT_ADDR) throw new ChainNotConfiguredError('PAYOUT_ADDR not set');
  return new ethers.Contract(process.env.PAYOUT_ADDR, PAYOUT_ABI, runner || getProvider());
}

// Must match KazokuPayout.sol's `keccak256(abi.encode(policyId, triggerCode, payoutAmount,
// recipient, timestamp, nonce))` exactly.
export function buildPayloadHash({ policyId, triggerCode, payoutAmount, recipient, timestamp, nonce }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['string', 'string', 'uint256', 'address', 'uint256', 'bytes32'],
      [policyId, triggerCode, payoutAmount, recipient, timestamp, nonce]
    )
  );
}

// personal_sign over the payloadHash bytes — matches the contract's
// "\x19Ethereum Signed Message:\n32" + hash reconstruction, verified via ecrecover.
export async function signPayloadHash(wallet, payloadHash) {
  return wallet.signMessage(ethers.getBytes(payloadHash));
}

export function randomNonce() {
  return ethers.hexlify(ethers.randomBytes(32));
}

export function explorerUrl(txHash) {
  return `https://testnet.snowtrace.io/tx/${txHash}`;
}

export const chain = {
  getProvider,
  getSignerWallet,
  isChainDeployed,
  isSignerConfigured,
  getJpycContract,
  getPayoutContract,
  buildPayloadHash,
  signPayloadHash,
  randomNonce,
  explorerUrl,
};
