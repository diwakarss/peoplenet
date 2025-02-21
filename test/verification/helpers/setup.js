const { ethers } = require("hardhat");

async function setupTest() {
    // Deploy libraries first
    const LibAESGCM = await ethers.getContractFactory("LibAESGCM");
    const libAESGCM = await LibAESGCM.deploy();
    await libAESGCM.deployed();

    const LibKeyManagement = await ethers.getContractFactory("LibKeyManagement");
    const libKeyManagement = await LibKeyManagement.deploy();
    await libKeyManagement.deployed();

    const LibThresholdEncryption = await ethers.getContractFactory("LibThresholdEncryption");
    const libThresholdEncryption = await LibThresholdEncryption.deploy();
    await libThresholdEncryption.deployed();

    // Deploy main contract with libraries
    const CryptoProperties = await ethers.getContractFactory("CryptoProperties", {
        libraries: {
            LibAESGCM: libAESGCM.address,
            LibKeyManagement: libKeyManagement.address,
            LibThresholdEncryption: libThresholdEncryption.address
        }
    });
    const cryptoProperties = await CryptoProperties.deploy();
    await cryptoProperties.deployed();

    return {
        libAESGCM,
        libKeyManagement,
        libThresholdEncryption,
        cryptoProperties
    };
}

module.exports = {
    setupTest
};
