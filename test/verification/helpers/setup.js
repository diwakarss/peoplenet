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

    // Deploy CryptoProperties with libraries
    const CryptoProperties = await ethers.getContractFactory("CryptoProperties", {
        libraries: {
            LibAESGCM: libAESGCM.address,
            LibKeyManagement: libKeyManagement.address,
            LibThresholdEncryption: libThresholdEncryption.address
        }
    });
    const cryptoProperties = await CryptoProperties.deploy();
    await cryptoProperties.deployed();

    // Deploy CryptoFormalVerification with libraries
    const CryptoFormalVerification = await ethers.getContractFactory("CryptoFormalVerification", {
        libraries: {
            LibAESGCM: libAESGCM.address,
            LibKeyManagement: libKeyManagement.address,
            LibThresholdEncryption: libThresholdEncryption.address
        }
    });
    const cryptoFormalVerification = await CryptoFormalVerification.deploy();
    await cryptoFormalVerification.deployed();

    return {
        libAESGCM,
        libKeyManagement,
        libThresholdEncryption,
        cryptoProperties,
        cryptoFormalVerification
    };
}

module.exports = {
    setupTest
};
