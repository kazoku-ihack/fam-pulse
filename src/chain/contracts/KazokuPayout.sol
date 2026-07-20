// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Verifies an off-chain attestation signature (pinned signer, replay-proof via
/// nonce, per-trigger monthly cool-down) then pays out DemoJPYC from its own funded pool.
/// Deterministic on-chain rules are the source of truth for money — nothing upstream of this
/// contract (including any LLM-assisted screening) can gate or skip these checks.
contract KazokuPayout is Ownable {
    IERC20 public immutable jpyc;
    address public pinnedSigner;

    mapping(bytes32 => bool) public usedNonces;
    // triggerCode => 30-day bucket => count, for the PT-01 monthly cool-down.
    mapping(string => mapping(uint256 => uint256)) public triggerBucketCount;

    uint256 public constant PT01_BUCKET_CAP = 2;

    event PayoutExecuted(
        string policyId,
        string triggerCode,
        uint256 payoutAmount,
        address recipient,
        uint256 timestamp,
        bytes32 nonce,
        bytes32 payloadHash,
        address signer
    );

    constructor(address initialOwner, address jpycAddr, address signer) Ownable(initialOwner) {
        jpyc = IERC20(jpycAddr);
        pinnedSigner = signer;
    }

    function setPinnedSigner(address signer) external onlyOwner {
        pinnedSigner = signer;
    }

    function submitTrigger(
        string calldata policyId,
        string calldata triggerCode,
        uint256 payoutAmount,
        address recipient,
        uint256 timestamp,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        bytes32 payloadHash = keccak256(
            abi.encode(policyId, triggerCode, payoutAmount, recipient, timestamp, nonce)
        );
        bytes32 ethSignedHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", payloadHash)
        );
        address recovered = recoverSigner(ethSignedHash, signature);
        require(recovered == pinnedSigner, "SIGNER_MISMATCH");
        require(!usedNonces[nonce], "NONCE_ALREADY_USED");

        if (keccak256(bytes(triggerCode)) == keccak256(bytes("PT-01"))) {
            uint256 bucket = timestamp / 30 days;
            require(triggerBucketCount[triggerCode][bucket] < PT01_BUCKET_CAP, "COOLDOWN_EXCEEDED");
            triggerBucketCount[triggerCode][bucket] += 1;
        }

        usedNonces[nonce] = true;

        require(jpyc.transfer(recipient, payoutAmount), "TRANSFER_FAILED");

        emit PayoutExecuted(policyId, triggerCode, payoutAmount, recipient, timestamp, nonce, payloadHash, recovered);
    }

    function recoverSigner(bytes32 hash, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "BAD_SIG_LENGTH");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (v < 27) v += 27;
        return ecrecover(hash, v, r, s);
    }
}
