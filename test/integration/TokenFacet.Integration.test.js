const { expect } = require("chai");
const { ethers } = require("hardhat");
const { getSelectors, FacetCutAction } = require("../helpers/diamond");
const TokenHelper = require("../helpers/token");

describe("TokenFacet Integration", function () {
    let diamondController;
    let tokenFacet;
    let diamondCutFacet;
    let diamondLoupeFacet;
    let mockToken1;
    let owner;
    let addr1;

    beforeEach(async function () {
        [owner, addr1] = await ethers.getSigners();

        // Deploy mock token
        mockToken1 = await TokenHelper.deployMockToken("Mock Token 1", "MT1");

        // Deploy DiamondCutFacet
        const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
        diamondCutFacet = await DiamondCutFacet.deploy();
        await diamondCutFacet.deployed();

        // Deploy DiamondController
        const DiamondController = await ethers.getContractFactory("DiamondController");
        diamondController = await DiamondController.deploy(owner.address, diamondCutFacet.address);
        await diamondController.deployed();

        // Deploy DiamondLoupeFacet
        const DiamondLoupeFacet = await ethers.getContractFactory("DiamondLoupeFacet");
        diamondLoupeFacet = await DiamondLoupeFacet.deploy();
        await diamondLoupeFacet.deployed();

        // Deploy TokenFacet
        const TokenFacet = await ethers.getContractFactory("TokenFacet");
        const tokenFacetContract = await TokenFacet.deploy();
        await tokenFacetContract.deployed();

        // Add facets to diamond
        const diamondCut = await ethers.getContractAt("IDiamondCut", diamondController.address);
        
        // Add DiamondLoupeFacet
        await diamondCut.diamondCut(
            [{
                facetAddress: diamondLoupeFacet.address,
                action: FacetCutAction.Add,
                functionSelectors: getSelectors(diamondLoupeFacet)
            }],
            ethers.constants.AddressZero,
            "0x"
        );

        // Add TokenFacet
        await diamondCut.diamondCut(
            [{
                facetAddress: tokenFacetContract.address,
                action: FacetCutAction.Add,
                functionSelectors: getSelectors(tokenFacetContract)
            }],
            ethers.constants.AddressZero,
            "0x"
        );

        // Get facet instances
        tokenFacet = await TokenHelper.getTokenFacet(diamondController.address);
        diamondLoupeFacet = await ethers.getContractAt("DiamondLoupeFacet", diamondController.address);
    });

    describe("Integration with DiamondLoupeFacet", function () {
        it("Should show TokenFacet functions in facet list", async function () {
            const facets = await diamondLoupeFacet.facets();
            const tokenFacetFunctions = facets.find(
                f => f.facetAddress === tokenFacet.address
            );
            expect(tokenFacetFunctions).to.not.be.undefined;
            expect(tokenFacetFunctions.functionSelectors).to.not.be.empty;
        });

        it("Should return correct facet address for token functions", async function () {
            const registerTokenSelector = tokenFacet.interface.getSighash('registerToken');
            const facetAddress = await diamondLoupeFacet.facetAddress(registerTokenSelector);
            expect(facetAddress).to.equal(tokenFacet.address);
        });
    });

    describe("Integration with DiamondCutFacet", function () {
        let newTokenFacet;

        beforeEach(async function () {
            // Deploy new version of TokenFacet
            const TokenFacet = await ethers.getContractFactory("TokenFacet");
            newTokenFacet = await TokenFacet.deploy();
            await newTokenFacet.deployed();
        });

        it("Should preserve token data when upgrading facet", async function () {
            // Register a token
            await tokenFacet.registerToken(mockToken1.address, "Mock Token 1", "MT1");
            const originalInfo = await tokenFacet.getTokenInfo(mockToken1.address);

            // Replace TokenFacet with new version
            const diamondCut = await ethers.getContractAt("IDiamondCut", diamondController.address);
            await diamondCut.diamondCut(
                [{
                    facetAddress: newTokenFacet.address,
                    action: FacetCutAction.Replace,
                    functionSelectors: getSelectors(newTokenFacet)
                }],
                ethers.constants.AddressZero,
                "0x"
            );

            // Get new TokenFacet instance
            const updatedTokenFacet = await TokenHelper.getTokenFacet(diamondController.address);
            
            // Verify token data is preserved
            const newInfo = await updatedTokenFacet.getTokenInfo(mockToken1.address);
            expect(newInfo.name).to.equal(originalInfo.name);
            expect(newInfo.symbol).to.equal(originalInfo.symbol);
            expect(newInfo.isActive).to.equal(originalInfo.isActive);
            expect(newInfo.registeredAt).to.equal(originalInfo.registeredAt);
        });

        it("Should handle facet removal correctly", async function () {
            // Register a token first
            await tokenFacet.registerToken(mockToken1.address, "Mock Token 1", "MT1");

            // Remove TokenFacet
            const diamondCut = await ethers.getContractAt("IDiamondCut", diamondController.address);
            await diamondCut.diamondCut(
                [{
                    facetAddress: ethers.constants.AddressZero,
                    action: FacetCutAction.Remove,
                    functionSelectors: getSelectors(tokenFacet)
                }],
                ethers.constants.AddressZero,
                "0x"
            );

            // Verify facet is removed
            const registerTokenSelector = tokenFacet.interface.getSighash('registerToken');
            await expect(
                diamondLoupeFacet.facetAddress(registerTokenSelector)
            ).to.be.revertedWith("Diamond: Function does not exist");
        });
    });

    describe("Storage Collision Prevention", function () {
        it("Should maintain separate storage slots for different facets", async function () {
            // Register a token
            await tokenFacet.registerToken(mockToken1.address, "Mock Token 1", "MT1");

            // Verify storage position is unique
            const tokenStoragePosition = ethers.utils.keccak256(
                ethers.utils.toUtf8Bytes("diamond.standard.token.storage")
            );
            const diamondStoragePosition = ethers.utils.keccak256(
                ethers.utils.toUtf8Bytes("diamond.standard.diamond.storage")
            );
            expect(tokenStoragePosition).to.not.equal(diamondStoragePosition);
        });
    });

    describe("Error Handling Integration", function () {
        it("Should handle errors consistently across facets", async function () {
            // Try to register token as non-owner through diamond proxy
            await expect(
                tokenFacet.connect(addr1).registerToken(mockToken1.address, "Mock Token 1", "MT1")
            ).to.be.revertedWith("LibDiamond: Must be contract owner");

            // Verify token wasn't registered
            await expect(
                tokenFacet.getTokenInfo(mockToken1.address)
            ).to.be.revertedWithCustomError(tokenFacet, "TokenNotRegistered");
        });
    });

    describe("Event Integration", function () {
        it("Should emit events that can be caught through diamond proxy", async function () {
            const tx = await tokenFacet.registerToken(mockToken1.address, "Mock Token 1", "MT1");
            
            // Verify events can be caught from diamond address
            await expect(tx)
                .to.emit(diamondController, "TokenRegistered")
                .withArgs(mockToken1.address, "Mock Token 1", "MT1");
        });
    });
});
