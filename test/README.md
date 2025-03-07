# PeopleNet Test Suite

This directory contains the test suite for the PeopleNet project. The tests are organized into the following directories:

## Directory Structure

- `facets/`: Tests for individual facets of the Diamond contract
  - `AAOFacet.test.js`: Tests for the AAO (Arbitrary Action Object) facet
  - `AAOFactory.test.js`: Tests for the AAO factory functionality
  - `AAOAdvanced.test.js`: Tests for advanced AAO functionality (proposals, voting, admin roles, micro AAOs, token integration)
  - `DiamondController.test.js`: Tests for the Diamond controller and basic AAO functionality
  - `TokenFacet.test.js`: Tests for the token facet

- `verification/`: Tests for cryptographic verification
  - `CryptoFormalVerification.test.js`: Tests for formal verification of cryptographic operations
  - `CryptoLibraries.test.js`: Tests for the deployment of cryptographic libraries
  - `CryptoProperties.test.js`: Tests for cryptographic properties

- `integration/`: Integration tests that test multiple components together
  - `TokenFacet.Integration.test.js`: Integration tests for the token facet

- `helpers/`: Helper functions and utilities for tests
  - `aao.js`: Helper functions for AAO-related tests
  - `diamond.js`: Helper functions for Diamond-related tests
  - `token.js`: Helper functions for token-related tests

## Advanced AAO Functionality

The `AAOAdvanced.test.js` file tests the following advanced AAO features:

1. **Proposal Creation and Voting**:
   - Creating proposals within an AAO
   - Voting on proposals (for/against)
   - Executing proposals after voting

2. **Admin Role Management**:
   - Assigning admin roles to AAO members
   - Admin permissions and actions
   - Revoking admin roles

3. **Micro AAO Management**:
   - Creating micro AAOs within a macro AAO
   - Managing membership in micro AAOs
   - Creating proposals in micro AAOs

4. **Token Integration**:
   - Registering tokens for use with AAOs
   - Using tokens in AAO operations through proposals

## Running Tests

To run all tests:

```bash
npx hardhat test
```

To run a specific test file:

```bash
npx hardhat test test/facets/DiamondController.test.js
```

To run tests in a specific directory:

```bash
npx hardhat test test/facets/*.js
```

## Test Coverage

To generate a test coverage report:

```bash
npx hardhat coverage
```

## Notes

- Some tests for cryptographic operations require precompiles that are not available in the Hardhat test environment. These tests are commented out in the `CryptoLibraries.test.js` file.
- The Diamond pattern is used extensively in this project. For more information on the Diamond pattern, see [EIP-2535](https://eips.ethereum.org/EIPS/eip-2535). 