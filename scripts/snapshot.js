// One snapshot of the chain, on disk, outside the repository (proposal 92).
//
// The record lives in one process's memory on one laptop until the move to the
// cloud, and a Windows sign-out destroyed it once. This runs the replay tool's
// export -- which only reads -- to a dated file, keeps the last 200, and
// refuses to write over a good snapshot with an export that holds less than it
// does.
//
//   node scripts/snapshot.js              # take one
//   node scripts/snapshot.js --list       # what is on disk
//
// PEOPLENET_SNAPSHOT_DIR overrides where they live. The default is
// peoplenet-snapshots under the user profile, and deliberately not the OS temp
// directory: that is a place the operating system empties.
process.env.HARDHAT_NETWORK = process.env.HARDHAT_NETWORK || "localhost";

const fs = require("fs");
const path = require("path");
const R = require("../governance/read.js");
const S = require("../governance/snapshots.js");
const Replay = require("./replay-chain.js");

// Takes the snapshot and returns what happened, rather than printing it: the
// watcher calls this and needs the answer, not the noise.
async function take(options) {
  const o = options || {};
  const ethers = o.ethers || require("hardhat").ethers;
  const dir = o.dir || S.directory();
  const diamond = o.diamond || R.DIAMOND;

  fs.mkdirSync(dir, { recursive: true });

  const contract = await ethers.getContractAt("AAOFacet", diamond);
  const data = await Replay.exportEvents(contract, ethers.provider, await ethers.getSigners());
  const fresh = {
    events: data.events.length,
    aaos: Number(data.state.aaoCount) || 0,
    proposals: data.state.proposals.length,
    block: Number(data.blockNumber) || 0
  };

  const previous = S.newestGood(dir);
  const problem = S.replacementProblem(fresh, previous ? previous.summary : null);
  if (problem) {
    return { ok: false, why: problem, fresh, kept: previous ? previous.file : null };
  }

  const file = S.writeAtomic(path.join(dir, S.nameFor(o.at || new Date())),
    JSON.stringify(data) + "\n");
  const removed = S.prune(dir, o.keep);
  return { ok: true, file, ...fresh, removed: removed.length, total: S.list(dir).length };
}

function describe(result) {
  if (!result.ok) return `snapshot refused: ${result.why}`;
  return `snapshot ${path.basename(result.file)}: ${result.events} events, ` +
    `${result.aaos} AAOs, ${result.proposals} proposals at block ${result.block}` +
    `${result.removed ? `; pruned ${result.removed}` : ""} (${result.total} kept)`;
}

async function main() {
  const dir = S.directory();
  if (process.argv.includes("--list")) {
    const all = S.list(dir);
    console.log(`${all.length} snapshot(s) in ${dir}`);
    all.slice(-12).forEach((file) => {
      const seen = S.summarise(file);
      console.log(`  ${path.basename(file)}  ${seen
        ? `${seen.events} events, ${seen.proposals} proposals, block ${seen.block}`
        : "unreadable"}`);
    });
    return;
  }

  const result = await take({});
  console.log(describe(result));
  if (result.ok) console.log(`  ${result.file}`);
  else if (result.kept) console.log(`  kept ${result.kept}`);
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { take, describe };

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
