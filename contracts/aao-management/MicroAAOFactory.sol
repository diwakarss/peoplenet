// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../interfaces/IAAOFacet.sol";
import "../library/LibAAO.sol";
import "../diamond/LibDiamond.sol";
import "./MacroAAOFactory.sol";

/**
 * @title MicroAAOFactory
 * @dev Factory contract for creating and managing Micro AAOs
 * @custom:version 1.0.0
 */
contract MicroAAOFactory {
    // Diamond address where the AAOFacet is deployed
    address public immutable diamondAddress;
    
    // MacroAAOFactory reference
    MacroAAOFactory public immutable macroFactory;
    
    // Mapping to track micro AAOs created by this factory
    mapping(uint256 => bool) public isMicroAAO;
    
    // Mapping to track which macro AAO a micro AAO belongs to
    mapping(uint256 => uint256) public microToMacroAAO;
    
    // Mapping to track micro AAOs for each macro AAO
    mapping(uint256 => uint256[]) public macroToMicroAAOs;
    
    // Events
    event MicroAAOCreated(uint256 indexed microAaoId, uint256 indexed macroAaoId, string topic, address indexed owner);
    
    /**
     * @dev Constructor
     * @param _diamondAddress Address of the diamond contract
     * @param _macroFactoryAddress Address of the MacroAAOFactory contract
     */
    constructor(address _diamondAddress, address _macroFactoryAddress) {
        require(_diamondAddress != address(0), "MicroAAOFactory: Invalid diamond address");
        require(_macroFactoryAddress != address(0), "MicroAAOFactory: Invalid macro factory address");
        diamondAddress = _diamondAddress;
        macroFactory = MacroAAOFactory(_macroFactoryAddress);
    }
    
    /**
     * @dev Creates a new Micro AAO associated with a Macro AAO
     * @param macroAaoId The ID of the parent Macro AAO
     * @param topic The topic or purpose of the AAO
     * @param duration The duration of the AAO in seconds (0 for permanent)
     * @return microAaoId The ID of the newly created Micro AAO
     */
    function createMicroAAO(
        uint256 macroAaoId,
        string calldata topic,
        uint256 duration
    ) external returns (uint256) {
        // Verify that the macro AAO exists
        require(macroFactory.isMacroAAO(macroAaoId), "MicroAAOFactory: Invalid macro AAO ID");
        
        // Call the AAOFacet through the diamond to create the AAO
        (bool success, bytes memory result) = diamondAddress.call(
            abi.encodeWithSignature("createAAO(string,uint256)", topic, duration)
        );
        require(success, "MicroAAOFactory: AAO creation failed");
        
        // Decode the result to get the AAO ID
        uint256 microAaoId = abi.decode(result, (uint256));
        
        // Register this as a micro AAO and associate it with the macro AAO
        isMicroAAO[microAaoId] = true;
        microToMacroAAO[microAaoId] = macroAaoId;
        macroToMicroAAOs[macroAaoId].push(microAaoId);
        
        emit MicroAAOCreated(microAaoId, macroAaoId, topic, msg.sender);
        
        return microAaoId;
    }
    
    /**
     * @dev Gets all micro AAO IDs for a specific macro AAO
     * @param macroAaoId The ID of the macro AAO
     * @return Array of micro AAO IDs
     */
    function getMicroAAOsForMacro(uint256 macroAaoId) external view returns (uint256[] memory) {
        return macroToMicroAAOs[macroAaoId];
    }
    
    /**
     * @dev Gets the count of micro AAOs for a specific macro AAO
     * @param macroAaoId The ID of the macro AAO
     * @return Count of micro AAOs
     */
    function getMicroAAOCountForMacro(uint256 macroAaoId) external view returns (uint256) {
        return macroToMicroAAOs[macroAaoId].length;
    }
    
    /**
     * @dev Gets the parent macro AAO ID for a micro AAO
     * @param microAaoId The ID of the micro AAO
     * @return The ID of the parent macro AAO
     */
    function getParentMacroAAO(uint256 microAaoId) external view returns (uint256) {
        require(isMicroAAO[microAaoId], "MicroAAOFactory: Not a micro AAO");
        return microToMacroAAO[microAaoId];
    }
}
