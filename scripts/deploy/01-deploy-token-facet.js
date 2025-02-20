const { ethers } = require("hardhat");
const { getSelectors, FacetCutAction } = require("../deploy scripts/utils/diamond.js");

async function deployTokenFacet(diamondAddress) {
    console.log('Deploying TokenFacet...');

    // Deploy TokenFacet
    const TokenFacet = await ethers.getContractFactory("TokenFacet");
    const tokenFacet = await TokenFacet.deploy();
    await tokenFacet.deployed();
    console.log('TokenFacet deployed:', tokenFacet.address);

    // Add TokenFacet to diamond
    const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress);
    const selectors = getSelectors(tokenFacet);
    
    console.log('Adding TokenFacet to diamond...');
    const tx = await diamondCut.diamondCut(
        [{
            facetAddress: tokenFacet.address,
            action: FacetCutAction.Add,
            functionSelectors: selectors
        }],
        ethers.constants.AddressZero,
        "0x"
    );
    await tx.wait();
    console.log('TokenFacet added to diamond');

    // Verify deployment
    const tokenFacetInstance = await ethers.getContractAt("TokenFacet", diamondAddress);
    console.log('Verifying TokenFacet deployment...');

    // Verify interface support
    const interfaceId = tokenFacetInstance.interface.getSighash('registerToken');
    const diamondLoupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress);
    const facetAddress = await diamondLoupe.facetAddress(interfaceId);
    
    if (facetAddress !== tokenFacet.address) {
        throw new Error('TokenFacet verification failed');
    }
    console.log('TokenFacet verification successful');

    return tokenFacet;
}

module.exports = deployTokenFacet;
