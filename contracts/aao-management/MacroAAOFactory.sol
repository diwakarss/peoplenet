// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../interfaces/IAAOFacet.sol";
import "../library/LibAAO.sol";
import "../diamond/LibDiamond.sol";

/**
 * @title MacroAAOFactory
 * @dev Factory contract for creating and managing Macro AAOs
 * @custom:version 1.0.0
 */
contract MacroAAOFactory {
    // Diamond address where the AAOFacet is deployed
    address public immutable diamondAddress;
    
    // Mapping to track macro AAOs created by this factory
    mapping(uint256 => bool) public isMacroAAO;
    
    // Array to store all macro AAO IDs
    uint256[] public macroAAOIds;
    
    // Events
    event MacroAAOCreated(uint256 indexed aaoId, string topic, address indexed owner);
    
    /**
     * @dev Constructor
     * @param _diamondAddress Address of the diamond contract
     */
    constructor(address _diamondAddress) {
        require(_diamondAddress != address(0), "MacroAAOFactory: Invalid diamond address");
        diamondAddress = _diamondAddress;
    }
    
    /**
     * @dev Creates a new Macro AAO
     * @param topic The topic or purpose of the AAO
     * @param duration The duration of the AAO in seconds (0 for permanent)
     * @return aaoId The ID of the newly created AAO
     */
    function createMacroAAO(
        string calldata topic,
        uint256 duration
    ) external returns (uint256) {
        // Call the AAOFacet through the diamond to create the AAO
        (bool success, bytes memory result) = diamondAddress.call(
            abi.encodeWithSignature("createAAO(string,uint256)", topic, duration)
        );
        require(success, "MacroAAOFactory: AAO creation failed");
        
        // Decode the result to get the AAO ID
        uint256 aaoId = abi.decode(result, (uint256));
        
        // Register this as a macro AAO
        isMacroAAO[aaoId] = true;
        macroAAOIds.push(aaoId);
        
        emit MacroAAOCreated(aaoId, topic, msg.sender);
        
        return aaoId;
    }
    
    /**
     * @dev Gets all macro AAO IDs
     * @return Array of macro AAO IDs
     */
    function getAllMacroAAOIds() external view returns (uint256[] memory) {
        return macroAAOIds;
    }
    
    /**
     * @dev Gets the count of macro AAOs
     * @return Count of macro AAOs
     */
    function getMacroAAOCount() external view returns (uint256) {
        return macroAAOIds.length;
    }
}
