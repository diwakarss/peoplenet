const { ethers } = require("hardhat");
const DIAMOND = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
async function main() {
  const A = await ethers.getContractAt("AAOFacet", DIAMOND);
  for (let i = 0; i < 64; i++) {
    try { const p = await A.getProposal(i); const t = p.proposalText || p.text || p[2] || ""; if (!t) break; console.log(i, "|", String(t).slice(0, 70), "| executed:", p.executed ?? p[5]); } catch (e) { break; }
  }
}
main();
