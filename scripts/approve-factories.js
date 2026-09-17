const { ethers } = require("hardhat");

async function main() {
  console.log("Approving factory contracts...");

  // Get the contract addresses from the deployment
  const diamondAddress = "0x36C02dA8a0983159322a80FFE9F24b1acfF8B570";
  const macroFactoryAddress = "0x7969c5eD335650692Bc04293B07F5BF2e7A673C0";
  const microFactoryAddress = "0x7bc06c482DEAd17c0e297aFbC32f6e63d3846650";

  // Get the signer
  const [deployer] = await ethers.getSigners();
  console.log("Using account:", deployer.address);

  // Get the AAOFacet contract
  const AAOFacet = await ethers.getContractAt("AAOFacet", diamondAddress);

  // Approve the MacroAAOFactory
  console.log("Approving MacroAAOFactory...");
  const tx1 = await AAOFacet.addApprovedFactory(macroFactoryAddress);
  await tx1.wait();
  console.log("MacroAAOFactory approved");

  // Approve the MicroAAOFactory
  console.log("Approving MicroAAOFactory...");
  const tx2 = await AAOFacet.addApprovedFactory(microFactoryAddress);
  await tx2.wait();
  console.log("MicroAAOFactory approved");

  console.log("All factories approved successfully");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  }); 