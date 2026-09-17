// Creates the "trilogy widget" AAO on the local chain (spec section 24, WP17d) and prints its id.
const { ethers } = require("hardhat");
const DIAMOND = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
async function main() {
  const [deployer] = await ethers.getSigners();
  const AAOFacet = await ethers.getContractAt("AAOFacet", DIAMOND);
  const existing = await AAOFacet.getAAOsByCreator(deployer.address);
  for (const id of existing) {
    const a = await AAOFacet.getAAO(id);
    if (a.topic === "trilogy widget") { console.log("AAO already exists:", ethers.toNumber(id)); return; }
  }
  const tx = await AAOFacet.createAAO("trilogy widget", 10 * 365 * 24 * 3600);
  const receipt = await tx.wait();
  const ev = receipt.logs.find(l => l.topics[0] === ethers.id("AAOCreated(uint256,string,address,uint256)"));
  const aaoId = ev ? ethers.toNumber(ev.topics[1]) : null;
  console.log("AAO created:", aaoId, "creator:", deployer.address, "diamond:", DIAMOND);
  const a = await AAOFacet.getAAO(aaoId);
  console.log("topic:", a.topic, "| members:", a.members ? a.members.length : "?");
}
main().catch(e => { console.error(e); process.exit(1); });
