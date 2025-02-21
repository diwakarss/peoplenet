// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

library LibErrors {
    // Key Management Errors
    error InvalidShareConfiguration();
    error InsufficientShares();
    error InvalidInput();
    error ShareVerificationFailed();
    error ThresholdNotMet();

    // POD Errors
    error PODNotFound();
    error UnauthorizedAccess();
    error InvalidPODConfiguration();
    error DataNotFound();
    error InvalidEncryptionParams();
    error PolicyExpired();
    error InvalidPolicy();
    error ShareLimitExceeded();

    // Cryptographic Operation Errors
    error EncryptionFailed();
    error DecryptionFailed();
    error AuthenticationFailed();
    error InvalidKeySize();
    error InvalidIVSize();
    error InvalidTagSize();
}