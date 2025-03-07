const { ethers } = require("hardhat");
const { getSelectors, FacetCutAction } = require("../utils/diamond.js");

async function deployDiamond() {
    const accounts = await ethers.getSigners();
    const contractOwner = accounts[0];
    console.log('Deploying contracts with the account:', contractOwner.address);

    try {
        // Deploy DiamondCutFacet
        const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
        console.log('Deploying DiamondCutFacet...');
        const diamondCutFacet = await DiamondCutFacet.deploy();
        const diamondCutFacetTx = await diamondCutFacet.deploymentTransaction().wait();
        console.log('DiamondCutFacet deployed:', diamondCutFacet.target);

        // Deploy Diamond
        const DiamondController = await ethers.getContractFactory("DiamondController");
        console.log('Deploying Diamond...');
        const diamond = await DiamondController.deploy(contractOwner.address, diamondCutFacet.target);
        const diamondTx = await diamond.deploymentTransaction().wait();
        console.log('Diamond deployed:', diamond.target);

        // Deploy DiamondInit
        const DiamondInit = await ethers.getContractFactory("DiamondInit");
        console.log('Deploying DiamondInit...');
        const diamondInit = await DiamondInit.deploy();
        const diamondInitTx = await diamondInit.deploymentTransaction().wait();
        console.log('DiamondInit deployed:', diamondInit.target);

        // Deploy DiamondLoupeFacet
        const DiamondLoupeFacet = await ethers.getContractFactory("DiamondLoupeFacet");
        console.log('Deploying DiamondLoupeFacet...');
        const diamondLoupeFacet = await DiamondLoupeFacet.deploy();
        const diamondLoupeFacetTx = await diamondLoupeFacet.deploymentTransaction().wait();
        console.log('DiamondLoupeFacet deployed:', diamondLoupeFacet.target);

        // Add DiamondLoupeFacet
        const diamondCut = await ethers.getContractAt('IDiamondCut', diamond.target);
        const selectors = getSelectors(diamondLoupeFacet);
        
        console.log('Adding DiamondLoupeFacet to diamond...');
        const tx = await diamondCut.diamondCut(
            [{
                facetAddress: diamondLoupeFacet.target,
                action: FacetCutAction.Add,
                functionSelectors: selectors
            }],
            ethers.ZeroAddress,
            "0x"
        );
        await tx.wait();
        console.log('DiamondLoupeFacet added to diamond');

        return {
            diamond,
            diamondCutFacet,
            diamondInit,
            diamondLoupeFacet,
            contractOwner
        };
    } catch (error) {
        console.error('Error in deployDiamond:', error);
        throw error;
    }
}

module.exports = deployDiamond;
