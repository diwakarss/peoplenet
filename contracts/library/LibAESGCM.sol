// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import { LibErrors } from "./LibErrors.sol";

/// @title LibAESGCM
/// @notice Formal verification properties:
/// @custom:security-contact security@peoplenet.com
/// @custom:verify-invariant forall bytes key, data, iv: decrypt(encrypt(data, key, iv), key, iv) == data
library LibAESGCM {
    /// @dev Size constants for AES-GCM
    uint256 constant KEY_SIZE = 32;    // 256 bits
    uint256 constant IV_SIZE = 12;     // 96 bits
    uint256 constant TAG_SIZE = 16;    // 128 bits

    /// @notice Encryption result structure
    /// @custom:verify-invariant ciphertext.length >= TAG_SIZE
    struct EncryptionResult {
        bytes ciphertext;      // Encrypted data
        bytes authTag;         // Authentication tag
        bytes iv;             // Initialization vector
    }

    address constant AES_GCM_PRECOMPILE = address(0x9);

/// @notice Encrypts data using AES-GCM through precompile
    /// @param plaintext Data to encrypt
    /// @param key Encryption key
    /// @param iv Initialization vector
    /// @return EncryptionResult containing ciphertext and authentication data
    /// @custom:verify precondition key.length == KEY_SIZE
    /// @custom:verify precondition iv.length == IV_SIZE
    function encrypt(
        bytes memory plaintext,
        bytes memory key,
        bytes memory iv
    )
        internal
        view
        returns (EncryptionResult memory)
    {
        if (key.length != KEY_SIZE) {
            revert LibErrors.InvalidKeySize();
        }
        if (iv.length != IV_SIZE) {
            revert LibErrors.InvalidIVSize();
        }

        // Prepare input for precompile
        bytes memory input = abi.encodePacked(
            plaintext,                // data to encrypt
            bytes32(0),              // AAD (empty)
            key,                     // key
            iv                       // IV
        );

        // Call precompile
        (bool success, bytes memory result) = AES_GCM_PRECOMPILE.staticcall(input);
        if (!success) {
            revert LibErrors.EncryptionFailed();
        }

        // Extract ciphertext and auth tag
        bytes memory ciphertext = new bytes(plaintext.length);
        bytes memory authTag = new bytes(TAG_SIZE);

        assembly {
            // Skip first 32 bytes (length) and copy ciphertext
            let resultPtr := add(result, 0x20)
            let ciphertextPtr := add(ciphertext, 0x20)
            let length := mload(plaintext)
            for { let i := 0 } lt(i, length) { i := add(i, 0x20) } {
                mstore(add(ciphertextPtr, i), mload(add(resultPtr, i)))
            }

            // Copy auth tag
            let authTagPtr := add(authTag, 0x20)
            let tagSrc := add(resultPtr, length)
            mstore(authTagPtr, mload(tagSrc))
        }

        return EncryptionResult({
            ciphertext: ciphertext,
            authTag: authTag,
            iv: iv
        });
    }

    /**
     * @dev Decrypts data using AES-GCM
     * @param encryptedData The encrypted data
     * @param key The encryption key
     * @return The decrypted plaintext
     */
    function decrypt(
        EncryptionResult memory encryptedData,
        bytes memory key
    ) internal view returns (bytes memory) {
        if (key.length != KEY_SIZE) {
            revert LibErrors.InvalidKeySize();
        }
        
        // Prepare input for precompile
        bytes memory input = abi.encodePacked(
            uint8(2),                  // decrypt mode
            encryptedData.ciphertext,  // ciphertext
            encryptedData.authTag,     // auth tag
            bytes32(0),                // AAD (empty)
            key,                       // key
            encryptedData.iv           // IV
        );

        // Call precompile
        (bool success, bytes memory result) = AES_GCM_PRECOMPILE.staticcall(input);
        if (!success) {
            revert LibErrors.DecryptionFailed();
        }

        // Extract plaintext
        bytes memory plaintext = new bytes(encryptedData.ciphertext.length);
        assembly {
            let resultPtr := add(result, 0x20)
            let plaintextPtr := add(plaintext, 0x20)
            let ciphertext := mload(add(encryptedData, 0x20))  // Get ciphertext pointer
            let length := mload(ciphertext)  // Get ciphertext length
            for { let i := 0 } lt(i, length) { i := add(i, 0x20) } {
                mstore(add(plaintextPtr, i), mload(add(resultPtr, i)))
            }
        }

        return plaintext;
    }
}