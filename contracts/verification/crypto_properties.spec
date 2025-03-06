// Certora specification for CryptoProperties

methods {
    // Threshold reconstruction verification
    function verifyThresholdReconstruction(bytes32, uint256, uint256) external returns (bool) envfree;
    
    // Share validation verification
    function verifyShareValidation(bytes32, uint256, uint256) external returns (bool) envfree;
    
    // Encryption roundtrip verification (assuming this exists in the contract)
    function verifyEncryptionRoundtrip(bytes, bytes, bytes) external returns (bool) envfree;
    
    // Threshold encryption verification (assuming this exists in the contract)
    function encryptWithThreshold(bytes, struct LibThresholdEncryption.ThresholdEncryptionParams) external returns (struct LibThresholdEncryption.EncryptedShare[]) envfree;
    function decryptWithThreshold(struct LibThresholdEncryption.EncryptedShare[], uint256) external returns (bytes) envfree;
    function generateEncryptionParams(bytes, uint256, uint256) external returns (struct LibThresholdEncryption.ThresholdEncryptionParams) envfree;
}

// Rule: Threshold reconstruction must work correctly
rule thresholdReconstructionCorrectness(bytes32 secret, uint256 threshold, uint256 totalShares) {
    require threshold > 1;
    require threshold <= 10; // MAX_SHARES
    require totalShares >= threshold;
    
    assert verifyThresholdReconstruction(secret, threshold, totalShares) == true;
}

// Rule: Share validation must work correctly
rule shareValidationCorrectness(bytes32 secret, uint256 threshold, uint256 totalShares) {
    require threshold > 1;
    require threshold <= 10; // MAX_SHARES
    require totalShares >= threshold;
    
    assert verifyShareValidation(secret, threshold, totalShares) == true;
}

// Rule: Encryption and decryption must be inverses
rule encryptionDecryptionInverse(bytes data, uint256 threshold, uint256 totalShares) {
    require threshold > 1;
    require threshold <= 10; // MAX_SHARES
    require totalShares >= threshold;
    require data.length > 0;
    
    // Generate parameters
    bytes params = constant_bytes64();
    LibThresholdEncryption.ThresholdEncryptionParams encParams = generateEncryptionParams(params, threshold, totalShares);
    
    // Encrypt
    LibThresholdEncryption.EncryptedShare[] shares = encryptWithThreshold(data, encParams);
    
    // Take threshold shares and decrypt
    LibThresholdEncryption.EncryptedShare[] thresholdShares;
    for (uint i = 0; i < threshold; i++) {
        thresholdShares[i] = shares[i];
    }
    
    bytes decrypted = decryptWithThreshold(thresholdShares, threshold);
    
    // Verify roundtrip
    assert data == decrypted;
}

// Rule: Threshold must be respected
rule thresholdRespected(bytes data, uint256 threshold, uint256 totalShares) {
    require threshold > 1;
    require threshold <= 10; // MAX_SHARES
    require totalShares >= threshold;
    require data.length > 0;
    
    // Generate parameters
    bytes params = constant_bytes64();
    LibThresholdEncryption.ThresholdEncryptionParams encParams = generateEncryptionParams(params, threshold, totalShares);
    
    // Encrypt
    LibThresholdEncryption.EncryptedShare[] shares = encryptWithThreshold(data, encParams);
    
    // Take fewer than threshold shares
    LibThresholdEncryption.EncryptedShare[] insufficientShares;
    for (uint i = 0; i < threshold - 1; i++) {
        insufficientShares[i] = shares[i];
    }
    
    // This should revert
    bytes decrypted = decryptWithThreshold@withrevert(insufficientShares, threshold);
    
    assert lastReverted;
}

// Helper function to generate constant bytes
function constant_bytes64() returns bytes {
    bytes result;
    for (uint i = 0; i < 64; i++) {
        result[i] = 0x01;
    }
    return result;
}
