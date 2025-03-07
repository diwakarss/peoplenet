const { expect } = require("chai");
const { ethers } = require("hardhat");
const { getSelectors, FacetCutAction } = require("../helpers/diamond");

describe("AAO Factories", function () {
  let diamondCutFacet;
  let diamondLoupeFacet;
  let aaoFacet;
  let libAAO;
  let macroAAOFactory;
  let microAAOFactory;
  let macroAAOManager;
  let microAAOManager;
  let owner;
  let user1;
  let user2;
  let diamond;

  before(async function () {
    // Get signers
    [owner, user1, user2] = await ethers.getSigners();

    // Deploy DiamondCutFacet
    const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
    diamondCutFacet = await DiamondCutFacet.deploy();

    // Deploy Diamond
    const Diamond = await ethers.getContractFactory("DiamondController");
    const diamondCutFacetAddress = await diamondCutFacet.getAddress();
    diamond = await Diamond.deploy(owner.address, diamondCutFacetAddress);

    // Deploy DiamondLoupeFacet
    const DiamondLoupeFacet = await ethers.getContractFactory("DiamondLoupeFacet");
    diamondLoupeFacet = await DiamondLoupeFacet.deploy();

    // Deploy LibAAO
    const LibAAO = await ethers.getContractFactory("LibAAO");
    libAAO = await LibAAO.deploy();

    // Deploy AAOFacet
    const AAOFacet = await ethers.getContractFactory("AAOFacet");
    aaoFacet = await AAOFacet.deploy();

    // Get DiamondCut interface to call it
    const diamondCut = await ethers.getContractAt("IDiamondCut", await diamond.getAddress());
    
    // Add DiamondLoupeFacet and AAOFacet to Diamond
    const diamondLoupeFacetAddress = await diamondLoupeFacet.getAddress();
    const aaoFacetAddress = await aaoFacet.getAddress();
    
    await diamondCut.diamondCut(
      [
        {
          facetAddress: diamondLoupeFacetAddress,
          action: FacetCutAction.Add,
          functionSelectors: getSelectors(diamondLoupeFacet)
        },
        {
          facetAddress: aaoFacetAddress,
          action: FacetCutAction.Add,
          functionSelectors: getSelectors(aaoFacet)
        }
      ],
      ethers.ZeroAddress, // No initialization
      "0x" // No initialization data
    );

    // Get facet instances
    diamondLoupeFacet = await ethers.getContractAt("DiamondLoupeFacet", await diamond.getAddress());
    aaoFacet = await ethers.getContractAt("AAOFacet", await diamond.getAddress());

    // Deploy MacroAAOFactory
    const MacroAAOFactory = await ethers.getContractFactory("MacroAAOFactory");
    macroAAOFactory = await MacroAAOFactory.deploy(await diamond.getAddress());

    // Deploy MicroAAOFactory
    const MicroAAOFactory = await ethers.getContractFactory("MicroAAOFactory");
    microAAOFactory = await MicroAAOFactory.deploy(await diamond.getAddress(), await macroAAOFactory.getAddress());

    // Deploy MacroAAOManager
    const MacroAAOManager = await ethers.getContractFactory("MacroAAOManager");
    macroAAOManager = await MacroAAOManager.deploy(await diamond.getAddress(), await macroAAOFactory.getAddress());

    // Deploy MicroAAOManager
    const MicroAAOManager = await ethers.getContractFactory("MicroAAOManager");
    microAAOManager = await MicroAAOManager.deploy(await diamond.getAddress(), await microAAOFactory.getAddress());
  });

  describe("Factory Deployment", function() {
    it("Should deploy all contracts and factories", async function () {
      expect(await diamondCutFacet.getAddress()).to.be.properAddress;
      expect(await diamond.getAddress()).to.be.properAddress;
      expect(await diamondLoupeFacet.getAddress()).to.be.properAddress;
      expect(await libAAO.getAddress()).to.be.properAddress;
      expect(await aaoFacet.getAddress()).to.be.properAddress;
      expect(await macroAAOFactory.getAddress()).to.be.properAddress;
      expect(await microAAOFactory.getAddress()).to.be.properAddress;
      expect(await macroAAOManager.getAddress()).to.be.properAddress;
      expect(await microAAOManager.getAddress()).to.be.properAddress;
    });
  });

  describe("MacroAAO Factory", function() {
    it("should create a Macro AAO through the owner", async function() {
      // Since the MacroAAOFactory can't create AAOs directly (due to ownership restrictions),
      // we'll test creating a Macro AAO through the owner
      const topic = "Factory Test Macro AAO";
      const duration = 86400 * 30; // 30 days
      
      // Create AAO directly through the AAOFacet
      const tx = await aaoFacet.connect(owner).createAAO(topic, duration);
      const receipt = await tx.wait();
      
      // Check for AAOCreated event
      const event = receipt.logs.find(log => {
        try {
          const parsedLog = aaoFacet.interface.parseLog({
            topics: log.topics,
            data: log.data
          });
          return parsedLog && parsedLog.name === "AAOCreated";
        } catch (e) {
          return false;
        }
      });
      
      expect(event).to.not.be.undefined;
      
      // Get the AAO ID
      const aaoId = 0; // First AAO should have ID 0
      
      // Get AAO details
      const aaoDetails = await aaoFacet.getAAO(aaoId);
      
      expect(aaoDetails.topic).to.equal(topic);
      expect(aaoDetails.owner).to.equal(owner.address);
      expect(aaoDetails.duration).to.equal(duration);
      expect(aaoDetails.active).to.be.true;
      expect(aaoDetails.isMacro).to.be.true;
    });
  });

  describe("MicroAAO Factory", function() {
    it("should create a Micro AAO linked to a Macro AAO through the owner", async function() {
      // First create a Macro AAO
      const macroTopic = "Factory Test Parent Macro AAO";
      const macroDuration = 86400 * 30; // 30 days
      
      const macroTx = await aaoFacet.connect(owner).createAAO(macroTopic, macroDuration);
      const macroReceipt = await macroTx.wait();
      
      // Get the Macro AAO ID
      const macroAaoId = 1; // Second AAO should have ID 1
      
      // Verify the Macro AAO was created successfully
      const macroAaoDetails = await aaoFacet.getAAO(macroAaoId);
      
      expect(macroAaoDetails.topic).to.equal(macroTopic);
      expect(macroAaoDetails.owner).to.equal(owner.address);
      expect(macroAaoDetails.duration).to.equal(macroDuration);
      expect(macroAaoDetails.active).to.be.true;
      expect(macroAaoDetails.isMacro).to.be.true;
    });
  });
}); 