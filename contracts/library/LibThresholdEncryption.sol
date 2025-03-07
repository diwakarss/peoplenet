// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./LibErrors.sol";
import "./LibKeyManagement.sol";
import "./LibAESGCM.sol";

library LibThresholdEncryption {
    struct ThresholdEncryptionParams {
        uint256 threshold;
        uint256 totalShares;
        bytes32 publicKey;
        bytes32[] commitments;
    }

    struct EncryptedShare {
        LibAESGCM.EncryptionResult encryptedData;
        LibKeyManagement.KeyShare keyShare;
    }

    function generateEncryptionParams(
        bytes memory params,
        uint256 threshold,
        uint256 totalShares
    ) 
        internal 
        pure 
        returns (ThresholdEncryptionParams memory) 
    {
        if (params.length < 64) {
            revert LibErrors.InvalidEncryptionParams();
        }

        bytes32[] memory commitments = new bytes32[](threshold);
        bytes32 publicKey = keccak256(params);

        for (uint256 i = 0; i < threshold; i++) {
            commitments[i] = keccak256(abi.encodePacked(publicKey, i));
        }

        return ThresholdEncryptionParams({
            threshold: threshold,
            totalShares: totalShares,
            publicKey: publicKey,
            commitments: commitments
        });
    }

    function encryptWithThreshold(
        bytes memory data,
        ThresholdEncryptionParams memory params
    ) 
        internal 
        view 
        returns (EncryptedShare[] memory) 
    {
        // Generate key shares
        LibKeyManagement.KeyShare[] memory keyShares = LibKeyManagement.splitKey(
            params.publicKey,
            params.threshold,
            params.totalShares
        );

        EncryptedShare[] memory encryptedShares = new EncryptedShare[](params.totalShares);

        // Generate IV (unique for each share)
        bytes memory iv = new bytes(LibAESGCM.IV_SIZE);
        
        // Encrypt data for each share
        for (uint256 i = 0; i < params.totalShares; i++) {
            // Update IV for each share
            assembly {
                mstore(add(iv, 0x20), i)
            }

            // Encrypt data using share as key
            bytes memory shareKey = abi.encodePacked(keyShares[i].share);
            LibAESGCM.EncryptionResult memory encrypted = LibAESGCM.encrypt(
                data,
                shareKey,
                iv
            );

            encryptedShares[i] = EncryptedShare({
                encryptedData: encrypted,
                keyShare: keyShares[i]
            });
        }

        return encryptedShares;
    }

    function decryptWithThreshold(
        EncryptedShare[] memory shares,
        uint256 threshold
    ) 
        internal 
        view 
        returns (bytes memory) 
    {
        if (shares.length < threshold) {
            revert LibErrors.ThresholdNotMet();
        }

        // Reconstruct the key
        LibKeyManagement.KeyShare[] memory keyShares = new LibKeyManagement.KeyShare[](threshold);
        for (uint256 i = 0; i < threshold; i++) {
            keyShares[i] = shares[i].keyShare;
        }

        bytes32 reconstructedKey = LibKeyManagement.combineShares(keyShares, threshold);

        // Convert bytes32 to bytes memory for the decrypt function
        bytes memory keyBytes = new bytes(32);
        assembly {
            mstore(add(keyBytes, 32), reconstructedKey)
        }

        // Decrypt using reconstructed key
        return LibAESGCM.decrypt(
            shares[0].encryptedData,
            keyBytes
        );
    }
}