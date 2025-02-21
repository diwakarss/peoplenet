const { ethers } = require("hardhat");
const { getSelectors, FacetCutAction } = require("../utils/diamond.js");

async function deployDiamond() {
    const accounts = await ethers.getSigners();
    const contractOwner = accounts[0];
    console.log('Deploying contracts with the account:', contractOwner.address);

    // Deploy DiamondCutFacet
    const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
    const diamondCutFacet = await DiamondCutFacet.deploy();
    await diamondCutFacet.deployed();
    console.log('DiamondCutFacet deployed:', diamondCutFacet.address);

    // Deploy Diamond
    const DiamondController = await ethers.getContractFactory("DiamondController");
    const diamond = await DiamondController.deploy(contractOwner.address, diamondCutFacet.address);
    await diamond.deployed();
    console.log('Diamond deployed:', diamond.address);

    // Deploy DiamondInit
    const DiamondInit = await ethers.getContractFactory("DiamondInit");
    const diamondInit = await DiamondInit.deploy();
    await diamondInit.deployed();
    console.log('DiamondInit deployed:', diamondInit.address);

    // Deploy DiamondLoupeFacet
    const DiamondLoupeFacet = await ethers.getContractFactory("DiamondLoupeFacet");
    const diamondLoupeFacet = await DiamondLoupeFacet.deploy();
    await diamondLoupeFacet.deployed();
    console.log('DiamondLoupeFacet deployed:', diamondLoupeFacet.address);

    // Add DiamondLoupeFacet
    const diamondCut = await ethers.getContractAt('IDiamondCut', diamond.address);
    const selectors = getSelectors(diamondLoupeFacet);
    
    const tx = await diamondCut.diamondCut(
        [{
            facetAddress: diamondLoupeFacet.address,
            action: FacetCutAction.Add,
            functionSelectors: selectors
        }],
        ethers.constants.AddressZero,
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
}

module.exports = deployDiamond;
