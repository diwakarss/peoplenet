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
const R = require("../governance/read.js");
const { DIAMOND, AAO_ID, WREN, labelFor, STATUS } = R;

const LOG_PATH = path.join(__dirname, "..", "governance", "wren-votes.jsonl");

// Wren's own log, for the drift check below.
function readOwnLog() {
  if (!fs.existsSync(LOG_PATH)) return [];
  return fs.readFileSync(LOG_PATH, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch (e) { return null; } })
    .filter(Boolean);
}

function parseArgs(argv) {
  // Plain `node scripts/wren-vote.js ...`, so everything after the script path
  // is ours. A leading "--" is tolerated for people used to npm-script syntax.
  var rest = argv.slice(2);
  if (rest[0] === "--") rest = rest.slice(1);

  // --expect-title "..." says what Wren believes she is voting on. Pulled out
  // of the positional arguments so the reason stays one free-text run.
  var expectTitle = null;
  var positional = [];
  for (var i = 0; i < rest.length; i++) {
    if (rest[i] === "--expect-title") { expectTitle = String(rest[++i] || ""); continue; }
    if (rest[i] === "--expect") { expectTitle = String(rest[++i] || ""); continue; }
    positional.push(rest[i]);
  }
  positional.expectTitle = expectTitle;
  return positional;
}

function usage(message) {
  console.error(message);
  console.error("");
  console.error('  node scripts/wren-vote.js <proposalId> <for|against> "<reason>" [--expect-title "..."]');
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv);
  const expectTitle = args.expectTitle;
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

  // Before anything else: is there a proposal there at all, and is it the one
  // Wren read? An unfiled id reads back as a zero struct and AAOFacet.vote()
  // will happily record a vote against it, which then blocks the real vote with
  // "Already voted" when the id is filled in. That is how the vote on 27 was
  // lost, so this check comes before the aaoId and status checks -- an empty
  // struct passes both of those.
  const problem = R.voteTargetProblem(
    proposalId,
    before,
    expectTitle ? { title: expectTitle } : null
  );
  if (problem) {
    throw new Error(
      problem + "\n\n" +
      "If you meant a different id, check it with:  node scripts/list-proposals.js\n" +
      "To vote only if the proposal is the one you read, pass --expect-title \"<its title>\"."
    );
  }

  if (Number(before.aaoId) !== AAO_ID) {
    throw new Error(`Proposal ${proposalId} belongs to AAO ${Number(before.aaoId)}, not ${AAO_ID}.`);
  }
  if (Number(before.status) !== 0) {
    throw new Error(`Proposal ${proposalId} is ${STATUS[Number(before.status)]}, not open for votes.`);
  }

  // A second reading of the same lesson: if this id already carries a vote from
  // Wren in the log with different words, the id has drifted under her.
  const priorForThisId = readOwnLog().filter((r) => Number(r.proposalId) === proposalId);
  const drifted = priorForThisId.filter(
    (r) => r.proposalText && !R.looselyEqual(r.proposalText, before.text)
  );
  if (drifted.length && !expectTitle) {
    throw new Error(
      `wren-votes.jsonl already records a vote on proposal ${proposalId}, but against different text:\n` +
      `  logged: ${String(drifted[0].proposalText).slice(0, 90)}\n` +
      `  chain:  ${String(before.text).slice(0, 90)}\n\n` +
      "The id has drifted. Re-read the proposal and pass --expect-title to confirm."
    );
  }

  console.log(`proposal ${proposalId}: ${R.proposalHeadline({ text: before.text })}`);
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
