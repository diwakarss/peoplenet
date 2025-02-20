// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import { LibDiamond } from "../diamond/LibDiamond.sol";
import { LibToken } from "../libraries/LibToken.sol";
import { ITokenFacet } from "../interfaces/ITokenFacet.sol";
import { IERC165 } from "@openzeppelin/contracts/interfaces/IERC165.sol";

contract TokenFacet is ITokenFacet, IERC165 {
    event TokenAdded(address indexed tokenAddress, string symbol);
    event TokenRemoved(address indexed tokenAddress);

    struct TokenInfo {
        bool isSupported;
        string symbol;
    }

    bytes32 constant STORAGE_POSITION = keccak256("peoplenet.token.storage");

    struct TokenStorage {
        mapping(address => TokenInfo) supportedTokens;
        address[] tokenList;
    }

    function tokenStorage() internal pure returns (TokenStorage storage ts) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            ts.slot := position
        }
    }

    function addSupportedToken(address _tokenAddress, string memory _symbol) external {
        LibDiamond.enforceIsContractOwner();
        TokenStorage storage ts = tokenStorage();
        require(!ts.supportedTokens[_tokenAddress].isSupported, "Token already supported");
        
        ts.supportedTokens[_tokenAddress] = TokenInfo({
            isSupported: true,
            symbol: _symbol
        });
        ts.tokenList.push(_tokenAddress);
        
        emit TokenAdded(_tokenAddress, _symbol);
    }

    /**
     * @dev Registers a new token in the system
     * @param tokenAddress The address of the token to register
     * @param name The name of the token
     * @param symbol The symbol of the token
     */
    function registerToken(
        address tokenAddress,
        string memory name,
        string memory symbol
    ) external override {
        LibDiamond.enforceIsContractOwner();
        LibToken.registerToken(tokenAddress, name, symbol);
    }

    /**
     * @dev Deregisters a token from the system
     * @param tokenAddress The address of the token to deregister
     */
    function deregisterToken(address tokenAddress) external override {
        LibDiamond.enforceIsContractOwner();
        LibToken.deregisterToken(tokenAddress);
    }

    /**
     * @dev Returns token information
     * @param tokenAddress The address of the token to query
     */
    function getTokenInfo(address tokenAddress) 
        external 
        view 
        override 
        returns (TokenInfo memory) 
    {
        return LibToken.getTokenInfo(tokenAddress);
    }

    /**
     * @dev Returns all registered token addresses
     */
    function getRegisteredTokens() 
        external 
        view 
        override 
        returns (address[] memory) 
    {
        return LibToken.getRegisteredTokens();
    }

    /**
     * @dev Checks if a token is registered
     * @param tokenAddress The address of the token to check
     */
    function isTokenRegistered(address tokenAddress) 
        external 
        view 
        override 
        returns (bool) 
    {
        return LibToken.tokenStorage().isRegistered[tokenAddress];
    }

    /**
     * @dev Returns true if the contract implements the interface defined by interfaceId
     * @param interfaceId The interface identifier
     */
    function supportsInterface(bytes4 interfaceId) 
        external 
        pure 
        override 
        returns (bool) 
    {
        return interfaceId == type(ITokenFacet).interfaceId || 
               interfaceId == type(IERC165).interfaceId;
    }

    /**
     * @dev Returns the count of registered tokens
     */
    function getRegisteredTokenCount() external view returns (uint256) {
        return LibToken.tokenStorage().registeredTokens.length;
    }

    /**
     * @dev Returns token information for multiple tokens
     * @param tokenAddresses Array of token addresses to query
     */
    function getMultipleTokenInfo(address[] calldata tokenAddresses) 
        external 
        view 
        returns (TokenInfo[] memory tokenInfos) 
    {
        tokenInfos = new TokenInfo[](tokenAddresses.length);
        for (uint256 i = 0; i < tokenAddresses.length; i++) {
            tokenInfos[i] = LibToken.getTokenInfo(tokenAddresses[i]);
        }
        return tokenInfos;
    }

    constructor() {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        ds.supportedInterfaces[type(ITokenFacet).interfaceId] = true;
    }
}
