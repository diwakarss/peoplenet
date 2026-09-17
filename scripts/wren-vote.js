// Wren's vote on a trilogy widget proposal (spec section 24, WP17d).
//
// Only the architect session runs this. The governance page never casts Wren's
// vote: Wren states the reason in the chat first, then this script puts the vote
// on chain from Hardhat account 1 and appends the reason to
// governance/wren-votes.jsonl so the record and the tally stay together.
//
// Usage (plain node -- `hardhat run` cannot forward arguments):
//   node scripts/wren-vote.js <proposalId> <for|against> "<reason>"
//   node scripts/wren-vote.js 3 for "The cache key is the real fix."
//
// The network defaults to localhost (127.0.0.1:8545); set HARDHAT_NETWORK to
// point it somewhere else.
process.env.HARDHAT_NETWORK = process.env.HARDHAT_NETWORK || "localhost";

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { DIAMOND, AAO_ID, WREN, labelFor, STATUS } = require("../governance/read.js");

const LOG_PATH = path.join(__dirname, "..", "governance", "wren-votes.jsonl");

function parseArgs(argv) {
  // Plain `node scripts/wren-vote.js ...`, so everything after the script path
  // is ours. A leading "--" is tolerated for people used to npm-script syntax.
  var rest = argv.slice(2);
  if (rest[0] === "--") rest = rest.slice(1);
  return rest;
}

function usage(message) {
  console.error(message);
  console.error("");
  console.error('  node scripts/wren-vote.js <proposalId> <for|against> "<reason>"');
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv);
  const [rawId, rawSupport, ...reasonParts] = args;

  if (rawId === undefined || rawSupport === undefined) {
    usage("wren-vote: need a proposal id and for|against.");
  }
  const proposalId = Number(rawId);
  if (!Number.isInteger(proposalId) || proposalId < 0) {
    usage(`wren-vote: "${rawId}" is not a proposal id.`);
  }
  const choice = String(rawSupport).toLowerCase();
  if (choice !== "for" && choice !== "against") {
    usage(`wren-vote: "${rawSupport}" is neither "for" nor "against".`);
  }
  const support = choice === "for";
  const reason = reasonParts.join(" ").trim();
  if (!reason) {
    usage("wren-vote: a reason is required -- the vote is only as good as the argument for it.");
  }

  const signers = await ethers.getSigners();
  const wren = signers[1];
  if (!wren) throw new Error("No Hardhat account 1 on this network.");
  if (wren.address.toLowerCase() !== WREN.toLowerCase()) {
    throw new Error(
      `Account 1 is ${wren.address}, expected Wren at ${WREN}. Refusing to vote as someone else.`
    );
  }

  const aaoFacet = await ethers.getContractAt("AAOFacet", DIAMOND);

  const isMember = await aaoFacet.isMember(AAO_ID, wren.address);
  if (!isMember) {
    throw new Error("Wren is not a member of AAO 0. Run scripts/setup-governance-members.js first.");
  }

  const before = await aaoFacet.getProposal(proposalId);
  if (Number(before.aaoId) !== AAO_ID) {
    throw new Error(`Proposal ${proposalId} belongs to AAO ${Number(before.aaoId)}, not ${AAO_ID}.`);
  }
  if (Number(before.status) !== 0) {
    throw new Error(`Proposal ${proposalId} is ${STATUS[Number(before.status)]}, not open for votes.`);
  }

  console.log(`proposal ${proposalId}: ${before.text}`);
  console.log(`proposed by ${labelFor(before.proposer)}`);
  console.log(`Wren votes ${choice.toUpperCase()}: ${reason}`);

  const tx = await aaoFacet.connect(wren).vote(proposalId, support);
  const receipt = await tx.wait();

  const after = await aaoFacet.getProposal(proposalId);
  const forVotes = Number(after.forVotes);
  const againstVotes = Number(after.againstVotes);

  const record = {
    at: new Date().toISOString(),
    aaoId: AAO_ID,
    proposalId,
    voter: wren.address,
    role: "Wren",
    support,
    choice,
    reason,
    proposalText: before.text,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    tallyAfter: { for: forVotes, against: againstVotes }
  };
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(record) + "\n", "utf8");

  console.log("");
  console.log(`tx ${receipt.hash} (block ${receipt.blockNumber})`);
  console.log(`tally now: ${forVotes} for, ${againstVotes} against`);
  if (forVotes === againstVotes) {
    console.log("tied -- the Director's casting vote (account 2) can now decide it on the page.");
  }
  console.log(`logged to ${path.relative(process.cwd(), LOG_PATH)}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
