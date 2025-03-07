const { ethers } = require("hardhat");

// Helper functions for token tests
const TokenHelper = {
    // Deploy a mock ERC20 token for testing
    async deployMockToken(name = "Mock Token", symbol = "MOCK", decimals = 18) {
        const MockToken = await ethers.getContractFactory("MockToken");
        const token = await MockToken.deploy(name, symbol, decimals);
        return token;
    },

    // Get token facet interface with proper address
    async getTokenFacet(diamondAddress) {
        return await ethers.getContractAt("TokenFacet", diamondAddress);
    },

    // Create token registration data
    createTokenData(name, symbol) {
        return { name, symbol };
    }
};

module.exports = TokenHelper;
