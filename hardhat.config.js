require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-ethers");
// Temporarily comment out OpenZeppelin upgrades plugin that requires ethers v5
// require("@openzeppelin/hardhat-upgrades");
require("hardhat-deploy");
require("hardhat-gas-reporter");
require("solidity-coverage");
// Comment out nomiclabs etherscan plugin as it conflicts with nomicfoundation verify
// require("@nomiclabs/hardhat-etherscan");
require("hardhat-contract-sizer");
// Temporarily comment out zkSync plugins
// require("@matterlabs/hardhat-zksync-solc");
// require("@matterlabs/hardhat-zksync-deploy");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.19",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true
    },
    localhost: {
      url: "http://127.0.0.1:8545/",
      chainId: 31337
    },
    polygon_mumbai: {
      url: process.env.POLYGON_MUMBAI_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
    }
    // Temporarily comment out zkSync network
    // zkSync_testnet: {
    //   url: process.env.ZKSYNC_TESTNET_URL || "",
    //   ethNetwork: "goerli",
    //   zksync: true,
    // }
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  }
  // Temporarily comment out zksolc config
  // zksolc: {
  //   version: "1.3.13",
  //   compilerSource: "binary",
  //   settings: {
  //     optimizer: {
  //       enabled: true,
  //     }
  //   }
  // }
};
