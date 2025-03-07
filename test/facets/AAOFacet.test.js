const { expect } = require("chai");
const { ethers } = require("hardhat");
const { getSelectors, FacetCutAction } = require("../helpers/diamond");

describe("AAOFacet", function () {
  let diamondCutFacet;
  let diamondLoupeFacet;
  let aaoFacet;
  let libAAO;
  let macroAAOFactory;
  let microAAOFactory;
  let owner;
  let user1;
  let user2;
  let user3;

  before(async function () {
    // Get signers
    [owner, user1, user2, user3] = await ethers.getSigners();

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

    // Deploy MicroAAOFactory
    const MicroAAOFactory = await ethers.getContractFactory("MicroAAOFactory");
    microAAOFactory = await MicroAAOFactory.deploy(diamond.address, macroAAOFactory.address);
    await microAAOFactory.deployed();
  });

  describe("AAO Creation", function () {
    it("should create a Macro AAO", async function () {
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
    });

    it("should create a Micro AAO linked to a Macro AAO", async function () {
      // First create a Macro AAO
      const macroTopic = "Parent Macro AAO";
      const macroDuration = 60 * 60 * 24 * 30; // 30 days

      const macroTx = await macroAAOFactory.createMacroAAO(macroTopic, macroDuration);
      const macroReceipt = await macroTx.wait();
      
      const macroEvent = macroReceipt.events.find(
        (e) => e.event === "AAOCreated"
      );
      const macroId = macroEvent.args.aaoId;

      // Now create a Micro AAO linked to the Macro AAO
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

      // Verify the Micro-Macro relationship
      const parentId = await aaoFacet.getMacroAAOId(microId);
      expect(parentId).to.equal(macroId);
    });
  });

  describe("AAO Membership", function () {
    let aaoId;

    beforeEach(async function () {
      // Create a new AAO for each test
      const topic = "Membership Test AAO";
      const duration = 60 * 60 * 24 * 30; // 30 days

      const tx = await macroAAOFactory.createMacroAAO(topic, duration);
      const receipt = await tx.wait();
      
      const aaoCreatedEvent = receipt.events.find(
        (e) => e.event === "AAOCreated"
      );
      aaoId = aaoCreatedEvent.args.aaoId;
    });

    it("should allow users to join an AAO", async function () {
      // User1 joins the AAO
      await aaoFacet.connect(user1).joinAAO(aaoId);
      
      // Check if user1 is a member
      const isMember = await aaoFacet.isMember(aaoId, user1.address);
      expect(isMember).to.be.true;
      
      // Get members count
      const membersCount = await aaoFacet.getMembersCount(aaoId);
      expect(membersCount).to.equal(2); // Owner + user1
    });

    it("should allow users to leave an AAO", async function () {
      // User1 joins the AAO
      await aaoFacet.connect(user1).joinAAO(aaoId);
      
      // User1 leaves the AAO
      await aaoFacet.connect(user1).leaveAAO(aaoId);
      
      // Check if user1 is still a member
      const isMember = await aaoFacet.isMember(aaoId, user1.address);
      expect(isMember).to.be.false;
    });

    it("should not allow non-members to leave an AAO", async function () {
      // User2 tries to leave without joining
      await expect(
        aaoFacet.connect(user2).leaveAAO(aaoId)
      ).to.be.revertedWith("Not a member of this AAO");
    });
  });

  describe("AAO Administration", function () {
    let aaoId;

    beforeEach(async function () {
      // Create a new AAO for each test
      const topic = "Admin Test AAO";
      const duration = 60 * 60 * 24 * 30; // 30 days

      const tx = await macroAAOFactory.createMacroAAO(topic, duration);
      const receipt = await tx.wait();
      
      const aaoCreatedEvent = receipt.events.find(
        (e) => e.event === "AAOCreated"
      );
      aaoId = aaoCreatedEvent.args.aaoId;
      
      // Add user1 as a member
      await aaoFacet.connect(user1).joinAAO(aaoId);
    });

    it("should allow owner to assign admin role", async function () {
      // Owner assigns admin role to user1
      await aaoFacet.assignAdminRole(aaoId, user1.address);
      
      // Check if user1 is an admin
      const isAdmin = await aaoFacet.isAdmin(aaoId, user1.address);
      expect(isAdmin).to.be.true;
    });

    it("should allow owner to revoke admin role", async function () {
      // Owner assigns admin role to user1
      await aaoFacet.assignAdminRole(aaoId, user1.address);
      
      // Owner revokes admin role from user1
      await aaoFacet.revokeAdminRole(aaoId, user1.address);
      
      // Check if user1 is still an admin
      const isAdmin = await aaoFacet.isAdmin(aaoId, user1.address);
      expect(isAdmin).to.be.false;
    });

    it("should not allow non-owners to assign admin role", async function () {
      // User1 tries to assign admin role to user2
      await expect(
        aaoFacet.connect(user1).assignAdminRole(aaoId, user2.address)
      ).to.be.revertedWith("Only owner can perform this action");
    });
  });

  describe("AAO Lifecycle", function () {
    let aaoId;

    beforeEach(async function () {
      // Create a new AAO for each test
      const topic = "Lifecycle Test AAO";
      const duration = 60 * 60 * 24 * 30; // 30 days

      const tx = await macroAAOFactory.createMacroAAO(topic, duration);
      const receipt = await tx.wait();
      
      const aaoCreatedEvent = receipt.events.find(
        (e) => e.event === "AAOCreated"
      );
      aaoId = aaoCreatedEvent.args.aaoId;
    });

    it("should allow owner to modify AAO details", async function () {
      const newTopic = "Updated AAO Topic";
      const newDuration = 60 * 60 * 24 * 60; // 60 days
      
      // Owner modifies AAO
      await aaoFacet.modifyAAO(aaoId, newTopic, newDuration);
      
      // Get updated AAO details
      const aao = await aaoFacet.getAAO(aaoId);
      expect(aao.topic).to.equal(newTopic);
      expect(aao.duration).to.equal(newDuration);
    });

    it("should allow owner to terminate an AAO", async function () {
      // Owner terminates AAO
      await aaoFacet.terminateAAO(aaoId);
      
      // Get AAO details
      const aao = await aaoFacet.getAAO(aaoId);
      expect(aao.active).to.be.false;
    });

    it("should not allow users to join a terminated AAO", async function () {
      // Owner terminates AAO
      await aaoFacet.terminateAAO(aaoId);
      
      // User2 tries to join
      await expect(
        aaoFacet.connect(user2).joinAAO(aaoId)
      ).to.be.revertedWith("AAO is not active");
    });
  });

  // Add more test sections as needed for other AAO functionality
}); 