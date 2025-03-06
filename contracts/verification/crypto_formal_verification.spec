// Certora specification for cryptographic operations

methods {
    // AES-GCM operations
    function verifyAESGCMRoundtrip(bytes, bytes, bytes) external returns (bool) envfree;
    
    // Key management operations
    function verifyKeyReconstruction(bytes32, uint256, uint256) external returns (bool) envfree;
    function verifyShareValidation(bytes32, uint256, uint256) external returns (bool) envfree;
    
    // Threshold encryption operations
    function verifyThresholdEncryptionSecurity(bytes, uint256, uint256) external returns (bool) envfree;
    function verifyThresholdDecryption(bytes, uint256, uint256) external returns (bool) envfree;
}

// Rule: AES-GCM encryption and decryption must be inverses of each other
rule encryptionDecryptionInverse(bytes plaintext, bytes key, bytes iv) {
    require key.length == 32; // KEY_SIZE
    require iv.length == 12;  // IV_SIZE
    require plaintext.length > 0;
    
    assert verifyAESGCMRoundtrip(plaintext, key, iv) == true;
}

// Rule: Key reconstruction must work with exactly threshold shares
rule keyReconstructionWithThreshold(bytes32 secret, uint256 threshold, uint256 totalShares) {
    require threshold >= 2;
    require threshold <= totalShares;
    require totalShares <= 10;
    require secret != 0;
    
    assert verifyKeyReconstruction(secret, threshold, totalShares) == true;
}

// Rule: Share validation must verify all shares have valid commitments
rule shareValidationCorrectness(bytes32 secret, uint256 threshold, uint256 totalShares) {
    require threshold >= 2;
    require threshold <= totalShares;
    require totalShares <= 10;
    require secret != 0;
    
    assert verifyShareValidation(secret, threshold, totalShares) == true;
}

// Rule: Threshold encryption must produce correct number of shares
rule thresholdEncryptionShareCount(bytes data, uint256 threshold, uint256 totalShares) {
    require threshold >= 2;
    require threshold <= totalShares;
    require totalShares <= 10;
    require data.length > 0;
    
    assert verifyThresholdEncryptionSecurity(data, threshold, totalShares) == true;
}

// Rule: Threshold decryption must recover original data
rule thresholdDecryptionCorrectness(bytes data, uint256 threshold, uint256 totalShares) {
    require threshold >= 2;
    require threshold <= totalShares;
    require totalShares <= 10;
    require data.length > 0;
    
    assert verifyThresholdDecryption(data, threshold, totalShares) == true;
}
