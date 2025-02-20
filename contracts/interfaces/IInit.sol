// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IInit {
    /// @notice Called once after the diamond is deployed and all initial facets are added
    /// @param _initializationData Arbitrary initialization data
    function init(bytes memory _initializationData) external;
}
