const { ethers } = require("hardhat");

async function main() {
  console.log("Creating test AAO...");
  
  // Get the signer
  const [deployer] = await ethers.getSigners();
  console.log("Using account:", deployer.address);
  
  // Get the MacroAAOFactory contract
  const macroFactoryAddress = "0x610178dA211FEF7D417bC0e6FeD39F05609AD788";
  const MacroAAOFactory = await ethers.getContractAt("MacroAAOFactory", macroFactoryAddress);
  
  // Create a test Macro AAO
  const topic = "Test Macro AAO";
  const duration = 31536000; // 1 year in seconds
  
  console.log("Creating Macro AAO with topic:", topic);
  const tx = await MacroAAOFactory.createMacroAAO(topic, duration);
  const receipt = await tx.wait();
  
  // Get the AAO ID from the event logs
  const aaoCreatedEvent = receipt.logs.find(
    log => log.topics[0] === ethers.id("AAOCreated(uint256,string,address,uint256)")
  );
  
  if (aaoCreatedEvent) {
    const aaoId = ethers.toNumber(aaoCreatedEvent.topics[1]);
    console.log("Macro AAO created with ID:", aaoId);
    
    // Get the AAOFacet contract
    const diamondAddress = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
    const AAOFacet = await ethers.getContractAt("AAOFacet", diamondAddress);
    
    // Get the AAO details
    const aao = await AAOFacet.getAAO(aaoId);
    console.log("AAO Details:", {
      id: aaoId,
      topic: aao.topic,
      owner: aao.owner,
      duration: ethers.toNumber(aao.duration),
      active: aao.active,
      isMacro: aao.isMacro
    });
    
    // Create a test Micro AAO
    const microFactoryAddress = "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e";
    const MicroAAOFactory = await ethers.getContractAt("MicroAAOFactory", microFactoryAddress);
    
    const microTopic = "Test Micro AAO";
    const microDuration = 15768000; // 6 months in seconds
    
    console.log("Creating Micro AAO with topic:", microTopic);
    const microTx = await MicroAAOFactory.createMicroAAO(microTopic, microDuration, aaoId);
    const microReceipt = await microTx.wait();
    
    // Get the Micro AAO ID from the event logs
    const microAaoCreatedEvent = microReceipt.logs.find(
      log => log.topics[0] === ethers.id("AAOCreated(uint256,string,address,uint256)")
    );
    
    if (microAaoCreatedEvent) {
      const microAaoId = ethers.toNumber(microAaoCreatedEvent.topics[1]);
      console.log("Micro AAO created with ID:", microAaoId);
      
      // Get the Micro AAO details
      const microAao = await AAOFacet.getAAO(microAaoId);
      console.log("Micro AAO Details:", {
        id: microAaoId,
        topic: microAao.topic,
        owner: microAao.owner,
        duration: ethers.toNumber(microAao.duration),
        active: microAao.active,
        isMacro: microAao.isMacro,
        macroAAOId: await AAOFacet.getMacroAAOId(microAaoId)
      });
    } else {
      console.log("Failed to create Micro AAO");
    }
  } else {
    console.log("Failed to create Macro AAO");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  }); 