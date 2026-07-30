// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
interface IERC20 { function transfer(address to, uint256 amt) external returns (bool); }

/// @notice Same as MimamorParametric, except the digest binds a configurable `bindAddress`
/// instead of `address(this)`. Exists specifically so this contract can be deployed at a
/// different address than whatever contract a signer's digest was actually computed against
/// (e.g. Protosure signs against PAYOUT_ADDR regardless of where this contract lives — see
/// knowledge.md's "bad attester sig" / RIDER_FALLBACK_ADDR investigation, 2026-07-30). Set
/// bindAddress to the address the signer actually signs against, not this contract's own.
contract MimamorParametricBind is Ownable {
    IERC20 public immutable jpyc;
    address public bindAddress;
    mapping(address => bool) public isRegisteredSigner;
    mapping(bytes32 => bool) public usedNonce;
    mapping(bytes1 => uint256) public cap;
    mapping(bytes1 => mapping(uint256 => uint256)) public monthSpend;

    event PayoutExecuted(bytes32 indexed triggerRef, bytes32 indexed policyId,
        bytes1 coverageCode, uint256 amountJpy, address recipient, uint256 monthKey, address signer);
    event SignerSet(address signer, bool enabled);
    event CapSet(bytes1 coverageCode, uint256 amount);
    event BindAddressSet(address bindAddress);

    constructor(address jpyc_, address bindAddress_) Ownable(msg.sender) {
        jpyc = IERC20(jpyc_);
        bindAddress = bindAddress_;
    }
    function setSigner(address s, bool on) external onlyOwner { isRegisteredSigner[s] = on; emit SignerSet(s, on); }
    function setCap(bytes1 c, uint256 a) external onlyOwner { cap[c] = a; emit CapSet(c, a); }
    function setBindAddress(address a) external onlyOwner { bindAddress = a; emit BindAddressSet(a); }

    function computeInner(string calldata policyIdStr, string calldata triggerRefStr,
        bytes1 coverageCode, uint256 amountJpy, address recipient, uint256 monthKey)
        public view returns (bytes32 triggerRef, bytes32 inner)
    {
        triggerRef = keccak256(bytes(triggerRefStr));
        bytes32 policyId = keccak256(bytes(policyIdStr));
        // Same packed order/widths as MimamorParametric.sol, except bindAddress replaces
        // address(this) as the 7th field.
        inner = keccak256(abi.encodePacked(
            triggerRef, policyId, coverageCode, amountJpy, recipient, monthKey,
            bindAddress, block.chainid));
    }

    function submitTrigger(string calldata policyIdStr, string calldata triggerRefStr,
        bytes1 coverageCode, uint256 amountJpy, address recipient, uint256 monthKey,
        bytes calldata signature) external
    {
        (bytes32 triggerRef, bytes32 inner) = computeInner(
            policyIdStr, triggerRefStr, coverageCode, amountJpy, recipient, monthKey);
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(inner);
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
