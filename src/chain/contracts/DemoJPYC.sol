// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Plain mintable ERC20 standing in for JPYC on Fuji testnet — demo funds only.
contract DemoJPYC is ERC20, Ownable {
    constructor(address initialOwner) ERC20("Demo JPYC", "tJPYC") Ownable(initialOwner) {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
