import '@nomicfoundation/hardhat-toolbox';
import 'dotenv/config';

/** @type {import('hardhat/config').HardhatUserConfig} */
export default {
  solidity: {
    version: '0.8.24',
    settings: {
      // OpenZeppelin's utils/Bytes.sol (pulled in via ECDSA/MessageHashUtils) uses MCOPY, a
      // Cancun opcode — the default (pre-Cancun) EVM target can't compile it.
      evmVersion: 'cancun',
    },
  },
  paths: {
    sources: './src/chain/contracts',
    tests: './test/chain',
  },
  networks: {
    fuji: {
      url: process.env.FUJI_RPC || 'https://api.avax-test.network/ext/bc/C/rpc',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};
