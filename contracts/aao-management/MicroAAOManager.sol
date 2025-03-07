// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../interfaces/IAAOFacet.sol";
import "../library/LibAAO.sol";
import "../diamond/LibDiamond.sol";
import "./MicroAAOFactory.sol";

/**
 * @title MicroAAOManager
 * @dev Manager contract for Micro AAOs with advanced functionality
 * @custom:version 1.0.0
 */
contract MicroAAOManager {
    // Diamond address where the AAOFacet is deployed
    address public immutable diamondAddress;
    
    // MicroAAOFactory reference
    MicroAAOFactory public immutable microFactory;
    
    // Mapping to track micro AAO priorities (1-5, with 5 being highest)
    mapping(uint256 => uint8) public microAAOPriority;
    
    // Mapping to track micro AAO tags
    mapping(uint256 => string[]) public microAAOTags;
    
    // Events
    event MicroAAOPrioritySet(uint256 indexed aaoId, uint8 priority);
    event MicroAAOTagAdded(uint256 indexed aaoId, string tag);
    
    /**
     * @dev Constructor
     * @param _diamondAddress Address of the diamond contract
     * @param _microFactoryAddress Address of the MicroAAOFactory contract
     */
    constructor(address _diamondAddress, address _microFactoryAddress) {
        require(_diamondAddress != address(0), "MicroAAOManager: Invalid diamond address");
        require(_microFactoryAddress != address(0), "MicroAAOManager: Invalid micro factory address");
        diamondAddress = _diamondAddress;
        microFactory = MicroAAOFactory(_microFactoryAddress);
    }
    
    /**
     * @dev Sets the priority for a micro AAO
     * @param aaoId The ID of the micro AAO
     * @param priority The priority level (1-5)
     */
    function setMicroAAOPriority(uint256 aaoId, uint8 priority) external {
        // Verify that this is a micro AAO
        require(microFactory.isMicroAAO(aaoId), "MicroAAOManager: Not a micro AAO");
        
        // Verify that the caller is an admin of the AAO
        (bool success, bytes memory result) = diamondAddress.call(
            abi.encodeWithSignature("isAdmin(uint256,address)", aaoId, msg.sender)
        );
        require(success, "MicroAAOManager: Call failed");
        bool isAdmin = abi.decode(result, (bool));
        require(isAdmin, "MicroAAOManager: Not an admin");
        
        // Validate priority range
        require(priority >= 1 && priority <= 5, "MicroAAOManager: Invalid priority");
        
        // Set the priority
        microAAOPriority[aaoId] = priority;
        
        emit MicroAAOPrioritySet(aaoId, priority);
    }
    
    /**
     * @dev Adds a tag to a micro AAO
     * @param aaoId The ID of the micro AAO
     * @param tag The tag to add
     */
    function addMicroAAOTag(uint256 aaoId, string calldata tag) external {
        // Verify that this is a micro AAO
        require(microFactory.isMicroAAO(aaoId), "MicroAAOManager: Not a micro AAO");
        
        // Verify that the caller is an admin of the AAO
        (bool success, bytes memory result) = diamondAddress.call(
            abi.encodeWithSignature("isAdmin(uint256,address)", aaoId, msg.sender)
        );
        require(success, "MicroAAOManager: Call failed");
        bool isAdmin = abi.decode(result, (bool));
        require(isAdmin, "MicroAAOManager: Not an admin");
        
        // Add the tag
        microAAOTags[aaoId].push(tag);
        
        emit MicroAAOTagAdded(aaoId, tag);
    }
    
    /**
     * @dev Gets all tags for a micro AAO
     * @param aaoId The ID of the micro AAO
     * @return Array of tags
     */
    function getMicroAAOTags(uint256 aaoId) external view returns (string[] memory) {
        require(microFactory.isMicroAAO(aaoId), "MicroAAOManager: Not a micro AAO");
        return microAAOTags[aaoId];
    }
    
    /**
     * @dev Gets high-priority micro AAOs for a specific macro AAO
     * @param macroAaoId The ID of the macro AAO
     * @param minPriority The minimum priority level (1-5)
     * @return Array of high-priority micro AAO IDs
     */
    function getHighPriorityMicroAAOs(uint256 macroAaoId, uint8 minPriority) external view returns (uint256[] memory) {
        require(minPriority >= 1 && minPriority <= 5, "MicroAAOManager: Invalid priority");
        
        uint256[] memory microAAOs = microFactory.getMicroAAOsForMacro(macroAaoId);
        uint256 highPriorityCount = 0;
        
        // First, count how many are high priority
        for (uint256 i = 0; i < microAAOs.length; i++) {
            if (microAAOPriority[microAAOs[i]] >= minPriority) {
                highPriorityCount++;
            }
        }
        
        // Create the result array
        uint256[] memory highPriorityAAOs = new uint256[](highPriorityCount);
        uint256 index = 0;
        
        // Fill the result array
        for (uint256 i = 0; i < microAAOs.length; i++) {
            if (microAAOPriority[microAAOs[i]] >= minPriority) {
                highPriorityAAOs[index] = microAAOs[i];
                index++;
            }
        }
        
        return highPriorityAAOs;
    }
}
