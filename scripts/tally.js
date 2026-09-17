const { ethers } = require("hardhat");
const DIAMOND = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const ST = ["Active", "Executed", "Rejected", "Cancelled"];
async function main() {
  const A = await ethers.getContractAt("AAOFacet", DIAMOND);
  for (let i = 0; i < 64; i++) {
    let p; try { p = await A.getProposal(i); } catch (e) { break; }
    const t = String(p.text || p[3] || ""); if (!t || t.startsWith("0x000")) break;
    let title = t.slice(0, 60); try { const d = JSON.parse(t); title = d.title || title; } catch (e) {}
    console.log(`${i}\taao=${p.aaoId}\tfor=${p.forVotes}\tagainst=${p.againstVotes}\t${ST[Number(p.status)] || p.status}\t${title}`);
  }
}
main();
