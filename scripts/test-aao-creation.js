const { ethers } = require("hardhat");

async function main() {
  console.log("Testing AAO creation...");
  
  // Get the signer
  const [signer] = await ethers.getSigners();
  console.log("Using account:", signer.address);
  
  // Get the contract addresses
  const diamondAddress = "0x202CCe504e04bEd6fC0521238dDf04Bc9E8E15aB";
  const macroFactoryAddress = "0xC9a43158891282A2B1475592D5719c001986Aaec";
  const microFactoryAddress = "0x1c85638e118b37167e9298c2268758e058DdfDA0";
  
  // Get the AAOFacet contract
  const AAOFacet = await ethers.getContractAt("AAOFacet", diamondAddress);
  
  // Check if the factory is approved
  const isMacroFactoryApproved = await AAOFacet.approvedFactories(macroFactoryAddress);
  console.log("Is MacroFactory approved?", isMacroFactoryApproved);
  
  const isMicroFactoryApproved = await AAOFacet.approvedFactories(microFactoryAddress);
  console.log("Is MicroFactory approved?", isMicroFactoryApproved);
  
  // If not approved, approve them
  if (!isMacroFactoryApproved) {
    console.log("Approving MacroFactory...");
    const tx1 = await AAOFacet.addApprovedFactory(macroFactoryAddress);
    await tx1.wait();
    console.log("MacroFactory approved");
  }
  
  if (!isMicroFactoryApproved) {
    console.log("Approving MicroFactory...");
    const tx2 = await AAOFacet.addApprovedFactory(microFactoryAddress);
    await tx2.wait();
    console.log("MicroFactory approved");
  }
  
  // Get the MacroAAOFactory contract
  const MacroAAOFactory = await ethers.getContractAt("MacroAAOFactory", macroFactoryAddress);
  
  // Create a Macro AAO
  console.log("Creating Macro AAO...");
  const topic = "Test Macro AAO";
  const duration = 86400 * 30; // 30 days
  
  try {
    const tx = await MacroAAOFactory.createMacroAAO(topic, duration);
    const receipt = await tx.wait();
    console.log("Transaction receipt:", receipt);
    
    // Get the AAO ID from the event
    const event = receipt.logs.find(log => {
      try {
        const parsedLog = MacroAAOFactory.interface.parseLog(log);
        return parsedLog && parsedLog.name === "MacroAAOCreated";
      } catch (e) {
        return false;
      }
    });
    
    if (event) {
      const parsedEvent = MacroAAOFactory.interface.parseLog(event);
      const aaoId = parsedEvent.args.aaoId;
      console.log("Macro AAO created with ID:", aaoId);
      
      // Get the AAO details
      const aao = await AAOFacet.getAAO(aaoId);
      console.log("AAO details:", aao);
    } else {
      console.log("Could not find MacroAAOCreated event in logs");
    }
  } catch (error) {
    console.error("Error creating Macro AAO:", error);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  }); 