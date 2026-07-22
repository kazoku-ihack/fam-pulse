// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
interface IERC20 { function transfer(address to, uint256 amt) external returns (bool); }

/// @notice Verifies a Protosure-rater-signed (or offline stub-signed) parametric trigger and
/// pays out DemoJPYC from its own funded pool. Replaces KazokuPayout, whose digest scheme
/// (abi.encode over policyId/triggerCode/payoutAmount/recipient/timestamp/nonce) does not match
/// what the Protosure rater actually signs.
contract MimamorParametric is Ownable {
    IERC20 public immutable jpyc;
    mapping(address => bool) public isRegisteredSigner;              // replaces single pinnedSigner
    mapping(bytes32 => bool) public usedNonce;                       // key = triggerRef = keccak(trigger_ref)
    mapping(bytes1 => uint256) public cap;                           // per coverage code, per month
    mapping(bytes1 => mapping(uint256 => uint256)) public monthSpend;

    event PayoutExecuted(bytes32 indexed triggerRef, bytes32 indexed policyId,
        bytes1 coverageCode, uint256 amountJpy, address recipient, uint256 monthKey, address signer);
    event SignerSet(address signer, bool enabled);
    event CapSet(bytes1 coverageCode, uint256 amount);

    constructor(address jpyc_) Ownable(msg.sender) { jpyc = IERC20(jpyc_); }
    function setSigner(address s, bool on) external onlyOwner { isRegisteredSigner[s] = on; emit SignerSet(s, on); }
    function setCap(bytes1 c, uint256 a) external onlyOwner { cap[c] = a; emit CapSet(c, a); }

    function computeInner(string calldata policyIdStr, string calldata triggerRefStr,
        bytes1 coverageCode, uint256 amountJpy, address recipient, uint256 monthKey)
        public view returns (bytes32 triggerRef, bytes32 inner)
    {
        triggerRef = keccak256(bytes(triggerRefStr));
        bytes32 policyId = keccak256(bytes(policyIdStr));
        // EXACT packed order/widths (201 bytes): bytes32,bytes32,bytes1,uint256,address,uint256,address,uint256
        inner = keccak256(abi.encodePacked(
            triggerRef, policyId, coverageCode, amountJpy, recipient, monthKey,
            address(this), block.chainid));
    }

    function submitTrigger(string calldata policyIdStr, string calldata triggerRefStr,
        bytes1 coverageCode, uint256 amountJpy, address recipient, uint256 monthKey,
        bytes calldata signature) external
    {
        (bytes32 triggerRef, bytes32 inner) = computeInner(
            policyIdStr, triggerRefStr, coverageCode, amountJpy, recipient, monthKey);
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(inner);  // EIP-191 prefix — required
        address rec = ECDSA.recover(digest, signature);
        require(isRegisteredSigner[rec], "SIGNER_MISMATCH");
        require(!usedNonce[triggerRef], "NONCE_ALREADY_USED");
        usedNonce[triggerRef] = true;
        require(monthSpend[coverageCode][monthKey] + amountJpy <= cap[coverageCode], "CAP_EXCEEDED");
        monthSpend[coverageCode][monthKey] += amountJpy;
        require(jpyc.transfer(recipient, amountJpy), "TRANSFER_FAILED");
        emit PayoutExecuted(triggerRef, keccak256(bytes(policyIdStr)), coverageCode,
            amountJpy, recipient, monthKey, rec);
    }
}
