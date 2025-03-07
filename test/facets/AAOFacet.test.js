const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployDiamond } = require("../helpers/diamond");

describe("AAOFacet", function () {
  let diamondAddress;
  let aaoFacet;
  let owner;
  let user1;
  let user2;

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();
    
    // Deploy the diamond with AAOFacet
    diamondAddress = await deployDiamond();
    
    // Get the AAOFacet contract instance
    const AAOFacet = await ethers.getContractFactory("AAOFacet");
    aaoFacet = await AAOFacet.attach(diamondAddress);
  });

  describe("AAO Lifecycle", function () {
    it("Should create a new AAO", async function () {
      const topic = "Test AAO";
      const duration = 86400; // 1 day in seconds
      
      const tx = await aaoFacet.createAAO(topic, duration);
      const receipt = await tx.wait();
      
      // Find the AAOCreated event
      const event = receipt.events.find(e => e.event === "AAOCreated");
      expect(event).to.not.be.undefined;
      
      const aaoId = event.args.aaoId;
      
      // Verify the AAO was created correctly
      const aao = await aaoFacet.getAAO(aaoId);
      expect(aao.topic).to.equal(topic);
      expect(aao.owner).to.equal(owner.address);
      expect(aao.isActive).to.be.true;
    });
    
    it("Should modify an existing AAO", async function () {
      // Create an AAO first
      const tx = await aaoFacet.createAAO("Original Topic", 86400);
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "AAOCreated");
      const aaoId = event.args.aaoId;
      
      // Modify the AAO
      const newTopic = "Updated Topic";
      const newDuration = 172800; // 2 days in seconds
      await aaoFacet.modifyAAO(aaoId, newTopic, newDuration);
      
      // Verify the changes
      const aao = await aaoFacet.getAAO(aaoId);
      expect(aao.topic).to.equal(newTopic);
    });
    
    it("Should terminate an AAO", async function () {
      // Create an AAO first
      const tx = await aaoFacet.createAAO("Test AAO", 86400);
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "AAOCreated");
      const aaoId = event.args.aaoId;
      
      // Terminate the AAO
      await aaoFacet.terminateAAO(aaoId);
      
      // Verify the AAO is no longer active
      const aao = await aaoFacet.getAAO(aaoId);
      expect(aao.isActive).to.be.false;
    });
  });
  
  describe("Membership Management", function () {
    let aaoId;
    
    beforeEach(async function () {
      // Create an AAO for testing
      const tx = await aaoFacet.createAAO("Membership Test AAO", 86400);
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "AAOCreated");
      aaoId = event.args.aaoId;
    });
    
    it("Should allow users to join an AAO", async function () {
      // User1 joins the AAO
      await aaoFacet.connect(user1).joinAAO(aaoId);
      
      // Verify user1 is now a member
      expect(await aaoFacet.isMember(aaoId, user1.address)).to.be.true;
    });
    
    it("Should allow users to leave an AAO", async function () {
      // User1 joins and then leaves the AAO
      await aaoFacet.connect(user1).joinAAO(aaoId);
      await aaoFacet.connect(user1).leaveAAO(aaoId);
      
      // Verify user1 is no longer a member
      expect(await aaoFacet.isMember(aaoId, user1.address)).to.be.false;
    });
    
    it("Should allow assigning admin roles", async function () {
      // User1 joins the AAO
      await aaoFacet.connect(user1).joinAAO(aaoId);
      
      // Owner assigns admin role to user1
      await aaoFacet.assignAdminRole(aaoId, user1.address);
      
      // Verify user1 is now an admin
      expect(await aaoFacet.isAdmin(aaoId, user1.address)).to.be.true;
    });
  });
  
  describe("Governance", function () {
    let aaoId;
    
    beforeEach(async function () {
      // Create an AAO for testing
      const tx = await aaoFacet.createAAO("Governance Test AAO", 86400);
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "AAOCreated");
      aaoId = event.args.aaoId;
      
      // Add users as members
      await aaoFacet.connect(user1).joinAAO(aaoId);
      await aaoFacet.connect(user2).joinAAO(aaoId);
    });
    
    it("Should allow submitting and voting on proposals", async function () {
      // User1 submits a proposal
      const proposalText = "Test Proposal";
      const tx = await aaoFacet.connect(user1).submitProposal(aaoId, proposalText);
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "ProposalSubmitted");
      const proposalId = event.args.proposalId;
      
      // Users vote on the proposal
      await aaoFacet.connect(owner).vote(proposalId, true); // Yes vote
      await aaoFacet.connect(user2).vote(proposalId, true); // Yes vote
      
      // Verify the proposal state
      const proposal = await aaoFacet.getProposal(proposalId);
      expect(proposal.text).to.equal(proposalText);
      expect(proposal.yesVotes).to.equal(2);
      expect(proposal.noVotes).to.equal(0);
    });
  });
  
  describe("Task Management", function () {
    let aaoId;
    
    beforeEach(async function () {
      // Create an AAO for testing
      const tx = await aaoFacet.createAAO("Task Test AAO", 86400);
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "AAOCreated");
      aaoId = event.args.aaoId;
      
      // Add user1 as a member
      await aaoFacet.connect(user1).joinAAO(aaoId);
    });
    
    it("Should allow creating and assigning tasks", async function () {
      // Owner creates a bounty/task
      const taskDescription = "Test Task";
      const reward = ethers.utils.parseEther("1.0");
      const tx = await aaoFacet.createBounty(aaoId, taskDescription, reward);
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "BountyCreated");
      const taskId = event.args.taskId;
      
      // User1 assigns the task to themselves
      await aaoFacet.connect(user1).assignTask(taskId);
      
      // Verify the task state
      const task = await aaoFacet.getTask(taskId);
      expect(task.description).to.equal(taskDescription);
      expect(task.assignee).to.equal(user1.address);
      expect(task.status).to.equal(1); // Assigned status
    });
    
    it("Should allow completing and verifying tasks", async function () {
      // Create and assign a task
      const tx = await aaoFacet.createBounty(aaoId, "Complete Task Test", ethers.utils.parseEther("1.0"));
      const receipt = await tx.wait();
      const taskId = receipt.events.find(e => e.event === "BountyCreated").args.taskId;
      await aaoFacet.connect(user1).assignTask(taskId);
      
      // User1 completes the task
      await aaoFacet.connect(user1).completeTask(taskId);
      
      // Owner verifies the task
      await aaoFacet.verifyTask(taskId, true);
      
      // Verify the task state
      const task = await aaoFacet.getTask(taskId);
      expect(task.status).to.equal(3); // Completed status
    });
  });
}); 