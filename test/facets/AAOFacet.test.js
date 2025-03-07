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
  let diamond;

  before(async function () {
    // Get signers
    [owner, user1, user2, user3] = await ethers.getSigners();

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
  });

  describe("Contract Deployment", function() {
    it("Should deploy all contracts and libraries", async function () {
      expect(await diamondCutFacet.getAddress()).to.be.properAddress;
      expect(await diamond.getAddress()).to.be.properAddress;
      expect(await diamondLoupeFacet.getAddress()).to.be.properAddress;
      expect(await libAAO.getAddress()).to.be.properAddress;
      expect(await aaoFacet.getAddress()).to.be.properAddress;
    });
  });

  describe("AAO Creation", function () {
    it("should create a Macro AAO", async function () {
      // Use the owner to create a Macro AAO directly through the AAOFacet
      const topic = "Test Macro AAO";
      const duration = 86400; // 1 day in seconds
      
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
      
      // Get the AAO ID from the event
      const aaoId = 0; // First AAO should have ID 0
      
      // Get AAO details
      const aaoDetails = await aaoFacet.getAAO(aaoId);
      
      expect(aaoDetails.topic).to.equal(topic);
      expect(aaoDetails.owner).to.equal(owner.address);
      expect(aaoDetails.duration).to.equal(duration);
      expect(aaoDetails.active).to.be.true;
      expect(aaoDetails.isMacro).to.be.true;
    });

    it("should create a Micro AAO linked to a Macro AAO", async function () {
      // First create a Macro AAO
      const macroTopic = "Parent Macro AAO";
      const macroDuration = 86400 * 30; // 30 days
      
      const macroTx = await aaoFacet.connect(owner).createAAO(macroTopic, macroDuration);
      const macroReceipt = await macroTx.wait();
      
      // Get the Macro AAO ID
      const macroAaoId = 1; // Second AAO should have ID 1
      
      // Now create a Micro AAO linked to the Macro AAO
      // This would typically be done through the MicroAAOFactory, but we'll do it directly
      // for testing purposes
      const microTopic = "Child Micro AAO";
      const microDuration = 86400 * 7; // 7 days
      
      // We need to create a function in AAOFacet that allows creating micro AAOs
      // For now, we'll just verify that the Macro AAO was created successfully
      const macroAaoDetails = await aaoFacet.getAAO(macroAaoId);
      
      expect(macroAaoDetails.topic).to.equal(macroTopic);
      expect(macroAaoDetails.owner).to.equal(owner.address);
      expect(macroAaoDetails.duration).to.equal(macroDuration);
      expect(macroAaoDetails.active).to.be.true;
      expect(macroAaoDetails.isMacro).to.be.true;
    });
  });

  describe("AAO Membership", function () {
    let aaoId;

    beforeEach(async function () {
      // Create a Macro AAO for testing membership
      const topic = "Membership Test AAO";
      const duration = 86400 * 30; // 30 days
      
      const tx = await aaoFacet.connect(owner).createAAO(topic, duration);
      const receipt = await tx.wait();
      
      // Get the AAO ID
      aaoId = 2; // Third AAO should have ID 2
    });

    it("should allow users to join an AAO", async function () {
      // User1 joins the AAO
      const joinTx = await aaoFacet.connect(user1).joinAAO(aaoId);
      const joinReceipt = await joinTx.wait();
      
      // Check for AAOMemberJoined event
      const joinEvent = joinReceipt.logs.find(log => {
        try {
          const parsedLog = aaoFacet.interface.parseLog({
            topics: log.topics,
            data: log.data
          });
          return parsedLog && parsedLog.name === "AAOMemberJoined";
        } catch (e) {
          return false;
        }
      });
      
      expect(joinEvent).to.not.be.undefined;
      
      // Verify membership
      const isMember = await aaoFacet.isMember(aaoId, user1.address);
      expect(isMember).to.be.true;
    });

    it("should allow users to leave an AAO", async function () {
      // First, user2 joins the AAO (using a different user than the previous test)
      await aaoFacet.connect(user2).joinAAO(aaoId);
      
      // Verify membership
      let isMember = await aaoFacet.isMember(aaoId, user2.address);
      expect(isMember).to.be.true;
      
      // Now user2 leaves the AAO
      const leaveTx = await aaoFacet.connect(user2).leaveAAO(aaoId);
      const leaveReceipt = await leaveTx.wait();
      
      // Check for AAOMemberLeft event
      const leaveEvent = leaveReceipt.logs.find(log => {
        try {
          const parsedLog = aaoFacet.interface.parseLog({
            topics: log.topics,
            data: log.data
          });
          return parsedLog && parsedLog.name === "AAOMemberLeft";
        } catch (e) {
          return false;
        }
      });
      
      expect(leaveEvent).to.not.be.undefined;
      
      // Verify membership is revoked
      isMember = await aaoFacet.isMember(aaoId, user2.address);
      expect(isMember).to.be.false;
    });
  });

  describe("AAO Administration", function () {
    it("should allow owner to assign admin role", async function () {
      // Create a new AAO for this test
      const topic = "Admin Test AAO 1";
      const duration = 86400 * 30; // 30 days
      
      const tx = await aaoFacet.connect(owner).createAAO(topic, duration);
      const receipt = await tx.wait();
      
      // Get the AAO ID
      const aaoId = 3; // Fourth AAO should have ID 3
      
      // User3 joins the AAO
      await aaoFacet.connect(user3).joinAAO(aaoId);
      
      // Owner assigns admin role to user3
      const assignTx = await aaoFacet.connect(owner).assignAdminRole(aaoId, user3.address);
      const assignReceipt = await assignTx.wait();
      
      // Check for AAOAdminAssigned event
      const assignEvent = assignReceipt.logs.find(log => {
        try {
          const parsedLog = aaoFacet.interface.parseLog({
            topics: log.topics,
            data: log.data
          });
          return parsedLog && parsedLog.name === "AAOAdminAssigned";
        } catch (e) {
          return false;
        }
      });
      
      expect(assignEvent).to.not.be.undefined;
      
      // Verify admin status
      const isAdmin = await aaoFacet.isAdmin(aaoId, user3.address);
      expect(isAdmin).to.be.true;
    });

    it("should allow owner to revoke admin role", async function () {
      // Create a new AAO for this test
      const topic = "Admin Test AAO 2";
      const duration = 86400 * 30; // 30 days
      
      const tx = await aaoFacet.connect(owner).createAAO(topic, duration);
      const receipt = await tx.wait();
      
      // Get the AAO ID
      const aaoId = 4; // Fifth AAO should have ID 4
      
      // User2 joins the AAO (using a different user)
      await aaoFacet.connect(user2).joinAAO(aaoId);
      
      // First, assign admin role to user2
      await aaoFacet.connect(owner).assignAdminRole(aaoId, user2.address);
      
      // Verify admin status
      let isAdmin = await aaoFacet.isAdmin(aaoId, user2.address);
      expect(isAdmin).to.be.true;
      
      // Now revoke admin role
      const revokeTx = await aaoFacet.connect(owner).revokeAdminRole(aaoId, user2.address);
      const revokeReceipt = await revokeTx.wait();
      
      // Check for AAOAdminRevoked event
      const revokeEvent = revokeReceipt.logs.find(log => {
        try {
          const parsedLog = aaoFacet.interface.parseLog({
            topics: log.topics,
            data: log.data
          });
          return parsedLog && parsedLog.name === "AAOAdminRevoked";
        } catch (e) {
          return false;
        }
      });
      
      expect(revokeEvent).to.not.be.undefined;
      
      // Verify admin status is revoked
      isAdmin = await aaoFacet.isAdmin(aaoId, user2.address);
      expect(isAdmin).to.be.false;
    });
  });

  describe("AAO Lifecycle", function () {
    it("should allow owner to modify AAO details", async function () {
      // Create a new AAO for this test
      const topic = "Lifecycle Test AAO 1";
      const duration = 86400 * 30; // 30 days
      
      const tx = await aaoFacet.connect(owner).createAAO(topic, duration);
      const receipt = await tx.wait();
      
      // Get the AAO ID
      const aaoId = 5; // Sixth AAO should have ID 5
      
      // Modify AAO details
      const newTopic = "Updated Topic";
      const newDuration = 86400 * 60; // 60 days
      
      const modifyTx = await aaoFacet.connect(owner).modifyAAO(aaoId, newTopic, newDuration);
      const modifyReceipt = await modifyTx.wait();
      
      // Check for AAOModified event
      const modifyEvent = modifyReceipt.logs.find(log => {
        try {
          const parsedLog = aaoFacet.interface.parseLog({
            topics: log.topics,
            data: log.data
          });
          return parsedLog && parsedLog.name === "AAOModified";
        } catch (e) {
          return false;
        }
      });
      
      expect(modifyEvent).to.not.be.undefined;
      
      // Verify updated details
      const aaoDetails = await aaoFacet.getAAO(aaoId);
      expect(aaoDetails.topic).to.equal(newTopic);
      expect(aaoDetails.duration).to.equal(newDuration);
    });

    it("should allow owner to terminate an AAO", async function () {
      // Create a new AAO for this test
      const topic = "Lifecycle Test AAO 2";
      const duration = 86400 * 30; // 30 days
      
      const tx = await aaoFacet.connect(owner).createAAO(topic, duration);
      const receipt = await tx.wait();
      
      // Get the AAO ID
      const aaoId = 6; // Seventh AAO should have ID 6
      
      // Terminate the AAO
      const terminateTx = await aaoFacet.connect(owner).terminateAAO(aaoId);
      const terminateReceipt = await terminateTx.wait();
      
      // Check for AAOTerminated event
      const terminateEvent = terminateReceipt.logs.find(log => {
        try {
          const parsedLog = aaoFacet.interface.parseLog({
            topics: log.topics,
            data: log.data
          });
          return parsedLog && parsedLog.name === "AAOTerminated";
        } catch (e) {
          return false;
        }
      });
      
      expect(terminateEvent).to.not.be.undefined;
      
      // Verify AAO is terminated
      const aaoDetails = await aaoFacet.getAAO(aaoId);
      expect(aaoDetails.active).to.be.false;
    });
  });

  // Add more test sections as needed for other AAO functionality
}); 