// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import { LibDiamond } from "./LibDiamond.sol";
import { IInit } from "../interfaces/IInit.sol";
import { IERC165 } from "@openzeppelin/contracts/interfaces/IERC165.sol";
import { IDiamondCut } from "../interfaces/IDiamondCut.sol";
import { IDiamondLoupe } from "../interfaces/IDiamondLoupe.sol";
import { IERC173 } from "../interfaces/IERC173.sol";
import { ITokenFacet } from "../interfaces/ITokenFacet.sol";

contract DiamondInit is IInit {
    /// @notice Initialize the diamond with default settings
    /// @param _initializationData Initialization parameters (if any)
    function init(bytes memory _initializationData) external override {
        // Get diamond storage
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();

        // Add default supported interfaces
        ds.supportedInterfaces[type(IERC165).interfaceId] = true;
        ds.supportedInterfaces[type(IDiamondCut).interfaceId] = true;
        ds.supportedInterfaces[type(IDiamondLoupe).interfaceId] = true;
        ds.supportedInterfaces[type(IERC173).interfaceId] = true;
        ds.supportedInterfaces[type(ITokenFacet).interfaceId] = true;

        // Initialize any additional state based on _initializationData
        if (_initializationData.length > 0) {
            // Custom initialization logic here
            // Example: decode and use initialization data
            // (address newOwner) = abi.decode(_initializationData, (address));
            // LibDiamond.setContractOwner(newOwner);
        }
    }
}
