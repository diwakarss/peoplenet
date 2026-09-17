// A full read of every AAO and every proposal, written to a JSON file.
//
// Used either side of a diamondCut: cut the facet, snapshot again, diff. A
// facet swap must not move a single byte of state, and the only way to say that
// with a straight face is to have read it before and after.
//
// Usage:
//   node scripts/snapshot-chain-state.js <out.json> [--max 64]
process.env.HARDHAT_NETWORK = process.env.HARDHAT_NETWORK || "localhost";

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const R = require("../governance/read.js");

async function main() {
  const rest = process.argv.slice(2);
  const out = rest.filter((a) => !a.startsWith("--"))[0];
  if (!out) {
    console.error("  node scripts/snapshot-chain-state.js <out.json> [--max 64]");
    process.exit(1);
  }
  const maxIndex = rest.indexOf("--max");
  const max = maxIndex >= 0 ? Number(rest[maxIndex + 1]) : 64;

  const aaoFacet = await ethers.getContractAt("AAOFacet", R.DIAMOND);
  const count = Number(await aaoFacet.aaoCount());

  const aaos = [];
  for (let id = 0; id < count; id++) {
    const a = await aaoFacet.getAAO(id);
    aaos.push({
      id,
      topic: a.topic,
      duration: a.duration.toString(),
      owner: a.owner,
      active: a.active,
      isMacro: a.isMacro,
      members: (a.members || []).slice(),
      macroAAOId: a.macroAAOId.toString()
    });
  }

  // The facet has no proposalCount getter, so read a fixed range and keep the
  // ones that exist. An unfiled id is recorded as such, on purpose: the guard
  // must not change what an unfiled id reads back as.
  const proposals = [];
  for (let id = 0; id < max; id++) {
    const p = await aaoFacet.getProposal(id);
    proposals.push({
      id,
      exists: String(p.text || "").length > 0,
      aaoId: p.aaoId.toString(),
      proposer: p.proposer,
      text: p.text,
      forVotes: p.forVotes.toString(),
      againstVotes: p.againstVotes.toString(),
      status: p.status.toString(),
      createdAt: p.createdAt.toString()
    });
  }

  const snapshot = {
    diamond: R.DIAMOND,
    blockNumber: await ethers.provider.getBlockNumber(),
    aaoCount: count,
    aaos,
    proposals
  };

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 1) + "\n", "utf8");

  const filed = proposals.filter((p) => p.exists).length;
  console.log(`snapshot at block ${snapshot.blockNumber}: ${count} AAO(s), ${filed} filed proposal(s) of ${max} ids read`);
  console.log(`written to ${out}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
