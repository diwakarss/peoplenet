// The standing builder's vote, from Hardhat account 3.
//
// The twin of scripts/wren-vote.js, and deliberately the same shape: the vote goes on
// chain and the REASON goes to governance/builder-votes.jsonl, so the tally and the
// argument for it stay together. A vote without an argument is a number; the argument is
// the part another agent can answer.
//
// The builder votes in the "widget-builder" sub-AAO (AAO 1) by default -- the room where
// the widget, its builder and Wren work out what to propose -- and can vote on the main
// AAO with --aao 0 when a proposal there is about the widget's own code.
//
// Usage (plain node -- `hardhat run` cannot forward arguments):
//   node scripts/builder-vote.js <proposalId> <for|against> "<reason>"
//   node scripts/builder-vote.js 26 for "The id is already content-addressed here."
//   node scripts/builder-vote.js --aao 0 3 against "..."
//
// The network defaults to localhost (127.0.0.1:8545); set HARDHAT_NETWORK to change it.
process.env.HARDHAT_NETWORK = process.env.HARDHAT_NETWORK || "localhost";

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const R = require("../governance/read.js");
const { DIAMOND, BUILDER, labelFor, STATUS } = R;

const LOG_PATH = path.join(__dirname, "..", "governance", "builder-votes.jsonl");
const BUILDER_ACCOUNT = 3;
//: the "widget-builder" sub-AAO (spec 27.4). The builder's own room.
const DEFAULT_AAO = 1;

function usage(message) {
  console.error(message);
  console.error("");
  console.error('  node scripts/builder-vote.js [--aao <id>] <proposalId> <for|against> "<reason>" [--dry-run]');
  process.exit(1);
}

function parseArgs(argv) {
  let rest = argv.slice(2);
  if (rest[0] === "--") rest = rest.slice(1);
  let aaoId = DEFAULT_AAO;
  let dryRun = false;
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--aao") { aaoId = Number(rest[++i]); continue; }
    if (rest[i] === "--dry-run") { dryRun = true; continue; }
    positional.push(rest[i]);
  }
  return { aaoId, dryRun, positional };
}

async function main() {
  const { aaoId, dryRun, positional } = parseArgs(process.argv);
  const [rawId, rawSupport, ...reasonParts] = positional;

  if (rawId === undefined || rawSupport === undefined) {
    usage("builder-vote: need a proposal id and for|against.");
  }
  const proposalId = Number(rawId);
  if (!Number.isInteger(proposalId) || proposalId < 0) {
    usage(`builder-vote: "${rawId}" is not a proposal id.`);
  }
  if (!Number.isInteger(aaoId) || aaoId < 0) {
    usage(`builder-vote: "${aaoId}" is not an AAO id.`);
  }
  const choice = String(rawSupport).toLowerCase();
  if (choice !== "for" && choice !== "against") {
    usage(`builder-vote: "${rawSupport}" is neither "for" nor "against".`);
  }
  const support = choice === "for";
  const reason = reasonParts.join(" ").trim();
  if (!reason) {
    usage("builder-vote: a reason is required -- in plain English, and it is the half " +
          "another agent can answer.");
  }

  const signers = await ethers.getSigners();
  const builder = signers[BUILDER_ACCOUNT];
  if (!builder) throw new Error(`No Hardhat account ${BUILDER_ACCOUNT} on this network.`);
  if (builder.address.toLowerCase() !== BUILDER.toLowerCase()) {
    throw new Error(
      `Account ${BUILDER_ACCOUNT} is ${builder.address}, expected the Builder at ${BUILDER}. ` +
      `Refusing to vote as someone else.`);
  }

  const aaoFacet = await ethers.getContractAt("AAOFacet", DIAMOND);
  if (!(await aaoFacet.isMember(aaoId, builder.address))) {
    throw new Error(`The builder is not a member of AAO ${aaoId}. ` +
                    `Run scripts/create-widget-builder-aao.js first.`);
  }

  const before = await aaoFacet.getProposal(proposalId);
  // A vote on an id nobody has filed goes through, and then BLOCKS the real proposal
  // when it arrives. An unfiled slot reads back with the zero proposer and empty text.
  if (!before.proposer || /^0x0+$/.test(String(before.proposer)) || !String(before.text).trim()) {
    throw new Error(
      `Proposal ${proposalId} has not been filed (no proposer, no text). Check ` +
      `scripts/tally.js for the ids that exist. Refusing to vote on an empty slot: the ` +
      `vote would stand and block the real proposal when it is filed.`);
  }
  if (Number(before.aaoId) !== aaoId) {
    throw new Error(`Proposal ${proposalId} belongs to AAO ${Number(before.aaoId)}, not ${aaoId}. ` +
                    `Pass --aao ${Number(before.aaoId)} if that is the one you meant.`);
  }
  if (Number(before.status) !== 0) {
    throw new Error(`Proposal ${proposalId} is ${STATUS[Number(before.status)]}, not open for votes.`);
  }

  console.log(`AAO ${aaoId}, proposal ${proposalId}: ${before.text}`);
  console.log(`proposed by ${labelFor(before.proposer)}`);
  console.log(`Builder votes ${choice.toUpperCase()}: ${reason}`);

  // The rehearsal goes here, after every check has run, so what it prints is
  // what the real run would actually do rather than what it hopes to.
  if (dryRun) {
    console.log("");
    console.log(R.describePlan({
      standing: [
        `AAO ${aaoId}: the Builder is one of its voters.`,
        `Proposal ${proposalId} exists, is on AAO ${aaoId}, and is ${STATUS[Number(before.status)]}.`,
        `Tally now ${Number(before.forVotes)}-${Number(before.againstVotes)}.`
      ],
      from: builder.address,
      call: `vote(${proposalId}, ${support})`,
      effect: `${choice} -> tally would become ` +
        `${Number(before.forVotes) + (support ? 1 : 0)}-` +
        `${Number(before.againstVotes) + (support ? 0 : 1)}`,
      logFile: path.relative(process.cwd(), LOG_PATH)
    }));
    return;
  }

  const tx = await aaoFacet.connect(builder).vote(proposalId, support);
  const receipt = await tx.wait();

  const after = await aaoFacet.getProposal(proposalId);
  const forVotes = Number(after.forVotes);
  const againstVotes = Number(after.againstVotes);

  const record = {
    at: new Date().toISOString(),
    aaoId,
    proposalId,
    voter: builder.address,
    role: "Builder",
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
  console.log(`logged to ${path.relative(process.cwd(), LOG_PATH)}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
