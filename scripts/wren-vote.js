// Wren's vote on a governance proposal (spec 24 WP17d, and 27.4a).
//
// Only the architect session runs this. The governance page never casts Wren's
// vote: Wren states the reason in the chat first, then this script puts the vote
// on chain from Hardhat account 1 and appends the reason to
// governance/wren-votes.jsonl so the record and the tally stay together.
//
// Usage (plain node -- `hardhat run` cannot forward arguments):
//   node scripts/wren-vote.js <proposalId> <for|against> "<reason>" [--aao <id>]
//   node scripts/wren-vote.js 3 for "The cache key is the real fix."
//   node scripts/wren-vote.js 34 for "Tied 1-1; this side is the safer one." --aao 1
//
// Wren does not have the same standing on every organisation. On AAO 0, the
// trilogy widget, she is an ordinary voter alongside the Director. On AAO 1,
// the widget-builder, the standing rule is that the builder and the widget vote
// and Wren is the casting vote -- so this refuses there unless the tally is
// level with both of their votes in (27.4a).
//
// AAO 1 has a second, interim rule, and which one is in force is not a setting:
// it is read off the chain. Until account 4, the widget, has cast its first vote
// there, Wren is the second ordinary voter instead of the tie-breaker. The
// script prints the rule it found before it checks anything against it.
//
// Both rules live in governance/read.js, which the page reads too, so the
// script and the page cannot drift apart.
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

  // Flags are pulled out of the positional arguments so the reason stays one
  // free-text run and nothing in it is mistaken for an option.
  var expectTitle = null;
  var aaoId = AAO_ID;
  var dryRun = !R.wantsSend(process.argv);
  var positional = [];
  for (var i = 0; i < rest.length; i++) {
    if (rest[i] === "--expect-title" || rest[i] === "--expect") {
      expectTitle = String(rest[++i] || "");
      continue;
    }
    if (rest[i] === "--aao") { aaoId = Number(rest[++i]); continue; }
    if (rest[i] === "--dry-run") { dryRun = true; continue; }
    if (rest[i] === "--send") { continue; }
    positional.push(rest[i]);
  }
  positional.expectTitle = expectTitle;
  positional.aaoId = aaoId;
  positional.dryRun = dryRun;
  return positional;
}

function usage(message) {
  console.error(message);
  console.error("");
  console.error('  node scripts/wren-vote.js <proposalId> <for|against> "<reason>" \\');
  console.error('      [--aao <id>] [--expect-title "..."] [--dry-run]');
  console.error("");
  console.error("  --aao 0   the trilogy widget: Wren has an ordinary vote (the default)");
  console.error("  --aao 1   widget-builder: under the standing rule Wren votes only to");
  console.error("            break a level tally, after the builder and the widget have");
  console.error("            voted. Until the widget casts its first vote there, the");
  console.error("            interim rule applies and Wren is the second ordinary voter;");
  console.error("            the script names the rule in force before it does anything.");
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv);
  const expectTitle = args.expectTitle;
  const aaoId = args.aaoId;
  const dryRun = args.dryRun;
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

  if (!Number.isInteger(aaoId) || aaoId < 0) {
    usage(`wren-vote: --aao "${aaoId}" is not an organisation id.`);
  }
  const organisation = await aaoFacet.getAAO(aaoId);
  if (!organisation.topic) throw new Error(`There is no AAO ${aaoId} on this chain.`);
  // The rules in force, which on the widget-builder depend on whether the
  // widget has ever voted. Read the organisation's proposals to find out.
  const onThisAao = await R.readProposals(aaoFacet, aaoId);
  const rules = R.effectiveRules({ topic: organisation.topic }, onThisAao);
  if (rules.regime) console.log(`AAO ${aaoId}: ${rules.regime}`);

  const isMember = await aaoFacet.isMember(aaoId, wren.address);
  if (!isMember) {
    throw new Error(
      `Wren is not a member of AAO ${aaoId} ("${organisation.topic}"). ` +
      "Run scripts/setup-governance-members.js for AAO 0, or " +
      "scripts/create-widget-builder-aao.js for the sub-AAO."
    );
  }

  // Wren does not have the same standing everywhere. On the trilogy widget she
  // is an ordinary voter; on the widget-builder she is the casting vote, and
  // 27.4a says that is used only to break a level tally after the builder and
  // the widget have both voted. read.js holds the rule, so the page and this
  // script refuse the same things for the same reasons.
  const wrenProblem = R.voterProblem(rules, WREN);
  if (wrenProblem) throw new Error(`On "${organisation.topic}": ${wrenProblem}`);
  const wrenIsOrdinary = rules.voters.some((a) => R.sameAddress(a, WREN));

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

  if (Number(before.aaoId) !== aaoId) {
    throw new Error(
      `Proposal ${proposalId} belongs to AAO ${Number(before.aaoId)}, not ${aaoId}. ` +
      `Pass --aao ${Number(before.aaoId)} if that is the one you meant.`
    );
  }
  if (Number(before.status) !== 0) {
    throw new Error(`Proposal ${proposalId} is ${STATUS[Number(before.status)]}, not open for votes.`);
  }

  // Where Wren is the casting vote, the tally has to be level and both ordinary
  // voters in before she may touch it. Voting early would decide a question the
  // two members have not finished asking.
  if (!wrenIsOrdinary) {
    const enriched = onThisAao.filter((p) => p.id === proposalId)[0];
    if (!enriched) throw new Error(`Proposal ${proposalId} could not be read back from AAO ${aaoId}.`);
    const casting = R.castingStateUnder(rules, enriched);
    if (!casting.allowed) {
      throw new Error(
        `Wren is the casting vote on "${organisation.topic}", and it is not hers to cast yet.\n` +
        `  ${casting.reason}\n\n` +
        `Voters here: ${rules.voters.map(R.labelFor).join(" and ")}. ` +
        "The casting vote breaks a level tally and nothing else."
      );
    }
    console.log(`casting vote on "${organisation.topic}": ${casting.reason}`);
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

  // The rehearsal goes here, after every check has run, so what it prints is
  // what the real run would actually do rather than what it hopes to.
  if (dryRun) {
    console.log("");
    console.log(R.describePlan({
      standing: [
        `AAO ${aaoId} "${organisation.topic}": Wren is ` +
          `${wrenIsOrdinary ? "an ordinary voter" : "the casting vote"}.`,
        `Proposal ${proposalId} exists, is on AAO ${aaoId}, and is ${STATUS[Number(before.status)]}.`,
        `Tally now ${Number(before.forVotes)}-${Number(before.againstVotes)}.`,
        wrenIsOrdinary
          ? "No casting-vote condition applies."
          : "The casting-vote condition is met."
      ],
      from: wren.address,
      call: `vote(${proposalId}, ${support})`,
      effect: `${choice} -> tally would become ` +
        `${Number(before.forVotes) + (support ? 1 : 0)}-` +
        `${Number(before.againstVotes) + (support ? 0 : 1)}`,
      logFile: path.relative(process.cwd(), LOG_PATH)
    }));
    return;
  }

  const tx = await aaoFacet.connect(wren).vote(proposalId, support);
  const receipt = await tx.wait();

  const after = await aaoFacet.getProposal(proposalId);
  const forVotes = Number(after.forVotes);
  const againstVotes = Number(after.againstVotes);

  const record = {
    at: new Date().toISOString(),
    aaoId: aaoId,
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
