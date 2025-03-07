const { ethers } = require("hardhat");
const { getSelectors, FacetCutAction } = require("../utils/diamond");

async function deployAAOFacet(diamondAddress) {
  try {
    const accounts = await ethers.getSigners();
    const contractOwner = accounts[0];

    // Deploy LibAAO
    const LibAAO = await ethers.getContractFactory("LibAAO");
    console.log('Deploying LibAAO...');
    const libAAO = await LibAAO.deploy();
    const libAAOTx = await libAAO.deploymentTransaction().wait();
    console.log("LibAAO deployed:", libAAO.target);
    
    // Deploy AAOFacet
    const AAOFacet = await ethers.getContractFactory("AAOFacet");
    console.log('Deploying AAOFacet...');
    const aaoFacet = await AAOFacet.deploy();
    const aaoFacetTx = await aaoFacet.deploymentTransaction().wait();
    console.log("AAOFacet deployed:", aaoFacet.target);
    
    // Add AAOFacet to diamond if diamondAddress is provided
    if (diamondAddress) {
      console.log('Adding AAOFacet to diamond...');
      const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress);
      const selectors = getSelectors(aaoFacet);
      
      const tx = await diamondCut.diamondCut(
        [{
          facetAddress: aaoFacet.target,
          action: FacetCutAction.Add,
          functionSelectors: selectors
        }],
        ethers.ZeroAddress,
        "0x"
      );
      await tx.wait();
      console.log('AAOFacet added to diamond');
    }
    
    return {
      libAAO,
      aaoFacet
    };
  } catch (error) {
    console.error('Error in deployAAOFacet:', error);
    throw error;
  }
}

module.exports = deployAAOFacet;
  