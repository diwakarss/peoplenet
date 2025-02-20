// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title ITokenFacet
 * @dev Interface for the Token management facet of the diamond
 * @custom:version 1.0.0
 */
interface ITokenFacet {
    /**
     * @dev Emitted when a new token is registered
     * @param tokenAddress The address of the registered token
     * @param name The name of the token
     * @param symbol The symbol of the token
     */
    event TokenRegistered(address indexed tokenAddress, string name, string symbol);
    
    /**
     * @dev Emitted when a token is deregistered
     * @param tokenAddress The address of the deregistered token
     */
    event TokenDeregistered(address indexed tokenAddress);

    /**
     * @dev Structure to hold token information
     * @param name The name of the token
     * @param symbol The symbol of the token
     * @param decimals The number of decimals the token uses
     * @param isActive Whether the token is currently active
     * @param registeredAt The timestamp when the token was registered
     */
    struct TokenInfo {
        string name;
        string symbol;
        uint8 decimals;
        bool isActive;
        uint256 registeredAt;
    }

    /**
     * @dev Registers a new token in the system
     */
    function registerToken(address tokenAddress, string memory name, string memory symbol) external;

    /**
     * @dev Deregisters a token from the system
     */
    function deregisterToken(address tokenAddress) external;

    /**
     * @dev Returns token information
     */
    function getTokenInfo(address tokenAddress) external view returns (TokenInfo memory);

    /**
     * @dev Returns all registered token addresses
     */
    function getRegisteredTokens() external view returns (address[] memory);

    /**
     * @dev Checks if a token is registered
     */
    function isTokenRegistered(address tokenAddress) external view returns (bool);
}
