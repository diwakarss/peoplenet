const { ethers } = require("hardhat");
const { getSelectors, FacetCutAction } = require("../utils/diamond.js");

async function deployTokenFacet(diamondAddress) {
    console.log('Deploying TokenFacet...');

    try {
        // Deploy TokenFacet
        const TokenFacet = await ethers.getContractFactory("TokenFacet");
        const tokenFacet = await TokenFacet.deploy();
        const tokenFacetTx = await tokenFacet.deploymentTransaction().wait();
        console.log('TokenFacet deployed:', tokenFacet.target);

        // Add TokenFacet to diamond
        const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress);
        const diamondLoupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress);
        
        // Get all selectors from TokenFacet
        const allSelectors = getSelectors(tokenFacet);
        
        // Check which selectors already exist in the diamond
        const existingSelectors = [];
        const newSelectors = [];
        
        for (const selector of allSelectors) {
            try {
                const facetAddress = await diamondLoupe.facetAddress(selector);
                if (facetAddress === ethers.ZeroAddress) {
                    newSelectors.push(selector);
                } else {
                    existingSelectors.push(selector);
                    console.log(`Selector ${selector} already exists in diamond`);
                }
            } catch (error) {
                // If there's an error, assume the selector doesn't exist
                newSelectors.push(selector);
            }
        }
        
        if (newSelectors.length > 0) {
            console.log('Adding TokenFacet to diamond...');
            const tx = await diamondCut.diamondCut(
                [{
                    facetAddress: tokenFacet.target,
                    action: FacetCutAction.Add,
                    functionSelectors: newSelectors
                }],
                ethers.ZeroAddress,
                "0x"
            );
            await tx.wait();
            console.log('TokenFacet added to diamond');
        } else {
            console.log('No new selectors to add to diamond');
        }

        // Verify deployment
        const tokenFacetInstance = await ethers.getContractAt("TokenFacet", diamondAddress);
        console.log('Verifying TokenFacet deployment...');

        // Verify interface support for at least one function
        if (newSelectors.length > 0) {
            const interfaceId = tokenFacetInstance.interface.getFunction('registerToken').selector;
            const facetAddress = await diamondLoupe.facetAddress(interfaceId);
            
            if (facetAddress !== tokenFacet.target) {
                throw new Error('TokenFacet verification failed');
            }
            console.log('TokenFacet verification successful');
        } else {
            console.log('Skipping verification as no new selectors were added');
        }

        return tokenFacet;
    } catch (error) {
        console.error('Error in deployTokenFacet:', error);
        throw error;
    }
}

module.exports = deployTokenFacet;
