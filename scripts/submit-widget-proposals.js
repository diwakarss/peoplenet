// Files the trilogy widget builder's suggestions as proposals on AAO 0 (spec section 25). Usage:
//   npx hardhat run scripts/submit-widget-proposals.js --network localhost   (reads proposals.json next to it)
const { ethers } = require("hardhat");
const fs = require("fs"); const path = require("path");
const DIAMOND = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
async function main() {
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, "proposals.json"), "utf8"));
  const AAOFacet = await ethers.getContractAt("AAOFacet", DIAMOND);
  for (const text of list) {
    const tx = await AAOFacet.submitProposal(0, text);
    const rc = await tx.wait();
    const ev = rc.logs.find(l => l.topics[0] === ethers.id("ProposalSubmitted(uint256,uint256,address,string)")) || rc.logs.find(l => l.topics.length > 1);
    const id = ev ? ethers.toNumber(ev.topics[1]) : "?";
    console.log("proposal", id, "|", text.slice(0, 90));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
