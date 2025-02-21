// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface ICryptoPrecompiles {
    /// @notice AES-GCM encryption precompile address
    address constant AES_GCM_PRECOMPILE = address(0x9);
    
    /// @notice BN256 curve operations precompile addresses
    address constant BN256_ADD = address(0x6);
    address constant BN256_MUL = address(0x7);
    address constant BN256_PAIRING = address(0x8);
}
