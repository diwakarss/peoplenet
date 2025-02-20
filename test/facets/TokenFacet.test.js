const { expect } = require("chai");
const { ethers } = require("hardhat");
const { getSelectors, FacetCutAction } = require("../helpers/diamond");
const TokenHelper = require("../helpers/token");

describe("TokenFacet", function () {
    let diamondController;
    let tokenFacet;
    let mockToken1;
    let mockToken2;
    let owner;
    let addr1;
    let addr2;

    beforeEach(async function () {
        [owner, addr1, addr2] = await ethers.getSigners();

        // Deploy mock tokens
        mockToken1 = await TokenHelper.deployMockToken("Mock Token 1", "MT1");
        mockToken2 = await TokenHelper.deployMockToken("Mock Token 2", "MT2");

        // Deploy Diamond with TokenFacet
        const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
        const diamondCutFacet = await DiamondCutFacet.deploy();
        await diamondCutFacet.deployed();

        const DiamondController = await ethers.getContractFactory("DiamondController");
        diamondController = await DiamondController.deploy(owner.address, diamondCutFacet.address);
        await diamondController.deployed();

        // Deploy and add TokenFacet
        const TokenFacet = await ethers.getContractFactory("TokenFacet");
        const tokenFacetContract = await TokenFacet.deploy();
        await tokenFacetContract.deployed();

        // Add TokenFacet to diamond
        const diamondCut = await ethers.getContractAt("IDiamondCut", diamondController.address);
        const selectors = getSelectors(tokenFacetContract);
        
        await diamondCut.diamondCut(
            [{
                facetAddress: tokenFacetContract.address,
                action: FacetCutAction.Add,
                functionSelectors: selectors
            }],
            ethers.constants.AddressZero,
            "0x"
        );

        // Get TokenFacet interface
        tokenFacet = await TokenHelper.getTokenFacet(diamondController.address);
    });

    describe("Token Registration", function () {
        it("Should register a new token and emit TokenRegistered event", async function () {
            const tx = await tokenFacet.registerToken(
                mockToken1.address,
                "Mock Token 1",
                "MT1"
            );

            // Verify event emission
            await expect(tx)
                .to.emit(tokenFacet, "TokenRegistered")
                .withArgs(mockToken1.address, "Mock Token 1", "MT1");

            // Verify token info
            const tokenInfo = await tokenFacet.getTokenInfo(mockToken1.address);
            expect(tokenInfo.name).to.equal("Mock Token 1");
            expect(tokenInfo.symbol).to.equal("MT1");
            expect(tokenInfo.isActive).to.be.true;
            expect(tokenInfo.decimals).to.equal(18); // Default decimals from MockToken
            expect(tokenInfo.registeredAt).to.be.gt(0);
        });

        it("Should fail to register zero address", async function () {
            await expect(
                tokenFacet.registerToken(
                    ethers.constants.AddressZero,
                    "Invalid Token",
                    "INV"
                )
            ).to.be.revertedWithCustomError(tokenFacet, "InvalidToken")
              .withArgs(ethers.constants.AddressZero, "Zero address");
        });

        it("Should fail to register non-contract address", async function () {
            await expect(
                tokenFacet.registerToken(
                    addr1.address,
                    "Invalid Token",
                    "INV"
                )
            ).to.be.revertedWithCustomError(tokenFacet, "InvalidToken")
              .withArgs(addr1.address, "Not a contract");
        });

        it("Should fail to register same token twice", async function () {
            await tokenFacet.registerToken(
                mockToken1.address,
                "Mock Token 1",
                "MT1"
            );

            await expect(
                tokenFacet.registerToken(
                    mockToken1.address,
                    "Mock Token 1",
                    "MT1"
                )
            ).to.be.revertedWithCustomError(tokenFacet, "TokenAlreadyRegistered")
             .withArgs(mockToken1.address);
        });
    });

    describe("Token Deregistration", function () {
        beforeEach(async function () {
            await tokenFacet.registerToken(
                mockToken1.address,
                "Mock Token 1",
                "MT1"
            );
        });

        it("Should deregister a token and emit TokenDeregistered event", async function () {
            const tx = await tokenFacet.deregisterToken(mockToken1.address);

            // Verify event emission
            await expect(tx)
                .to.emit(tokenFacet, "TokenDeregistered")
                .withArgs(mockToken1.address);

            // Verify token state
            const tokenInfo = await tokenFacet.getTokenInfo(mockToken1.address);
            expect(tokenInfo.isActive).to.be.false;
            expect(await tokenFacet.isTokenRegistered(mockToken1.address)).to.be.false;
        });

        it("Should fail to deregister non-registered token", async function () {
            await expect(
                tokenFacet.deregisterToken(mockToken2.address)
            ).to.be.revertedWithCustomError(tokenFacet, "TokenNotRegistered")
             .withArgs(mockToken2.address);
        });

        it("Should maintain correct token list after deregistration", async function () {
            // Register second token
            await tokenFacet.registerToken(mockToken2.address, "Mock Token 2", "MT2");
            expect(await tokenFacet.getRegisteredTokenCount()).to.equal(2);

            // Deregister first token
            await tokenFacet.deregisterToken(mockToken1.address);
            
            // Check count and remaining token
            expect(await tokenFacet.getRegisteredTokenCount()).to.equal(1);
            const tokens = await tokenFacet.getRegisteredTokens();
            expect(tokens).to.have.lengthOf(1);
            expect(tokens[0]).to.equal(mockToken2.address);
        });
    });

    describe("Token Queries", function () {
        beforeEach(async function () {
            await tokenFacet.registerToken(mockToken1.address, "Mock Token 1", "MT1");
            await tokenFacet.registerToken(mockToken2.address, "Mock Token 2", "MT2");
        });

        it("Should return correct token list", async function () {
            const tokens = await tokenFacet.getRegisteredTokens();
            expect(tokens).to.have.lengthOf(2);
            expect(tokens).to.include(mockToken1.address);
            expect(tokens).to.include(mockToken2.address);
        });

        it("Should return multiple token info correctly", async function () {
            const tokenInfos = await tokenFacet.getMultipleTokenInfo(
                [mockToken1.address, mockToken2.address]
            );
            expect(tokenInfos).to.have.lengthOf(2);
            expect(tokenInfos[0].symbol).to.equal("MT1");
            expect(tokenInfos[1].symbol).to.equal("MT2");
            expect(tokenInfos[0].isActive).to.be.true;
            expect(tokenInfos[1].isActive).to.be.true;
        });

        it("Should handle token registration status correctly", async function () {
            expect(await tokenFacet.isTokenRegistered(mockToken1.address)).to.be.true;
            expect(await tokenFacet.isTokenRegistered(addr1.address)).to.be.false;
            
            await tokenFacet.deregisterToken(mockToken1.address);
            expect(await tokenFacet.isTokenRegistered(mockToken1.address)).to.be.false;
        });
    });

    describe("Interface Support", function () {
        it("Should support ITokenFacet interface", async function () {
            const interfaceId = "0x12345678"; // Replace with actual interface ID
            expect(await tokenFacet.supportsInterface(interfaceId)).to.be.true;
        });
    });
});

describe("TokenFacet Upgrades", function () {
    it("Should preserve state after upgrade", async function () {
        // Add token in V1
        await tokenFacetV1.addSupportedToken(mockToken.address, "MOCK");
        
        // Upgrade to V2
        await upgradeFacet(tokenFacetV2);
        
        // Check if state is preserved
        const tokenInfo = await tokenFacetV2.getTokenInfo(mockToken.address);
        expect(tokenInfo.isSupported).to.be.true;
        expect(tokenInfo.symbol).to.equal("MOCK");
    });
});
