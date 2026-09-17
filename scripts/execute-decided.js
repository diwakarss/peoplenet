// Executes every Active proposal on AAO 0 whose tally is decisive (27.9
// auto-execute, applied to votes cast before the page did it itself).
//
// Rehearses by default and sends only with --send. This one closes several
// proposals in a row, so a mistaken run is several mistakes at once.
//
// Usage:
//   IDS=16,17,18 node scripts/execute-decided.js            # rehearse
//   IDS=16,17,18 node scripts/execute-decided.js --send     # do it
process.env.HARDHAT_NETWORK = process.env.HARDHAT_NETWORK || "localhost";

const { ethers } = require("hardhat");
const R = require("../governance/read.js");

async function main() {
  const dryRun = !R.wantsSend(process.argv);
  const [director] = await ethers.getSigners();
  const A = await ethers.getContractAt("AAOFacet", R.DIAMOND);

  const ids = (process.env.IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) {
    console.error("execute-decided: set IDS to the proposal ids, comma separated.");
    console.error("  IDS=16,17 node scripts/execute-decided.js [--send]");
    process.exit(1);
  }

  let would = 0;
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 0) { console.log(raw, "skip: not a proposal id"); continue; }

    const p = await A.getProposal(id);

    // The same guard every other path uses: an id nobody filed reads back as a
    // zero struct whose status is Active, and executing it would write a status
    // onto a proposal that does not exist.
    const problem = R.voteTargetProblem(id, p);
    if (problem) { console.log(id, "skip:", problem.split(".")[0]); continue; }

    if (Number(p.status) !== 0) {
      console.log(id, "skip: already", R.STATUS[Number(p.status)]);
      continue;
    }
    if (Number(p.aaoId) !== R.AAO_ID) { console.log(id, "skip: not on AAO", R.AAO_ID); continue; }
    if (Number(p.forVotes) === Number(p.againstVotes)) {
      console.log(id, "skip: level tally, the casting vote decides it");
      continue;
    }

    const passes = Number(p.forVotes) > Number(p.againstVotes);
    would++;

    if (dryRun) {
      console.log(
        `${id} would execute -> ${passes ? "Executed" : "Rejected"} ` +
        `(for=${p.forVotes} against=${p.againstVotes})`
      );
      continue;
    }

    const tx = await A.connect(director).executeProposal(id);
    const receipt = await tx.wait();
    const q = await A.getProposal(id);
    console.log(
      `${id} executed -> ${R.STATUS[Number(q.status)]} ` +
      `(for=${p.forVotes} against=${p.againstVotes}) block ${receipt.blockNumber}`
    );
  }

  if (dryRun) {
    console.log("");
    console.log(`${would} proposal(s) would be closed for good.`);
    console.log(R.sendHint(`IDS=${ids.join(",")} node scripts/execute-decided.js`));
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
