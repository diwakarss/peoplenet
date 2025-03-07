const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("DiamondController", function () {
  let diamondCutFacet;
  let diamondController;
  let libAAO;
  let diamondLoupeFacet;
  let aaoFacet;
  let owner;
  let user1;

  before(async function () {
    [owner, user1] = await ethers.getSigners();

    // Deploy DiamondCutFacet
    const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
    diamondCutFacet = await DiamondCutFacet.deploy();

    // Deploy LibAAO
    const LibAAO = await ethers.getContractFactory("LibAAO");
    libAAO = await LibAAO.deploy();

    // Deploy DiamondLoupeFacet
    const DiamondLoupeFacet = await ethers.getContractFactory("DiamondLoupeFacet");
    diamondLoupeFacet = await DiamondLoupeFacet.deploy();

    // Deploy AAOFacet
    const AAOFacet = await ethers.getContractFactory("AAOFacet");
    aaoFacet = await AAOFacet.deploy();
    
    // Deploy DiamondController with DiamondCutFacet
    const DiamondController = await ethers.getContractFactory("DiamondController");
    const diamondCutFacetAddress = await diamondCutFacet.getAddress();
    diamondController = await DiamondController.deploy(owner.address, diamondCutFacetAddress);
    
    // Get facet cut action and function selectors
    const FacetCutAction = {
      Add: 0,
      Replace: 1,
      Remove: 2
    };
    
    // Add DiamondLoupeFacet to diamond
    const diamondLoupeFacetAddress = await diamondLoupeFacet.getAddress();
    const diamondLoupeSelectors = getFunctionSelectors(diamondLoupeFacet);
    
    // Add AAOFacet to diamond
    const aaoFacetAddress = await aaoFacet.getAddress();
    const aaoFacetSelectors = getFunctionSelectors(aaoFacet);
    
    // Get DiamondCut interface to call it
    const diamondCut = await ethers.getContractAt("IDiamondCut", await diamondController.getAddress());
    
    // Add facets to diamond
    await diamondCut.diamondCut(
      [
        {
          facetAddress: diamondLoupeFacetAddress,
          action: FacetCutAction.Add,
          functionSelectors: diamondLoupeSelectors
        },
        {
          facetAddress: aaoFacetAddress,
          action: FacetCutAction.Add,
          functionSelectors: aaoFacetSelectors
        }
      ],
      ethers.ZeroAddress, // No initialization
      "0x" // No initialization data
    );
  });

  describe("Contract Deployment", function() {
    it("Should deploy DiamondCutFacet", async function () {
      expect(await diamondCutFacet.getAddress()).to.be.properAddress;
    });

    it("Should deploy DiamondController", async function () {
      expect(await diamondController.getAddress()).to.be.properAddress;
    });

    it("Should deploy LibAAO", async function () {
      expect(await libAAO.getAddress()).to.be.properAddress;
    });

    it("Should deploy DiamondLoupeFacet", async function () {
      expect(await diamondLoupeFacet.getAddress()).to.be.properAddress;
    });

    it("Should deploy AAOFacet", async function () {
      expect(await aaoFacet.getAddress()).to.be.properAddress;
    });
  });
  
  describe("AAO Functionality", function() {
    it("Should create an AAO", async function () {
      // Get AAOFacet interface from the diamond
      const aaoFacetOnDiamond = await ethers.getContractAt("AAOFacet", await diamondController.getAddress(), owner);
      
      // Create AAO parameters
      const topic = "Test AAO";
      const duration = 86400; // 1 day in seconds
      
      // Create AAO
      const tx = await aaoFacetOnDiamond.createAAO(topic, duration);
      const receipt = await tx.wait();
      
      // Check for AAOCreated event
      const event = receipt.logs.find(log => {
        try {
          const parsedLog = aaoFacetOnDiamond.interface.parseLog({
            topics: log.topics,
            data: log.data
          });
          return parsedLog && parsedLog.name === "AAOCreated";
        } catch (e) {
          return false;
        }
      });
      
      expect(event).to.not.be.undefined;
      
      // Get AAO details
      const aaoId = 0; // First AAO should have ID 0
      const aaoDetails = await aaoFacetOnDiamond.getAAO(aaoId);
      
      expect(aaoDetails.topic).to.equal(topic);
      expect(aaoDetails.owner).to.equal(owner.address);
      expect(aaoDetails.duration).to.equal(duration);
    });

    it("Should allow a user to join an AAO", async function () {
      // Get AAOFacet interface from the diamond
      const aaoFacetOnDiamond = await ethers.getContractAt("AAOFacet", await diamondController.getAddress());
      
      // User1 joins the AAO
      const aaoId = 0;
      const tx = await aaoFacetOnDiamond.connect(user1).joinAAO(aaoId);
      const receipt = await tx.wait();
      
      // Check for AAOMemberJoined event
      const event = receipt.logs.find(log => {
        try {
          const parsedLog = aaoFacetOnDiamond.interface.parseLog({
            topics: log.topics,
            data: log.data
          });
          return parsedLog && parsedLog.name === "AAOMemberJoined";
        } catch (e) {
          return false;
        }
      });
      
      expect(event).to.not.be.undefined;
      
      // Check if user1 is a member
      const isMember = await aaoFacetOnDiamond.isMember(aaoId, user1.address);
      expect(isMember).to.be.true;
    });
  });
});

// Helper function to get function selectors from a contract
function getFunctionSelectors(contract) {
  const signatures = Object.keys(contract.interface.fragments)
    .filter(key => contract.interface.fragments[key].type === 'function')
    .map(key => contract.interface.fragments[key].format());
  
  return signatures.map(signature => contract.interface.getFunction(signature).selector);
} 