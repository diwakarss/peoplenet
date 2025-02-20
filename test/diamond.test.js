const { expect } = require("chai");
const { ethers } = require("hardhat");
const { getSelectors, FacetCutAction } = require("./helpers/diamond");

describe("Diamond", function () {
    let diamondController;
    let diamondCutFacet;
    let diamondLoupeFacet;
    let diamondInit;
    let owner;
    let addr1;
    let addr2;

    beforeEach(async function () {
        [owner, addr1, addr2] = await ethers.getSigners();

        // Deploy DiamondCutFacet
        const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
        diamondCutFacet = await DiamondCutFacet.deploy();
        await diamondCutFacet.deployed();

        // Deploy DiamondInit
        const DiamondInit = await ethers.getContractFactory("DiamondInit");
        diamondInit = await DiamondInit.deploy();
        await diamondInit.deployed();

        // Deploy DiamondController
        const DiamondController = await ethers.getContractFactory("DiamondController");
        diamondController = await DiamondController.deploy(owner.address, diamondCutFacet.address);
        await diamondController.deployed();

        // Deploy DiamondLoupeFacet
        const DiamondLoupeFacet = await ethers.getContractFactory("DiamondLoupeFacet");
        diamondLoupeFacet = await DiamondLoupeFacet.deploy();
        await diamondLoupeFacet.deployed();
    });

    describe("Initialization", function () {
        it("Should initialize with correct interfaces", async function () {
            const diamondLoupeContract = await ethers.getContractAt("DiamondLoupeFacet", diamondController.address);
            const erc165InterfaceId = "0x01ffc9a7";
            expect(await diamondLoupeContract.supportsInterface(erc165InterfaceId)).to.be.true;
        });
    });

    describe("Facet Management", function () {
        it("Should add facet", async function () {
            const diamondCut = await ethers.getContractAt("IDiamondCut", diamondController.address);
            const selectors = getSelectors(diamondLoupeFacet);
            
            await diamondCut.diamondCut(
                [{
                    facetAddress: diamondLoupeFacet.address,
                    action: FacetCutAction.Add,
                    functionSelectors: selectors
                }],
                ethers.constants.AddressZero,
                "0x"
            );

            const facets = await diamondLoupeContract.facets();
            expect(facets).to.include(diamondLoupeFacet.address);
        });

        it("Should replace facet", async function () {
            // Test facet replacement
        });

        it("Should remove facet", async function () {
            // Test facet removal
        });
    });

    describe("Access Control", function () {
        it("Should only allow owner to cut diamond", async function () {
            const diamondCut = await ethers.getContractAt("IDiamondCut", diamondController.address);
            await expect(
                diamondCut.connect(addr1).diamondCut([], ethers.constants.AddressZero, "0x")
            ).to.be.revertedWith("LibDiamond: Must be contract owner");
        });
    });
});
