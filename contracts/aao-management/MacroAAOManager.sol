// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../interfaces/IAAOFacet.sol";
import "../library/LibAAO.sol";
import "../diamond/LibDiamond.sol";
import "./MacroAAOFactory.sol";

/**
 * @title MacroAAOManager
 * @dev Manager contract for Macro AAOs with advanced functionality
 * @custom:version 1.0.0
 */
contract MacroAAOManager {
    // Diamond address where the AAOFacet is deployed
    address public immutable diamondAddress;
    
    // MacroAAOFactory reference
    MacroAAOFactory public immutable macroFactory;
    
    // Mapping to track verified macro AAOs
    mapping(uint256 => bool) public isVerifiedMacroAAO;
    
    // Mapping to track macro AAO categories
    mapping(uint256 => string) public macroAAOCategory;
    
    // Events
    event MacroAAOVerified(uint256 indexed aaoId);
    event MacroAAOCategorized(uint256 indexed aaoId, string category);
    
    /**
     * @dev Constructor
     * @param _diamondAddress Address of the diamond contract
     * @param _macroFactoryAddress Address of the MacroAAOFactory contract
     */
    constructor(address _diamondAddress, address _macroFactoryAddress) {
        require(_diamondAddress != address(0), "MacroAAOManager: Invalid diamond address");
        require(_macroFactoryAddress != address(0), "MacroAAOManager: Invalid macro factory address");
        diamondAddress = _diamondAddress;
        macroFactory = MacroAAOFactory(_macroFactoryAddress);
    }
    
    /**
     * @dev Verifies a macro AAO (only callable by contract owner)
     * @param aaoId The ID of the macro AAO to verify
     */
    function verifyMacroAAO(uint256 aaoId) external {
        // Only the contract owner can verify AAOs
        // This would typically use access control, but for simplicity we'll use a direct call
        (bool success, ) = diamondAddress.call(
            abi.encodeWithSignature("enforceIsContractOwner()")
        );
        require(success, "MacroAAOManager: Not authorized");
        
        // Verify that this is a macro AAO
        require(macroFactory.isMacroAAO(aaoId), "MacroAAOManager: Not a macro AAO");
        
        // Mark the AAO as verified
        isVerifiedMacroAAO[aaoId] = true;
        
        emit MacroAAOVerified(aaoId);
    }
    
    /**
     * @dev Sets the category for a macro AAO (only callable by contract owner)
     * @param aaoId The ID of the macro AAO
     * @param category The category to assign
     */
    function setMacroAAOCategory(uint256 aaoId, string calldata category) external {
        // Only the contract owner can categorize AAOs
        (bool success, ) = diamondAddress.call(
            abi.encodeWithSignature("enforceIsContractOwner()")
        );
        require(success, "MacroAAOManager: Not authorized");
        
        // Verify that this is a macro AAO
        require(macroFactory.isMacroAAO(aaoId), "MacroAAOManager: Not a macro AAO");
        
        // Set the category
        macroAAOCategory[aaoId] = category;
        
        emit MacroAAOCategorized(aaoId, category);
    }
    
    /**
     * @dev Gets all verified macro AAO IDs
     * @return Array of verified macro AAO IDs
     */
    function getVerifiedMacroAAOs() external view returns (uint256[] memory) {
        uint256[] memory allMacroAAOs = macroFactory.getAllMacroAAOIds();
        uint256 verifiedCount = 0;
        
        // First, count how many are verified
        for (uint256 i = 0; i < allMacroAAOs.length; i++) {
            if (isVerifiedMacroAAO[allMacroAAOs[i]]) {
                verifiedCount++;
            }
        }
        
        // Create the result array
        uint256[] memory verifiedAAOs = new uint256[](verifiedCount);
        uint256 index = 0;
        
        // Fill the result array
        for (uint256 i = 0; i < allMacroAAOs.length; i++) {
            if (isVerifiedMacroAAO[allMacroAAOs[i]]) {
                verifiedAAOs[index] = allMacroAAOs[i];
                index++;
            }
        }
        
        return verifiedAAOs;
    }
    
    /**
     * @dev Gets all macro AAOs in a specific category
     * @param category The category to filter by
     * @return Array of macro AAO IDs in the specified category
     */
    function getMacroAAOsByCategory(string calldata category) external view returns (uint256[] memory) {
        uint256[] memory allMacroAAOs = macroFactory.getAllMacroAAOIds();
        uint256 categoryCount = 0;
        
        // First, count how many are in this category
        for (uint256 i = 0; i < allMacroAAOs.length; i++) {
            if (keccak256(bytes(macroAAOCategory[allMacroAAOs[i]])) == keccak256(bytes(category))) {
                categoryCount++;
            }
        }
        
        // Create the result array
        uint256[] memory categoryAAOs = new uint256[](categoryCount);
        uint256 index = 0;
        
        // Fill the result array
        for (uint256 i = 0; i < allMacroAAOs.length; i++) {
            if (keccak256(bytes(macroAAOCategory[allMacroAAOs[i]])) == keccak256(bytes(category))) {
                categoryAAOs[index] = allMacroAAOs[i];
                index++;
            }
        }
        
        return categoryAAOs;
    }
}
