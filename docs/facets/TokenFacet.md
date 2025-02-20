# TokenFacet Documentation

## Overview
The TokenFacet manages ERC20 token registration and tracking within the diamond contract.

## Functions

### registerToken
Registers a new ERC20 token in the system.
solidity
function registerToken(address tokenAddress, string memory name, string memory symbol) external
### deregisterToken
Removes a token from the active registry.
solidity
function deregisterToken(address tokenAddress) external

[... continue with other functions ...]

## Events
- TokenRegistered(address indexed tokenAddress, string name, string symbol)
- TokenDeregistered(address indexed tokenAddress)

## Storage Layout
Located at `keccak256("diamond.standard.token.storage")`

## Security Considerations
- Only contract owner can register/deregister tokens
- Validates ERC20 compliance
- Prevents duplicate registrations