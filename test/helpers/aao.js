const { ethers } = require("hardhat");

// Helper function to deploy the AAO infrastructure
async function deployAAOInfrastructure() {
  const [owner] = await ethers.getSigners();

  // Deploy DiamondCutFacet
  const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
  const diamondCutFacet = await DiamondCutFacet.deploy();
  await diamondCutFacet.deployed();

  // Deploy Diamond
  const Diamond = await ethers.getContractFactory("DiamondController");
  const diamond = await Diamond.deploy(owner.address, diamondCutFacet.address);
  await diamond.deployed();

  // Deploy DiamondLoupeFacet
  const DiamondLoupeFacet = await ethers.getContractFactory("DiamondLoupeFacet");
  const diamondLoupeFacet = await DiamondLoupeFacet.deploy();
  await diamondLoupeFacet.deployed();

  // Deploy LibAAO
  const LibAAO = await ethers.getContractFactory("LibAAO");
  const libAAO = await LibAAO.deploy();
  await libAAO.deployed();

  // Deploy AAOFacet
  const AAOFacet = await ethers.getContractFactory("AAOFacet", {
    libraries: {
      LibAAO: libAAO.address,
    },
  });
  const aaoFacet = await AAOFacet.deploy();
  await aaoFacet.deployed();

  // Get selectors
  const getSelectors = (contract) => {
    const signatures = Object.keys(contract.interface.functions);
    const selectors = signatures.reduce((acc, signature) => {
      if (signature !== "init(bytes)") {
        acc.push(contract.interface.getSighash(signature));
      }
      return acc;
    }, []);
    return selectors;
  };

  // Add DiamondLoupeFacet and AAOFacet to Diamond
  const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };
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
  const diamondLoupeFacetInstance = await ethers.getContractAt("DiamondLoupeFacet", diamond.address);
  const aaoFacetInstance = await ethers.getContractAt("AAOFacet", diamond.address);

  // Deploy MacroAAOFactory
  const MacroAAOFactory = await ethers.getContractFactory("MacroAAOFactory");
  const macroAAOFactory = await MacroAAOFactory.deploy(diamond.address);
  await macroAAOFactory.deployed();

  // Deploy MacroAAOManager
  const MacroAAOManager = await ethers.getContractFactory("MacroAAOManager");
  const macroAAOManager = await MacroAAOManager.deploy(diamond.address);
  await macroAAOManager.deployed();

  // Deploy MicroAAOFactory
  const MicroAAOFactory = await ethers.getContractFactory("MicroAAOFactory");
  const microAAOFactory = await MicroAAOFactory.deploy(diamond.address, macroAAOFactory.address);
  await microAAOFactory.deployed();

  // Deploy MicroAAOManager
  const MicroAAOManager = await ethers.getContractFactory("MicroAAOManager");
  const microAAOManager = await MicroAAOManager.deploy(diamond.address, macroAAOManager.address);
  await microAAOManager.deployed();

  return {
    diamond,
    diamondCutFacet,
    diamondLoupeFacet: diamondLoupeFacetInstance,
    aaoFacet: aaoFacetInstance,
    libAAO,
    macroAAOFactory,
    macroAAOManager,
    microAAOFactory,
    microAAOManager,
  };
}

// Helper function to create a Macro AAO
async function createMacroAAO(macroAAOFactory, topic, duration) {
  const tx = await macroAAOFactory.createMacroAAO(topic, duration);
  const receipt = await tx.wait();
  
  const aaoCreatedEvent = receipt.events.find(
    (e) => e.event === "AAOCreated"
  );
  
  return {
    aaoId: aaoCreatedEvent.args.aaoId,
    creator: aaoCreatedEvent.args.creator,
    topic: aaoCreatedEvent.args.topic,
    isMacro: aaoCreatedEvent.args.isMacro,
    tx,
    receipt
  };
}

// Helper function to create a Micro AAO
async function createMicroAAO(microAAOFactory, topic, duration, macroId) {
  const tx = await microAAOFactory.createMicroAAO(topic, duration, macroId);
  const receipt = await tx.wait();
  
  const aaoCreatedEvent = receipt.events.find(
    (e) => e.event === "AAOCreated"
  );
  
  return {
    aaoId: aaoCreatedEvent.args.aaoId,
    creator: aaoCreatedEvent.args.creator,
    topic: aaoCreatedEvent.args.topic,
    isMacro: aaoCreatedEvent.args.isMacro,
    tx,
    receipt
  };
}

// Helper function to join an AAO
async function joinAAO(aaoFacet, aaoId, signer) {
  const tx = await aaoFacet.connect(signer).joinAAO(aaoId);
  const receipt = await tx.wait();
  
  return { tx, receipt };
}

// Helper function to leave an AAO
async function leaveAAO(aaoFacet, aaoId, signer) {
  const tx = await aaoFacet.connect(signer).leaveAAO(aaoId);
  const receipt = await tx.wait();
  
  return { tx, receipt };
}

// Helper function to assign admin role
async function assignAdminRole(aaoFacet, aaoId, adminAddress, signer) {
  const tx = await aaoFacet.connect(signer).assignAdminRole(aaoId, adminAddress);
  const receipt = await tx.wait();
  
  return { tx, receipt };
}

// Helper function to revoke admin role
async function revokeAdminRole(aaoFacet, aaoId, adminAddress, signer) {
  const tx = await aaoFacet.connect(signer).revokeAdminRole(aaoId, adminAddress);
  const receipt = await tx.wait();
  
  return { tx, receipt };
}

module.exports = {
  deployAAOInfrastructure,
  createMacroAAO,
  createMicroAAO,
  joinAAO,
  leaveAAO,
  assignAdminRole,
  revokeAdminRole
}; 