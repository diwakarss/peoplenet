// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface ICryptoPrecompiles {
    /// @notice AES-GCM encryption precompile address
    function AES_GCM_PRECOMPILE() external pure returns (address);
    
    /// @notice BN256 curve operations precompile addresses
    function BN256_ADD() external pure returns (address);
    function BN256_MUL() external pure returns (address);
    function BN256_PAIRING() external pure returns (address);
}
