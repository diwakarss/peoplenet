// Executes every Active proposal on AAO 0 whose tally is decisive and carries the Director's vote (27.9 auto-execute, applied to votes cast before the page did it itself).
const { ethers } = require("hardhat");
const DIAMOND = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
async function main() {
  const [director] = await ethers.getSigners();
  const A = await ethers.getContractAt("AAOFacet", DIAMOND);
  const ids = (process.env.IDS || "").split(",").map(s => s.trim()).filter(Boolean);
  for (const id of ids) {
    const p = await A.getProposal(id);
    if (Number(p.status) !== 0) { console.log(id, "skip: not active"); continue; }
    if (Number(p.aaoId) !== 0) { console.log(id, "skip: not AAO 0"); continue; }
    const voted = await A.hasVoted ? null : null;
    if (p.forVotes === p.againstVotes) { console.log(id, "skip: level tally"); continue; }
    const tx = await A.connect(director).executeProposal(id); await tx.wait();
    const q = await A.getProposal(id);
    console.log(id, "executed ->", ["Active", "Executed", "Rejected", "Cancelled"][Number(q.status)], `for=${p.forVotes} against=${p.againstVotes}`);
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
