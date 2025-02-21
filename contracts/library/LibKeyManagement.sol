// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./LibErrors.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

library LibKeyManagement {
    using ECDSA for bytes32;

    struct KeyShare {
        bytes32 share;
        uint256 index;
        bytes32 commitment;
        bool isValid;
    }

    uint256 private constant PRIME_MOD = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 private constant MAX_SHARES = 10;

    function splitKey(
        bytes32 secret,
        uint256 threshold,
        uint256 totalShares
    ) 
        internal 
        pure 
        returns (KeyShare[] memory shares) 
    {
        if (threshold < 2 || threshold > MAX_SHARES || threshold > totalShares) {
            revert LibErrors.InvalidShareConfiguration();
        }

        shares = new KeyShare[](totalShares);
        uint256[] memory coefficients = new uint256[](threshold - 1);

        // Generate random coefficients for polynomial
        for (uint256 i = 0; i < threshold - 1; i++) {
            coefficients[i] = uint256(keccak256(abi.encodePacked(secret, i))) % PRIME_MOD;
        }

        // Generate shares using polynomial evaluation
        for (uint256 x = 0; x < totalShares; x++) {
            uint256 y = uint256(secret);
            uint256 xPow = 1;

            for (uint256 i = 0; i < threshold - 1; i++) {
                xPow = mulmod(xPow, x + 1, PRIME_MOD);
                y = addmod(y, mulmod(coefficients[i], xPow, PRIME_MOD), PRIME_MOD);
            }

            shares[x] = KeyShare({
                share: bytes32(y),
                index: x + 1,
                commitment: keccak256(abi.encodePacked(y, x + 1)),
                isValid: true
            });
        }
    }

    function verifyShare(
        KeyShare memory share,
        bytes32 commitment
    ) 
        internal 
        pure 
        returns (bool) 
    {
        return share.commitment == commitment &&
               share.isValid &&
               share.index > 0 &&
               uint256(share.share) < PRIME_MOD;
    }

       // ... [Continued from previous part]

    function combineShares(
        KeyShare[] memory shares,
        uint256 threshold
    ) 
        internal 
        pure 
        returns (bytes32) 
    {
        if (shares.length < threshold) {
            revert LibErrors.InsufficientShares();
        }

        uint256 secret = 0;
        
        // Lagrange interpolation
        for (uint256 i = 0; i < threshold; i++) {
            if (!shares[i].isValid) {
                revert LibErrors.ShareVerificationFailed();
            }

            uint256 numerator = 1;
            uint256 denominator = 1;
            
            for (uint256 j = 0; j < threshold; j++) {
                if (i != j) {
                    numerator = mulmod(
                        numerator,
                        shares[j].index,
                        PRIME_MOD
                    );
                    denominator = mulmod(
                        denominator,
                        addmod(
                            shares[j].index,
                            PRIME_MOD - shares[i].index,
                            PRIME_MOD
                        ),
                        PRIME_MOD
                    );
                }
            }

            uint256 lagrange = mulmod(
                numerator,
                multiplicativeInverse(denominator, PRIME_MOD),
                PRIME_MOD
            );
            
            secret = addmod(
                secret,
                mulmod(
                    uint256(shares[i].share),
                    lagrange,
                    PRIME_MOD
                ),
                PRIME_MOD
            );
        }

        return bytes32(secret);
    }

    function multiplicativeInverse(
        uint256 a,
        uint256 m
    ) 
        private 
        pure 
        returns (uint256) 
    {
        if (a == 0) {
            revert LibErrors.InvalidInput();
        }

        if (a == 1) {
            return 1;
        }

        uint256 m0 = m;
        uint256 y = 0;
        uint256 x = 1;

        while (a > 1) {
            uint256 q = a / m;
            uint256 t = m;

            m = a % m;
            a = t;
            t = y;

            y = x - q * y;
            x = t;
        }

        return x < 0 ? x + m0 : x;
    }
}