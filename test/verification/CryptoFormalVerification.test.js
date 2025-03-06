const { expect } = require("chai");
const { ethers } = require("hardhat");
const { setupTest } = require("./helpers/setup");

describe("CryptoFormalVerification", function () {
    let cryptoFormalVerification;
    let libAESGCM;
    let libKeyManagement;
    let libThresholdEncryption;

    before(async function () {
        // Deploy libraries and contracts
        const LibAESGCM = await ethers.getContractFactory("LibAESGCM");
        libAESGCM = await LibAESGCM.deploy();
        await libAESGCM.deployed();

        const LibKeyManagement = await ethers.getContractFactory("LibKeyManagement");
        libKeyManagement = await LibKeyManagement.deploy();
        await libKeyManagement.deployed();

        const LibThresholdEncryption = await ethers.getContractFactory("LibThresholdEncryption");
        libThresholdEncryption = await LibThresholdEncryption.deploy();
        await libThresholdEncryption.deployed();

        // Deploy main contract with libraries
        const CryptoFormalVerification = await ethers.getContractFactory("CryptoFormalVerification", {
            libraries: {
                LibAESGCM: libAESGCM.address,
                LibKeyManagement: libKeyManagement.address,
                LibThresholdEncryption: libThresholdEncryption.address
            }
        });
        cryptoFormalVerification = await CryptoFormalVerification.deploy();
        await cryptoFormalVerification.deployed();
    });

    describe("AES-GCM Verification", function () {
        it("Should verify encryption and decryption roundtrip", async function () {
            const plaintext = ethers.utils.toUtf8Bytes("test data for encryption");
            const key = ethers.utils.randomBytes(32); // 256-bit key
            const iv = ethers.utils.randomBytes(12);  // 96-bit IV

            const result = await cryptoFormalVerification.verifyAESGCMRoundtrip(
                plaintext,
                key,
                iv
            );

            expect(result).to.equal(true);
        });
    });

    describe("Key Management Verification", function () {
        it("Should verify key reconstruction with different thresholds", async function () {
            const secret = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("test secret"));
            const threshold = 3;
            const totalShares = 5;

            const result = await cryptoFormalVerification.verifyKeyReconstruction(
                secret,
                threshold,
                totalShares
            );

            expect(result).to.equal(true);
        });

        it("Should verify share validation", async function () {
            const secret = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("test secret"));
            const threshold = 3;
            const totalShares = 5;

            const result = await cryptoFormalVerification.verifyShareValidation(
                secret,
                threshold,
                totalShares
            );

            expect(result).to.equal(true);
        });
    });

    describe("Threshold Encryption Verification", function () {
        it("Should verify threshold encryption security properties", async function () {
            const data = ethers.utils.toUtf8Bytes("test data for threshold encryption");
            const threshold = 3;
            const totalShares = 5;

            const result = await cryptoFormalVerification.verifyThresholdEncryptionSecurity(
                data,
                threshold,
                totalShares
            );

            expect(result).to.equal(true);
        });

        it("Should verify threshold decryption with different share combinations", async function () {
            const data = ethers.utils.toUtf8Bytes("test data for threshold decryption");
            const threshold = 3;
            const totalShares = 5;

            const result = await cryptoFormalVerification.verifyThresholdDecryption(
                data,
                threshold,
                totalShares
            );

            expect(result).to.equal(true);
        });
    });
});
