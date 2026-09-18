// governance/vote.js -- one vote script, told which account it is.
//
// Proposal 30 on the widget-builder, carried, and filed by the builder who had
// just written the duplication being complained about: builder-vote.js was
// wren-vote.js with two names changed, so the guard against voting on an
// unfiled id had to be written twice and the --dry-run default had to be
// remembered twice. When a check lives in two places, it is one edit away from
// living in one and a half.
//
// So everything a vote does lives here, once:
//
//   * the argument parsing, including a repeatable --ref (proposal 29)
//   * the dry-run DEFAULT -- rehearsing is what you get by doing nothing, and
//     --send is what it takes to spend a transaction
//   * the standing checks: the account really is who it claims, it is a member,
//     the rule in force lets it vote here, the proposal exists and is the one
//     the caller read, the id has not drifted under them
//   * the casting-vote condition, where the caller is the tie-breaker
//   * the record appended to the caller's own log, with the tally it produced
//
// and each agent's script is the handful of lines that say who it is:
//
//   scripts/wren-vote.js      account 1, "Wren",    wren-votes.jsonl,    AAO 0
//   scripts/builder-vote.js   account 3, "Builder", builder-votes.jsonl, AAO 1
//   scripts/widget-vote.js    account 4, "Widget",  widget-votes.jsonl,  AAO 1
//
// The widget's script cost five lines because of this, which was the argument
// for filing the proposal: an agent that cannot vote is an agent whose rule
// nobody can lift.
//
// Nothing here is specific to one voter. Where a voter genuinely differs -- Wren
// is the casting vote on the widget-builder, the others are not -- the
// difference is read out of governance/read.js's rule set, not written down
// here, so the page and the scripts refuse the same things for the same reasons.
"use strict";

const fs = require("fs");
const path = require("path");
const R = require("./read.js");

const GOV = __dirname;

// --- arguments ---------------------------------------------------------

// Flags are pulled out of the positional arguments so the reason stays one
// free-text run and nothing inside it is mistaken for an option.
function parseArgs(argv, defaults) {
  const d = defaults || {};
  let rest = argv.slice(2);
  // A leading "--" is tolerated for people used to npm-script syntax.
  if (rest[0] === "--") rest = rest.slice(1);

  let expectTitle = null;
  let aaoId = d.defaultAaoId === undefined ? R.AAO_ID : d.defaultAaoId;
  let dryRun = !R.wantsSend(argv);
  const refs = [];
  const positional = [];

  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--expect-title" || rest[i] === "--expect") {
      expectTitle = String(rest[++i] || "");
      continue;
    }
    // Repeatable: what this vote was cast against (proposal 29).
    if (rest[i] === "--ref") { refs.push(String(rest[++i] || "")); continue; }
    if (rest[i] === "--aao") { aaoId = Number(rest[++i]); continue; }
    if (rest[i] === "--dry-run") { dryRun = true; continue; }
    if (rest[i] === "--send") { continue; }
    positional.push(rest[i]);
  }

  const [rawId, rawSupport, ...reasonParts] = positional;
  return {
    aaoId,
    dryRun,
    expectTitle,
    refs: R.voteRefs({ refs }),
    rawId,
    rawSupport,
    reason: reasonParts.join(" ").trim(),
    positional
  };
}

// The usage text, built from who the caller is so each script prints its own
// name and its own default without repeating the shape.
function usageLines(voter) {
  const name = voter.command;
  const lines = [
    "",
    `  node scripts/${name} <proposalId> <for|against> "<reason>" \\`,
    '      [--ref <what you read>]... [--aao <id>] [--expect-title "..."] [--send]',
    "",
    "  Rehearsing is the default. Nothing reaches the chain without --send.",
    "",
    "  --ref     what this vote was cast against: a commit, another proposal, a",
    "            spec entry, a URL. Repeatable. It is what makes the reason",
    '            checkable rather than only recorded -- e.g. --ref "commit 1f8076d"',
    `  --aao     which organisation (default ${voter.defaultAaoId}).`,
    ""
  ];
  (voter.standingNotes || []).forEach((line) => lines.push("  " + line));
  if (voter.standingNotes && voter.standingNotes.length) lines.push("");
  return lines;
}

// --- the log -----------------------------------------------------------

function logPathFor(voter) {
  return path.join(GOV, voter.logFile);
}

// The voter's own log, for the drift check below.
function readOwnLog(voter) {
  const file = logPathFor(voter);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch (e) { return null; } })
    .filter(Boolean);
}

// --- the vote ----------------------------------------------------------

// `deps` is { ethers } -- hardhat's, handed in rather than required here, so
// this module stays loadable without a network attached and the tests can read
// it the way the page reads read.js.
async function castVote(deps, voter, argv) {
  const { ethers } = deps;
  const args = parseArgs(argv, voter);
  const fail = (message) => {
    const error = new Error(message);
    error.usage = usageLines(voter);
    throw error;
  };

  if (args.rawId === undefined || args.rawSupport === undefined) {
    fail(`${voter.command.replace(/\.js$/, "")}: need a proposal id and for|against.`);
  }
  const proposalId = Number(args.rawId);
  if (!Number.isInteger(proposalId) || proposalId < 0) {
    fail(`${voter.command.replace(/\.js$/, "")}: "${args.rawId}" is not a proposal id.`);
  }
  const choice = String(args.rawSupport).toLowerCase();
  if (choice !== "for" && choice !== "against") {
    fail(`${voter.command.replace(/\.js$/, "")}: "${args.rawSupport}" is neither "for" nor "against".`);
  }
  if (!Number.isInteger(args.aaoId) || args.aaoId < 0) {
    fail(`${voter.command.replace(/\.js$/, "")}: --aao "${args.aaoId}" is not an organisation id.`);
  }
  const support = choice === "for";
  const reason = args.reason;
  if (!reason) {
    fail(`${voter.command.replace(/\.js$/, "")}: a reason is required -- the vote is only as ` +
         "good as the argument for it, and the argument is the half another agent can answer.");
  }

  // Who is signing. An account that is not the one this script is for is the
  // one mistake that cannot be taken back: one member, one vote.
  const signers = await ethers.getSigners();
  const signer = signers[voter.account];
  if (!signer) throw new Error(`No Hardhat account ${voter.account} on this network.`);
  if (!R.sameAddress(signer.address, voter.address)) {
    throw new Error(
      `Account ${voter.account} is ${signer.address}, expected ${voter.label} at ` +
      `${voter.address}. Refusing to vote as someone else.`
    );
  }

  const aaoFacet = await ethers.getContractAt("AAOFacet", R.DIAMOND);

  const organisation = await aaoFacet.getAAO(args.aaoId);
  if (!organisation.topic) throw new Error(`There is no AAO ${args.aaoId} on this chain.`);

  // The rules in force, which on the widget-builder depend on whether the widget
  // has ever voted there. Read the organisation's proposals to find out, and say
  // which rule was found before anything is checked against it.
  const onThisAao = await R.readProposals(aaoFacet, args.aaoId);
  const rules = R.effectiveRules({ topic: organisation.topic }, onThisAao);
  if (rules.regime) console.log(`AAO ${args.aaoId}: ${rules.regime}`);

  if (!(await aaoFacet.isMember(args.aaoId, signer.address))) {
    throw new Error(
      `${voter.label} is not a member of AAO ${args.aaoId} ("${organisation.topic}"). ` +
      "Run scripts/setup-governance-members.js for AAO 0, or " +
      "scripts/create-widget-builder-aao.js for the sub-AAO."
    );
  }

  // Standing. Not every voter votes on every organisation: the Director watches
  // the widget-builder, Wren is its casting vote under the standing rule. The
  // rule lives in read.js, so the page and this refuse the same things.
  const problem = R.voterProblem(rules, voter.address);
  if (problem) throw new Error(`On "${organisation.topic}": ${problem}`);
  const isOrdinary = rules.voters.some((a) => R.sameAddress(a, voter.address));

  const before = await aaoFacet.getProposal(proposalId);

  // Before anything else: is there a proposal there at all, and is it the one
  // the caller read? An unfiled id reads back as a zero struct and AAOFacet.vote
  // will happily record a vote against it, which then blocks the real vote with
  // "Already voted" when the id is filled in. That is how the vote on 27 was
  // lost, so this comes before the aaoId and status checks -- an empty struct
  // passes both of those.
  const targetProblem = R.voteTargetProblem(
    proposalId, before, args.expectTitle ? { title: args.expectTitle } : null
  );
  if (targetProblem) {
    throw new Error(
      targetProblem + "\n\n" +
      "If you meant a different id, check it with:  node scripts/list-proposals.js\n" +
      'To vote only if the proposal is the one you read, pass --expect-title "<its title>".'
    );
  }

  if (Number(before.aaoId) !== args.aaoId) {
    throw new Error(
      `Proposal ${proposalId} belongs to AAO ${Number(before.aaoId)}, not ${args.aaoId}. ` +
      `Pass --aao ${Number(before.aaoId)} if that is the one you meant.`
    );
  }
  if (Number(before.status) !== 0) {
    throw new Error(
      `Proposal ${proposalId} is ${R.STATUS[Number(before.status)]}, not open for votes.`
    );
  }

  // Where this voter is the casting vote rather than an ordinary one, the tally
  // has to be level with both ordinary voters in before they may touch it.
  // Voting early would decide a question the two members have not finished
  // asking.
  if (!isOrdinary) {
    const enriched = onThisAao.filter((p) => p.id === proposalId)[0];
    if (!enriched) {
      throw new Error(`Proposal ${proposalId} could not be read back from AAO ${args.aaoId}.`);
    }
    const casting = R.castingStateUnder(rules, enriched);
    if (!casting.allowed) {
      throw new Error(
        `${voter.label} is the casting vote on "${organisation.topic}", and it is not ` +
        `theirs to cast yet.\n  ${casting.reason}\n\n` +
        `Voters here: ${rules.voters.map(R.labelFor).join(" and ")}. ` +
        "The casting vote breaks a level tally and nothing else."
      );
    }
    console.log(`casting vote on "${organisation.topic}": ${casting.reason}`);
  }

  // A second reading of the same lesson: if this id already carries a vote from
  // this voter in the log against different words, the id has drifted under them.
  const prior = readOwnLog(voter).filter((r) => Number(r.proposalId) === proposalId);
  const drifted = prior.filter(
    (r) => r.proposalText && !R.looselyEqual(r.proposalText, before.text)
  );
  if (drifted.length && !args.expectTitle) {
    throw new Error(
      `${voter.logFile} already records a vote on proposal ${proposalId}, but against ` +
      `different text:\n  logged: ${String(drifted[0].proposalText).slice(0, 90)}\n` +
      `  chain:  ${String(before.text).slice(0, 90)}\n\n` +
      "The id has drifted. Re-read the proposal and pass --expect-title to confirm."
    );
  }

  console.log(`proposal ${proposalId}: ${R.proposalHeadline({ text: before.text })}`);
  console.log(`proposed by ${R.labelFor(before.proposer)}`);
  console.log(`${voter.label} votes ${choice.toUpperCase()}: ${reason}`);

  // What the record would point at, said in the rehearsal so a vote cast with
  // no --ref is a deliberate silence rather than an oversight (proposal 29).
  const refsLine = args.refs.length
    ? `The record would point at: ${args.refs.join(", ")}.`
    : "The record would point at nothing. Pass --ref to say what you read.";

  // The rehearsal is built after every check has run, so what it prints is what
  // the real run would actually do rather than what it hopes to.
  const plan = R.describePlan({
    standing: [
      `AAO ${args.aaoId} "${organisation.topic}": ${voter.label} is ` +
        `${isOrdinary ? "an ordinary voter" : "the casting vote"}.`,
      `Proposal ${proposalId} exists, is on AAO ${args.aaoId}, and is ` +
        `${R.STATUS[Number(before.status)]}.`,
      `Tally now ${Number(before.forVotes)}-${Number(before.againstVotes)}.`,
      isOrdinary
        ? "No casting-vote condition applies."
        : "The casting-vote condition is met.",
      refsLine
    ],
    from: signer.address,
    call: `vote(${proposalId}, ${support})`,
    effect: `${choice} -> tally would become ` +
      `${Number(before.forVotes) + (support ? 1 : 0)}-` +
      `${Number(before.againstVotes) + (support ? 0 : 1)}`,
    logFile: path.relative(process.cwd(), logPathFor(voter))
  });

  if (args.dryRun) {
    console.log("");
    console.log(plan);
    return { sent: false, proposalId, support, refs: args.refs, plan };
  }

  const tx = await aaoFacet.connect(signer).vote(proposalId, support);
  const receipt = await tx.wait();

  const after = await aaoFacet.getProposal(proposalId);
  const forVotes = Number(after.forVotes);
  const againstVotes = Number(after.againstVotes);

  const record = {
    at: new Date().toISOString(),
    aaoId: args.aaoId,
    proposalId,
    voter: signer.address,
    role: voter.label,
    support,
    choice,
    reason,
    // What the reason was written against (proposal 29).
    refs: args.refs,
    proposalText: before.text,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    tallyAfter: { for: forVotes, against: againstVotes }
  };
  fs.mkdirSync(GOV, { recursive: true });
  fs.appendFileSync(logPathFor(voter), JSON.stringify(record) + "\n", "utf8");

  console.log("");
  console.log(`tx ${receipt.hash} (block ${receipt.blockNumber})`);
  console.log(`tally now: ${forVotes} for, ${againstVotes} against`);
  if (forVotes === againstVotes && rules.casting) {
    console.log(`tied -- ${R.labelFor(rules.casting)} breaks it.`);
  }
  console.log(`logged to ${path.relative(process.cwd(), logPathFor(voter))}`);

  return { sent: true, proposalId, support, refs: args.refs, record };
}

// What each agent's script is: five lines that say who it is, and this.
//
// The network defaults to localhost (127.0.0.1:8545); set HARDHAT_NETWORK to
// point it somewhere else. Set before hardhat is required, which is why it
// happens here and not in the wrapper.
function run(voter) {
  process.env.HARDHAT_NETWORK = process.env.HARDHAT_NETWORK || "localhost";
  const { ethers } = require("hardhat");
  castVote({ ethers }, voter, process.argv).catch((e) => {
    console.error(e.message || e);
    if (e.usage) e.usage.forEach((line) => console.error(line));
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  usageLines,
  logPathFor,
  readOwnLog,
  castVote,
  run
};
