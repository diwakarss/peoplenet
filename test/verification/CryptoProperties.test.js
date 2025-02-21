const { expect } = require("chai");
const { ethers } = require("hardhat");
const { solidity } = require("ethereum-waffle");
const { smtcheck } = require("@ethereum-waffle/compiler");
const { setupTest } = require("./helpers/setup");

describe("CryptoProperties Formal Verification", function () {
    let cryptoProperties, libAESGCM, libKeyManagement, libThresholdEncryption;

    before(async function () {
        ({ cryptoProperties, libAESGCM, libKeyManagement, libThresholdEncryption } = await setupTest());
    });

    // ... [Previous test implementations remain the same]

    describe("Threshold Encryption", function () {
        it("Should encrypt and decrypt with threshold shares", async function () {
            const testData = ethers.utils.toUtf8Bytes("test data");
            const threshold = 3;
            const totalShares = 5;

            // Generate encryption parameters
            const params = ethers.utils.randomBytes(64);
            const encryptionParams = await cryptoProperties.generateEncryptionParams(
                params,
                threshold,
                totalShares
            );

            // Encrypt with threshold
            const encryptedShares = await cryptoProperties.encryptWithThreshold(
                testData,
                encryptionParams
            );

            // Take threshold number of shares and decrypt
            const decrypted = await cryptoProperties.decryptWithThreshold(
                encryptedShares.slice(0, threshold),
                threshold
            );

            expect(ethers.utils.toUtf8String(decrypted)).to.equal("test data");
        });
    });
});
