// Manual rehearsal script for the protosure-direct flow (preTransferHash -> transfer) against a
// live deployment, using the registered "rehearsal signer" (STUB_SIGNER_PRIVATE_KEY's address) in
// place of Protosure's real key — this repo doesn't hold Protosure's actual private key, so this
// is the only way to produce a signature the deployed contracts will actually accept for testing.
// Not run automatically. Usage:
//
//   API_BASE_URL=https://fam-pulse-api.onrender.com \
//   API_KEY=<x-api-key> \
//   STUB_SIGNER_PRIVATE_KEY=<the rehearsal signer's private key> \
//   PAYOUT_ADDR=<must equal the live deployment's PAYOUT_ADDR> \
//   CHAIN_ID=43113 \
//   ATTESTER_ADDRESS=<must equal the live deployment's ATTESTER_ADDRESS> \
//   node src/chain/rehearse-protosure-direct.js [coverageCode] [payoutAmount]
//
// e.g. node src/chain/rehearse-protosure-direct.js 0x02 30000
//
// The digest is bound to PAYOUT_ADDR — matching both preTransferHash's request-body
// CONTRACT_ADDRESS_MISMATCH check AND what RIDER_FALLBACK_ADDR (MimamorParametricBind.sol)
// actually verifies against on-chain, since that contract checks a settable `bindAddress` (set to
// PAYOUT_ADDR at deploy time) instead of its own address(this) — specifically so a fallback
// contract living at a different address can still verify signatures signed against PAYOUT_ADDR,
// which is what Protosure's real signatures are bound to and therefore what this rehearsal signer
// must match too. An earlier version of both this script and the fallback contract bound the
// digest to the fallback's own address instead — that only ever worked for self-generated
// attestations like this script's, and silently failed for every real Mendix-originated one
// (confirmed live — see knowledge.md's RIDER_FALLBACK_ADDR/MimamorParametricBind investigation).
//
// Each run generates a fresh, unique trigger_ref (so on-chain NONCE_ALREADY_USED never blocks a
// repeat run) and prints the resulting Snowtrace link once the transfer confirms.

import { computeInner, signInner } from '../protosure/stub.js';
import { monthKeyTokyo } from '../attestation-rules.js';

const API_BASE_URL = process.env.API_BASE_URL || 'https://fam-pulse-api.onrender.com';
const API_KEY = required('API_KEY');
const STUB_SIGNER_PRIVATE_KEY = required('STUB_SIGNER_PRIVATE_KEY');
const PAYOUT_ADDR = required('PAYOUT_ADDR');
const CHAIN_ID = process.env.CHAIN_ID || '43113';
const ATTESTER_ADDRESS = required('ATTESTER_ADDRESS');
const RECIPIENT = process.env.RECIPIENT || '0xA615b21149212D63713Ad566103476A629a3417d';

const coverageCode = process.argv[2] || '0x02';
const payoutAmount = Number(process.argv[3] || 30000);

function required(key) {
  const v = process.env[key];
  if (!v) throw new Error(`${key} env var is required`);
  return v;
}

async function main() {
  const triggerRef = `REHEARSAL-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const monthKey = monthKeyTokyo(Date.now());
  const quoteId = `REHEARSAL-QUOTE-${Date.now()}`;

  const inner = computeInner({
    policyId: quoteId,
    triggerRef,
    coverageCode,
    payoutAmount,
    recipient: RECIPIENT,
    monthKey,
    contractAddress: PAYOUT_ADDR,
    chainId: CHAIN_ID,
  });
  // Signed by the registered rehearsal signer, not Protosure's real key — see header comment.
  const { payload_hash, signature } = signInner(inner, STUB_SIGNER_PRIVATE_KEY);

  console.log(`trigger_ref: ${triggerRef}`);
  console.log(`coverage_code: ${coverageCode}  payout_amount: ${payoutAmount}  monthKey: ${monthKey}`);

  const preBody = {
    quote_id: quoteId,
    coverage_code: coverageCode,
    recipient: RECIPIENT,
    payout_amount: payoutAmount,
    trigger_ref: triggerRef,
    incident_timestamp: Date.now(),
    contract_address: PAYOUT_ADDR,
    chain_id: CHAIN_ID,
    attester: {
      nonce: triggerRef,
      // The claimed signer must equal the live ATTESTER_ADDRESS — preTransferHash checks this
      // field directly, not by cryptographic recovery (see knowledge.md) — so this is the correct
      // way to pass that check even though the signature bytes below are actually produced by the
      // rehearsal key, not this address's real private key.
      signer: ATTESTER_ADDRESS,
      signature,
      payload_hash,
    },
  };

  const pre = await postJson('/v1/jpyc/preTransferHash', preBody);
  console.log('preTransferHash ->', pre.status, JSON.stringify(pre.body));
  if (pre.status !== 201) {
    console.error('preTransferHash failed — stopping.');
    process.exitCode = 1;
    return;
  }

  const transfer = await postJson('/v1/jpyc/transfer', { attestationId: pre.body.id });
  console.log('transfer ->', transfer.status, JSON.stringify(transfer.body));
  if (transfer.body.explorerUrl) {
    console.log('\nSnowtrace:', transfer.body.explorerUrl);
  } else if (transfer.body.status === 'pending') {
    console.log('\nStill pending (>10s) — poll GET /v1/attestation/' + pre.body.id + ' for the final txHash.');
  }
}

async function postJson(path, body) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
