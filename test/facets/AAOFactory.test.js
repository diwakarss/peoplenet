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

  before(async function () {
    // Get signers
    [owner, user1, user2] = await ethers.getSigners();

    // Deploy DiamondCutFacet
    const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
    diamondCutFacet = await DiamondCutFacet.deploy();
    await diamondCutFacet.deployed();

    // Deploy Diamond
    const Diamond = await ethers.getContractFactory("DiamondController");
    diamond = await Diamond.deploy(owner.address, diamondCutFacet.address);
    await diamond.deployed();

    // Deploy DiamondLoupeFacet
    const DiamondLoupeFacet = await ethers.getContractFactory("DiamondLoupeFacet");
    diamondLoupeFacet = await DiamondLoupeFacet.deploy();
    await diamondLoupeFacet.deployed();

    // Deploy LibAAO
    const LibAAO = await ethers.getContractFactory("LibAAO");
    libAAO = await LibAAO.deploy();
    await libAAO.deployed();

    // Deploy AAOFacet
    const AAOFacet = await ethers.getContractFactory("AAOFacet", {
      libraries: {
        LibAAO: libAAO.address,
      },
    });
    aaoFacet = await AAOFacet.deploy();
    await aaoFacet.deployed();

    // Add DiamondLoupeFacet and AAOFacet to Diamond
    const cut = [
      {
        facetAddress: diamondLoupeFacet.address,
        action: FacetCutAction.Add,
        functionSelectors: getSelectors(diamondLoupeFacet),
      },
      {
        facetAddress: aaoFacet.address,
        action: FacetCutAction.Add,
        functionSelectors: getSelectors(aaoFacet),
      },
    ];

    // Add facets to diamond
    const diamondCut = await ethers.getContractAt("IDiamondCut", diamond.address);
    const tx = await diamondCut.diamondCut(cut, ethers.constants.AddressZero, "0x");
    await tx.wait();

    // Get facet instances
    diamondLoupeFacet = await ethers.getContractAt("DiamondLoupeFacet", diamond.address);
    aaoFacet = await ethers.getContractAt("AAOFacet", diamond.address);

    // Deploy MacroAAOFactory
    const MacroAAOFactory = await ethers.getContractFactory("MacroAAOFactory");
    macroAAOFactory = await MacroAAOFactory.deploy(diamond.address);
    await macroAAOFactory.deployed();

    // Deploy MacroAAOManager
    const MacroAAOManager = await ethers.getContractFactory("MacroAAOManager");
    macroAAOManager = await MacroAAOManager.deploy(diamond.address);
    await macroAAOManager.deployed();

    // Deploy MicroAAOFactory
    const MicroAAOFactory = await ethers.getContractFactory("MicroAAOFactory");
    microAAOFactory = await MicroAAOFactory.deploy(diamond.address, macroAAOFactory.address);
    await microAAOFactory.deployed();

    // Deploy MicroAAOManager
    const MicroAAOManager = await ethers.getContractFactory("MicroAAOManager");
    microAAOManager = await MicroAAOManager.deploy(diamond.address, macroAAOManager.address);
    await microAAOManager.deployed();
  });

  describe("MacroAAOFactory", function () {
    it("should create a Macro AAO with correct parameters", async function () {
      const topic = "Test Macro AAO";
      const duration = 60 * 60 * 24 * 30; // 30 days

      const tx = await macroAAOFactory.createMacroAAO(topic, duration);
      const receipt = await tx.wait();

      // Find the AAOCreated event
      const aaoCreatedEvent = receipt.events.find(
        (e) => e.event === "AAOCreated"
      );
      
      expect(aaoCreatedEvent).to.not.be.undefined;
      const aaoId = aaoCreatedEvent.args.aaoId;
      
      // Get AAO details
      const aao = await aaoFacet.getAAO(aaoId);
      expect(aao.topic).to.equal(topic);
      expect(aao.duration).to.equal(duration);
      expect(aao.owner).to.equal(owner.address);
      expect(aao.active).to.be.true;
      expect(aao.isMacro).to.be.true;
    });

    it("should emit AAOCreated event with correct parameters", async function () {
      const topic = "Event Test Macro AAO";
      const duration = 60 * 60 * 24 * 30; // 30 days

      const tx = await macroAAOFactory.createMacroAAO(topic, duration);
      const receipt = await tx.wait();

      // Find the AAOCreated event
      const aaoCreatedEvent = receipt.events.find(
        (e) => e.event === "AAOCreated"
      );
      
      expect(aaoCreatedEvent).to.not.be.undefined;
      expect(aaoCreatedEvent.args.creator).to.equal(owner.address);
      expect(aaoCreatedEvent.args.topic).to.equal(topic);
      expect(aaoCreatedEvent.args.isMacro).to.be.true;
    });

    it("should allow different users to create Macro AAOs", async function () {
      const topic = "User1 Macro AAO";
      const duration = 60 * 60 * 24 * 30; // 30 days

      const tx = await macroAAOFactory.connect(user1).createMacroAAO(topic, duration);
      const receipt = await tx.wait();

      const aaoCreatedEvent = receipt.events.find(
        (e) => e.event === "AAOCreated"
      );
      
      const aaoId = aaoCreatedEvent.args.aaoId;
      
      // Get AAO details
      const aao = await aaoFacet.getAAO(aaoId);
      expect(aao.owner).to.equal(user1.address);
    });
  });

  describe("MicroAAOFactory", function () {
    let macroId;

    beforeEach(async function () {
      // Create a Macro AAO for testing
      const macroTopic = "Parent Macro AAO";
      const macroDuration = 60 * 60 * 24 * 30; // 30 days

      const macroTx = await macroAAOFactory.createMacroAAO(macroTopic, macroDuration);
      const macroReceipt = await macroTx.wait();
      
      const macroEvent = macroReceipt.events.find(
        (e) => e.event === "AAOCreated"
      );
      macroId = macroEvent.args.aaoId;
    });

    it("should create a Micro AAO linked to a Macro AAO", async function () {
      const microTopic = "Child Micro AAO";
      const microDuration = 60 * 60 * 24 * 15; // 15 days

      const microTx = await microAAOFactory.createMicroAAO(microTopic, microDuration, macroId);
      const microReceipt = await microTx.wait();
      
      const microEvent = microReceipt.events.find(
        (e) => e.event === "AAOCreated"
      );
      const microId = microEvent.args.aaoId;

      // Get Micro AAO details
      const microAAO = await aaoFacet.getAAO(microId);
      expect(microAAO.topic).to.equal(microTopic);
      expect(microAAO.duration).to.equal(microDuration);
      expect(microAAO.owner).to.equal(owner.address);
      expect(microAAO.active).to.be.true;
      expect(microAAO.isMacro).to.be.false;

      // Verify the Micro-Macro relationship
      const parentId = await aaoFacet.getMacroAAOId(microId);
      expect(parentId).to.equal(macroId);
    });

    it("should not allow creating a Micro AAO linked to a non-existent Macro AAO", async function () {
      const microTopic = "Invalid Parent Micro AAO";
      const microDuration = 60 * 60 * 24 * 15; // 15 days
      const invalidMacroId = 9999; // Non-existent AAO ID

      await expect(
        microAAOFactory.createMicroAAO(microTopic, microDuration, invalidMacroId)
      ).to.be.revertedWith("Parent Macro AAO does not exist");
    });

    it("should not allow creating a Micro AAO linked to another Micro AAO", async function () {
      // First create a valid Micro AAO
      const microTopic1 = "First Micro AAO";
      const microDuration1 = 60 * 60 * 24 * 15; // 15 days

      const microTx1 = await microAAOFactory.createMicroAAO(microTopic1, microDuration1, macroId);
      const microReceipt1 = await microTx1.wait();
      
      const microEvent1 = microReceipt1.events.find(
        (e) => e.event === "AAOCreated"
      );
      const microId1 = microEvent1.args.aaoId;

      // Try to create a Micro AAO linked to another Micro AAO
      const microTopic2 = "Second Micro AAO";
      const microDuration2 = 60 * 60 * 24 * 15; // 15 days

      await expect(
        microAAOFactory.createMicroAAO(microTopic2, microDuration2, microId1)
      ).to.be.revertedWith("Parent AAO must be a Macro AAO");
    });
  });

  describe("Factory Integration", function () {
    it("should track the total number of AAOs created", async function () {
      // Get initial count
      const initialCount = await aaoFacet.getTotalAAOCount();
      
      // Create a Macro AAO
      const macroTopic = "Count Test Macro AAO";
      const macroDuration = 60 * 60 * 24 * 30; // 30 days
      await macroAAOFactory.createMacroAAO(macroTopic, macroDuration);
      
      // Check count increased by 1
      const countAfterMacro = await aaoFacet.getTotalAAOCount();
      expect(countAfterMacro).to.equal(initialCount.add(1));
      
      // Create a Micro AAO
      const macroId = countAfterMacro.sub(1); // The ID of the just-created Macro AAO
      const microTopic = "Count Test Micro AAO";
      const microDuration = 60 * 60 * 24 * 15; // 15 days
      await microAAOFactory.createMicroAAO(microTopic, microDuration, macroId);
      
      // Check count increased by 1 again
      const finalCount = await aaoFacet.getTotalAAOCount();
      expect(finalCount).to.equal(countAfterMacro.add(1));
    });

    it("should allow retrieving all AAOs created by a user", async function () {
      // Create multiple AAOs as user1
      await macroAAOFactory.connect(user1).createMacroAAO("User1 AAO 1", 60 * 60 * 24 * 30);
      await macroAAOFactory.connect(user1).createMacroAAO("User1 AAO 2", 60 * 60 * 24 * 30);
      
      // Get AAOs created by user1
      const user1AAOs = await aaoFacet.getAAOsByCreator(user1.address);
      
      // Check that we have at least 2 AAOs
      expect(user1AAOs.length).to.be.at.least(2);
      
      // Verify the AAOs belong to user1
      for (const aaoId of user1AAOs) {
        const aao = await aaoFacet.getAAO(aaoId);
        expect(aao.owner).to.equal(user1.address);
      }
    });
  });
}); 