// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ITokenFacet } from "../interfaces/ITokenFacet.sol";

library LibToken {
    bytes32 constant STORAGE_POSITION = keccak256("diamond.standard.token.storage");

    struct TokenStorage {
        // Mapping from token address to token info
        mapping(address => ITokenFacet.TokenInfo) tokenInfo;
        // Array to keep track of all registered tokens
        address[] registeredTokens;
        // Mapping to track token index in registeredTokens array
        mapping(address => uint256) tokenIndex;
        // Mapping to track if a token is in the registeredTokens array
        mapping(address => bool) isRegistered;
    }

    event TokenRegistered(address indexed tokenAddress, string name, string symbol);
    event TokenDeregistered(address indexed tokenAddress);

    /**
     * @dev Emitted when token validation fails
     */
    error InvalidToken(address tokenAddress, string reason);

    /**
     * @dev Emitted when token is already registered
     */
    error TokenAlreadyRegistered(address tokenAddress);

    /**
     * @dev Emitted when token is not registered
     */
    error TokenNotRegistered(address tokenAddress);

    /**
     * @dev Returns the TokenStorage struct from a specific position in contract storage
     */
    function tokenStorage() internal pure returns (TokenStorage storage ts) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            ts.slot := position
        }
    }

    /**
     * @dev Validates a token contract
     * @param tokenAddress The address of the token to validate
     */
    function validateToken(address tokenAddress) internal view {
        if (tokenAddress == address(0)) {
            revert InvalidToken(tokenAddress, "Zero address");
        }

        // Check if address is a contract
        uint256 size;
        assembly {
            size := extcodesize(tokenAddress)
        }
        if (size == 0) {
            revert InvalidToken(tokenAddress, "Not a contract");
        }

        // Try to get token decimals to verify it's an ERC20
        try IERC20(tokenAddress).decimals() returns (uint8) {
            // Success - it's a valid ERC20 token
        } catch {
            revert InvalidToken(tokenAddress, "Not an ERC20 token");
        }
    }

    /**
     * @dev Registers a new token
     * @param tokenAddress The address of the token to register
     * @param name The name of the token
     * @param symbol The symbol of the token
     */
    function registerToken(
        address tokenAddress, 
        string memory name, 
        string memory symbol
    ) internal {
        TokenStorage storage ts = tokenStorage();

        if (ts.isRegistered[tokenAddress]) {
            revert TokenAlreadyRegistered(tokenAddress);
        }

        validateToken(tokenAddress);

        uint8 decimals = IERC20(tokenAddress).decimals();

        ts.tokenInfo[tokenAddress] = ITokenFacet.TokenInfo({
            name: name,
            symbol: symbol,
            decimals: decimals,
            isActive: true,
            registeredAt: block.timestamp
        });

        ts.registeredTokens.push(tokenAddress);
        ts.tokenIndex[tokenAddress] = ts.registeredTokens.length - 1;
        ts.isRegistered[tokenAddress] = true;

        emit TokenRegistered(tokenAddress, name, symbol);
    }

    /**
     * @dev Deregisters a token
     * @param tokenAddress The address of the token to deregister
     */
    function deregisterToken(address tokenAddress) internal {
        TokenStorage storage ts = tokenStorage();

        if (!ts.isRegistered[tokenAddress]) {
            revert TokenNotRegistered(tokenAddress);
        }

        uint256 index = ts.tokenIndex[tokenAddress];
        uint256 lastIndex = ts.registeredTokens.length - 1;
        address lastToken = ts.registeredTokens[lastIndex];

        if (tokenAddress != lastToken) {
            ts.registeredTokens[index] = lastToken;
            ts.tokenIndex[lastToken] = index;
        }

        ts.registeredTokens.pop();
        delete ts.tokenIndex[tokenAddress];
        delete ts.isRegistered[tokenAddress];
        
        ts.tokenInfo[tokenAddress].isActive = false;

        emit TokenDeregistered(tokenAddress);
    }

    /**
     * @dev Returns token information
     * @param tokenAddress The address of the token
     */
    function getTokenInfo(address tokenAddress) internal view returns (ITokenFacet.TokenInfo memory) {
        TokenStorage storage ts = tokenStorage();
        if (!ts.isRegistered[tokenAddress]) {
            revert TokenNotRegistered(tokenAddress);
        }
        return ts.tokenInfo[tokenAddress];
    }

    /**
     * @dev Returns all registered token addresses
     */
    function getRegisteredTokens() internal view returns (address[] memory) {
        return tokenStorage().registeredTokens;
    }
}
