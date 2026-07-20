import '@nomicfoundation/hardhat-toolbox';
import 'dotenv/config';

/** @type {import('hardhat/config').HardhatUserConfig} */
export default {
  solidity: '0.8.24',
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
