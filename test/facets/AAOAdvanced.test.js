const { expect } = require("chai");
const { ethers } = require("hardhat");
const { getSelectors, FacetCutAction } = require("../helpers/diamond");
const TokenHelper = require("../helpers/token");

describe("AAO Advanced Functionality", function () {
  let aaoFacet;
  let tokenFacet;
  let mockToken;
  let owner;
  let user1;
  let user2;
  let user3;
  let macroAAOId;
  let microAAOId;
  let proposalId;

  before(async function () {
    // Get signers
    [owner, user1, user2, user3] = await ethers.getSigners();

    // Deploy a simple test environment
    // Deploy DiamondCutFacet
    const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
    const diamondCutFacet = await DiamondCutFacet.deploy();

    // Deploy Diamond
    const Diamond = await ethers.getContractFactory("DiamondController");
    const diamondCutFacetAddress = await diamondCutFacet.getAddress();
    const diamond = await Diamond.deploy(owner.address, diamondCutFacetAddress);

    // Deploy AAOFacet
    const AAOFacet = await ethers.getContractFactory("AAOFacet");
    const aaoFacetContract = await AAOFacet.deploy();

    // Deploy TokenFacet
    const TokenFacet = await ethers.getContractFactory("TokenFacet");
    const tokenFacetContract = await TokenFacet.deploy();

    // Deploy mock token
    mockToken = await TokenHelper.deployMockToken("Mock Token", "MOCK");

    // Get DiamondCut interface to call it
    const diamondCut = await ethers.getContractAt("IDiamondCut", await diamond.getAddress());
    
    // Add AAOFacet to Diamond
    const aaoFacetAddress = await aaoFacetContract.getAddress();
    
    await diamondCut.diamondCut(
      [
        {
          facetAddress: aaoFacetAddress,
          action: FacetCutAction.Add,
          functionSelectors: getSelectors(aaoFacetContract)
        }
      ],
      ethers.ZeroAddress, // No initialization
      "0x" // No initialization data
    );

    // Add TokenFacet to Diamond
    const tokenFacetAddress = await tokenFacetContract.getAddress();
    
    await diamondCut.diamondCut(
      [
        {
          facetAddress: tokenFacetAddress,
          action: FacetCutAction.Add,
          functionSelectors: getSelectors(tokenFacetContract)
        }
      ],
      ethers.ZeroAddress, // No initialization
      "0x" // No initialization data
    );

    // Get facet instances
    aaoFacet = await ethers.getContractAt("AAOFacet", await diamond.getAddress());
    tokenFacet = await ethers.getContractAt("TokenFacet", await diamond.getAddress());

    // Create a Macro AAO for testing
    const macroTopic = "Test Macro AAO";
    const macroDuration = 86400 * 30; // 30 days
    
    const macroTx = await aaoFacet.connect(owner).createAAO(macroTopic, macroDuration);
    const macroReceipt = await macroTx.wait();
    
    // Get the Macro AAO ID
    macroAAOId = 0; // First AAO should have ID 0
    
    // Add users to the Macro AAO
    await aaoFacet.connect(user1).joinAAO(macroAAOId);
    await aaoFacet.connect(user2).joinAAO(macroAAOId);
    await aaoFacet.connect(user3).joinAAO(macroAAOId);

    // Create a Micro AAO
    const microTopic = "Test Micro AAO";
    const microDuration = 86400 * 7; // 7 days
    
    const microTx = await aaoFacet.connect(owner).createAAO(microTopic, microDuration);
    const microReceipt = await microTx.wait();
    
    // Get the Micro AAO ID
    microAAOId = 1; // Second AAO should have ID 1

    // Register the token
    const mockTokenAddress = await mockToken.getAddress();
    await tokenFacet.connect(owner).registerToken(mockTokenAddress, "Mock Token", "MOCK");
  });

  describe("Proposal Creation and Voting", function() {
    it("should allow a member to submit a proposal", async function() {
      const proposalText = "Proposal to add a new feature";
      
      const tx = await aaoFacet.connect(user1).submitProposal(macroAAOId, proposalText);
      const receipt = await tx.wait();
      
      // Check for ProposalSubmitted event
      const event = receipt.logs.find(log => {
        try {
          const parsedLog = aaoFacet.interface.parseLog({
            topics: log.topics,
            data: log.data
          });
          return parsedLog && parsedLog.name === "ProposalSubmitted";
        } catch (e) {
          return false;
        }
      });
      
      expect(event).to.not.be.undefined;
      
      // Get the proposal ID from the event
      proposalId = 0; // First proposal should have ID 0
      
      // Get proposal details
      const proposal = await aaoFacet.getProposal(proposalId);
      
      expect(proposal.text).to.equal(proposalText);
      expect(proposal.proposer).to.equal(user1.address);
      expect(proposal.aaoId).to.equal(macroAAOId);
      expect(proposal.status).to.equal(0); // Active
      expect(proposal.forVotes).to.equal(0);
      expect(proposal.againstVotes).to.equal(0);
    });

    it("should allow members to vote on a proposal", async function() {
      // User1 votes for the proposal
      const voteTx1 = await aaoFacet.connect(user1).vote(proposalId, true);
      const voteReceipt1 = await voteTx1.wait();
      
      // Check for VoteCast event
      const event1 = voteReceipt1.logs.find(log => {
        try {
          const parsedLog = aaoFacet.interface.parseLog({
            topics: log.topics,
            data: log.data
          });
          return parsedLog && parsedLog.name === "VoteCast";
        } catch (e) {
          return false;
        }
      });
      
      expect(event1).to.not.be.undefined;
      
      // User2 votes against the proposal
      const voteTx2 = await aaoFacet.connect(user2).vote(proposalId, false);
      await voteTx2.wait();
      
      // User3 votes for the proposal
      const voteTx3 = await aaoFacet.connect(user3).vote(proposalId, true);
      await voteTx3.wait();
      
      // Get updated proposal details
      const proposal = await aaoFacet.getProposal(proposalId);
      
      expect(proposal.forVotes).to.equal(2);
      expect(proposal.againstVotes).to.equal(1);
    });

    it("should not allow a member to vote twice", async function() {
      // User1 tries to vote again
      await expect(
        aaoFacet.connect(user1).vote(proposalId, false)
      ).to.be.reverted; // Should revert with "Already voted"
    });

    it("should allow executing a proposal after voting", async function() {
      const executeTx = await aaoFacet.connect(user1).executeProposal(proposalId);
      const executeReceipt = await executeTx.wait();
      
      // Check for ProposalExecuted event
      const event = executeReceipt.logs.find(log => {
        try {
          const parsedLog = aaoFacet.interface.parseLog({
            topics: log.topics,
            data: log.data
          });
          return parsedLog && parsedLog.name === "ProposalExecuted";
        } catch (e) {
          return false;
        }
      });
      
      expect(event).to.not.be.undefined;
      
      // Get updated proposal details
      const proposal = await aaoFacet.getProposal(proposalId);
      
      expect(proposal.status).to.equal(1); // Executed
    });
  });

  describe("Admin Role Management", function() {
    it("should allow owner to assign admin role", async function() {
      // Owner assigns admin role to user1
      const assignTx = await aaoFacet.connect(owner).assignAdminRole(macroAAOId, user1.address);
      const assignReceipt = await assignTx.wait();
      
      // Check for AAOAdminAssigned event
      const event = assignReceipt.logs.find(log => {
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
      
      expect(event).to.not.be.undefined;
      
      // Verify admin status
      const isAdmin = await aaoFacet.isAdmin(macroAAOId, user1.address);
      expect(isAdmin).to.be.true;
    });

    it("should allow admin to perform admin actions", async function() {
      // Admin (user1) assigns admin role to user2
      const assignTx = await aaoFacet.connect(user1).assignAdminRole(macroAAOId, user2.address);
      const assignReceipt = await assignTx.wait();
      
      // Check for AAOAdminAssigned event
      const event = assignReceipt.logs.find(log => {
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
      
      expect(event).to.not.be.undefined;
      
      // Verify admin status
      const isAdmin = await aaoFacet.isAdmin(macroAAOId, user2.address);
      expect(isAdmin).to.be.true;
    });

    it("should allow owner to revoke admin role", async function() {
      // Owner revokes admin role from user2
      const revokeTx = await aaoFacet.connect(owner).revokeAdminRole(macroAAOId, user2.address);
      const revokeReceipt = await revokeTx.wait();
      
      // Check for AAOAdminRevoked event
      const event = revokeReceipt.logs.find(log => {
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
      
      expect(event).to.not.be.undefined;
      
      // Verify admin status is revoked
      const isAdmin = await aaoFacet.isAdmin(macroAAOId, user2.address);
      expect(isAdmin).to.be.false;
    });
  });

  describe("Micro AAO Management", function() {
    it("should allow members to join the Micro AAO", async function() {
      // User1 joins the Micro AAO
      const joinTx = await aaoFacet.connect(user1).joinAAO(microAAOId);
      const joinReceipt = await joinTx.wait();
      
      // Check for AAOMemberJoined event
      const event = joinReceipt.logs.find(log => {
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
      
      expect(event).to.not.be.undefined;
      
      // Verify membership
      const isMember = await aaoFacet.isMember(microAAOId, user1.address);
      expect(isMember).to.be.true;
    });

    it("should allow creating proposals in the Micro AAO", async function() {
      const proposalText = "Micro AAO Proposal";
      
      const tx = await aaoFacet.connect(user1).submitProposal(microAAOId, proposalText);
      const receipt = await tx.wait();
      
      // Check for ProposalSubmitted event
      const event = receipt.logs.find(log => {
        try {
          const parsedLog = aaoFacet.interface.parseLog({
            topics: log.topics,
            data: log.data
          });
          return parsedLog && parsedLog.name === "ProposalSubmitted";
        } catch (e) {
          return false;
        }
      });
      
      expect(event).to.not.be.undefined;
      
      // Get the proposal ID from the event
      const microProposalId = 1; // Second proposal should have ID 1
      
      // Get proposal details
      const proposal = await aaoFacet.getProposal(microProposalId);
      
      expect(proposal.text).to.equal(proposalText);
      expect(proposal.aaoId).to.equal(microAAOId);
    });
  });

  describe("Token Integration", function() {
    it("should verify token registration", async function() {
      const mockTokenAddress = await mockToken.getAddress();
      
      // Verify token is registered
      const isRegistered = await tokenFacet.isTokenRegistered(mockTokenAddress);
      expect(isRegistered).to.be.true;
      
      // Verify token details
      const tokenInfo = await tokenFacet.getTokenInfo(mockTokenAddress);
      expect(tokenInfo.name).to.equal("Mock Token");
      expect(tokenInfo.symbol).to.equal("MOCK");
    });

    it("should allow token operations in AAO context", async function() {
      // Create a proposal for token operations
      const proposalText = "Proposal to use Mock Token for AAO operations";
      
      const tx = await aaoFacet.connect(user1).submitProposal(macroAAOId, proposalText);
      const receipt = await tx.wait();
      
      // Get the proposal ID
      const tokenProposalId = 2; // Third proposal should have ID 2
      
      // Vote on the proposal
      await aaoFacet.connect(user1).vote(tokenProposalId, true);
      await aaoFacet.connect(user2).vote(tokenProposalId, true);
      
      // Execute the proposal
      await aaoFacet.connect(user1).executeProposal(tokenProposalId);
      
      // Verify the proposal was executed
      const proposal = await aaoFacet.getProposal(tokenProposalId);
      expect(proposal.status).to.equal(1); // Executed
    });
  });
}); 