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
    let diamondLoupeContract;

    beforeEach(async function () {
        [owner, addr1, addr2] = await ethers.getSigners();

        // Deploy DiamondCutFacet
        const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
        diamondCutFacet = await DiamondCutFacet.deploy();

        // Deploy DiamondInit
        const DiamondInit = await ethers.getContractFactory("DiamondInit");
        diamondInit = await DiamondInit.deploy();

        // Deploy DiamondController
        const DiamondController = await ethers.getContractFactory("DiamondController");
        const diamondCutFacetAddress = await diamondCutFacet.getAddress();
        diamondController = await DiamondController.deploy(owner.address, diamondCutFacetAddress);

        // Deploy DiamondLoupeFacet
        const DiamondLoupeFacet = await ethers.getContractFactory("DiamondLoupeFacet");
        diamondLoupeFacet = await DiamondLoupeFacet.deploy();
        
        // Add DiamondLoupeFacet to diamond
        const diamondCut = await ethers.getContractAt("IDiamondCut", await diamondController.getAddress());
        const diamondLoupeFacetAddress = await diamondLoupeFacet.getAddress();
        
        await diamondCut.diamondCut(
            [{
                facetAddress: diamondLoupeFacetAddress,
                action: FacetCutAction.Add,
                functionSelectors: getSelectors(diamondLoupeFacet)
            }],
            ethers.ZeroAddress,
            "0x"
        );
        
        diamondLoupeContract = await ethers.getContractAt("DiamondLoupeFacet", await diamondController.getAddress());
    });

    describe("Initialization", function () {
        it("Should initialize with correct interfaces", async function () {
            const erc165InterfaceId = "0x01ffc9a7";
            expect(await diamondLoupeContract.supportsInterface(erc165InterfaceId)).to.be.true;
        });
    });

    describe("Facet Management", function () {
        it("Should add facet", async function () {
            // This test is redundant since we already add the facet in beforeEach
            // Just verify that the facet is there
            const facets = await diamondLoupeContract.facets();
            const facetAddresses = await Promise.all(facets.map(async facet => await facet.facetAddress));
            expect(facetAddresses).to.include(await diamondLoupeFacet.getAddress());
        });

        it("Should replace facet", async function () {
            // Deploy a new DiamondLoupeFacet
            const DiamondLoupeFacetV2 = await ethers.getContractFactory("DiamondLoupeFacet");
            const diamondLoupeFacetV2 = await DiamondLoupeFacetV2.deploy();
            
            // Replace the facet
            const diamondCut = await ethers.getContractAt("IDiamondCut", await diamondController.getAddress());
            await diamondCut.diamondCut(
                [{
                    facetAddress: await diamondLoupeFacetV2.getAddress(),
                    action: FacetCutAction.Replace,
                    functionSelectors: getSelectors(diamondLoupeFacet)
                }],
                ethers.ZeroAddress,
                "0x"
            );
            
            // Verify the facet was replaced
            const facets = await diamondLoupeContract.facets();
            const facetAddresses = await Promise.all(facets.map(async facet => await facet.facetAddress));
            expect(facetAddresses).to.include(await diamondLoupeFacetV2.getAddress());
        });

        it("Should remove facet", async function () {
            // Remove the facet
            const diamondCut = await ethers.getContractAt("IDiamondCut", await diamondController.getAddress());
            await diamondCut.diamondCut(
                [{
                    facetAddress: ethers.ZeroAddress,
                    action: FacetCutAction.Remove,
                    functionSelectors: getSelectors(diamondLoupeFacet)
                }],
                ethers.ZeroAddress,
                "0x"
            );
            
            // This will fail since we removed the facet
            await expect(diamondLoupeContract.facets()).to.be.reverted;
        });
    });

    describe("Access Control", function () {
        it("Should only allow owner to cut diamond", async function () {
            const diamondCut = await ethers.getContractAt("IDiamondCut", await diamondController.getAddress());
            await expect(
                diamondCut.connect(addr1).diamondCut([], ethers.ZeroAddress, "0x")
            ).to.be.revertedWith("LibDiamond: Must be contract owner");
        });
    });
});
