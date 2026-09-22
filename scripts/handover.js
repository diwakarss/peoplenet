// A builder hands over (proposal 96).
//
// An agent is one long session with a fixed memory. At sixty percent full it
// finishes the item in hand and stops; a successor of the same name, the same
// account and the same role carries on as the next generation. Rotation is
// ordinary, not a failure, so it has a command rather than a conversation.
//
// This writes one record to the stream saying which generation ended and what
// it leaves open, and prints what the successor must acknowledge. The successor
// names that record by id in its first message: "I read the ledger" is a claim,
// and "I acknowledge decision-<id>" is a claim about a record that either
// exists or does not.
//
// Usage:
//   node scripts/handover.js --agent kalam \
//     --item "proposals 99 and 96" \
//     --open "94 and 98 now point at 61 and 62" \
//     --commit b1a6fc5 --send
//
//   --open and --commit are repeatable. --to <who> addresses it; default all.
//   Rehearses by default, like every write script here.
//
// Write the ledger first. This record points at it, and a record pointing at a
// section that was never written is worse than no record.
const fs = require("fs");
const path = require("path");
const P = require("../governance/protocol.js");
const R = require("../governance/read.js");
const L = require("../governance/ledger.js");

const GOV = path.join(__dirname, "..", "governance");

function messagesFile() {
  return process.env.GOVERNANCE_LOG_DIR
    ? path.join(path.resolve(process.env.GOVERNANCE_LOG_DIR), "messages.jsonl")
    : path.join(GOV, "messages.jsonl");
}

function usage(message) {
  if (message) console.error(message + "\n");
  console.error("  node scripts/handover.js --agent <name> --item \"...\" --open \"...\" \\");
  console.error("       --commit <sha> [--to <who>] [--send]");
  console.error("");
  console.error("Write the ledger first: node scripts/ledger.js --agent <name> ... --send");
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const out = {
    agent: "", to: "all", item: [], open: [], commit: [],
    dir: path.join(GOV, "ledger"),
    generation: null, dryRun: !R.wantsSend(process.argv)
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") continue;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--send") { /* decided by wantsSend */ }
    else if (arg === "--agent") out.agent = String(rest[++i] || "");
    else if (arg === "--to") out.to = String(rest[++i] || "all");
    else if (arg === "--item") out.item.push(String(rest[++i] || ""));
    else if (arg === "--open") out.open.push(String(rest[++i] || ""));
    else if (arg === "--commit") out.commit.push(String(rest[++i] || ""));
    else if (arg === "--generation") out.generation = Number(rest[++i]);
    else if (arg === "--dir") out.dir = path.resolve(String(rest[++i] || ""));
    else if (arg.startsWith("--")) usage(`handover: unknown option ${arg}`);
    else usage(`handover: ${arg} is not an argument. Every part has a flag.`);
  }
  return out;
}

// The ledger has to exist and has to carry a section, because this record
// points at it. A hand-over naming a ledger nobody wrote is the failure
// proposal 96 is about, wearing the shape of the fix.
function ledgerProblem(agent, dir) {
  const file = path.join(dir, String(agent).toLowerCase() + ".md");
  if (!fs.existsSync(file)) {
    return `There is no ledger at governance/ledger/${String(agent).toLowerCase()}.md. ` +
      "Write it first with scripts/ledger.js; this record points at it.";
  }
  if (!L.sectionsIn(fs.readFileSync(file, "utf8")).length) {
    return `governance/ledger/${String(agent).toLowerCase()}.md has no dated section. ` +
      "Write this stop's section first with scripts/ledger.js.";
  }
  return null;
}

function rehearse(args, message, generation, file) {
  console.log("");
  console.log(R.describePlan({
    standing: [
      `${L.label(args.agent)} is on generation ${generation}; the successor is ${generation + 1}.`,
      "The ledger exists and carries at least one dated section.",
      "This writes a file, not a transaction: no chain state changes."
    ],
    to: "(no transaction)",
    from: "(no account)",
    call: `post "${message.subject}" to the stream`,
    effect: "the successor has one record to acknowledge by id",
    logFile: path.relative(process.cwd(), file)
  }));
  console.log("");
  console.log(JSON.stringify(message, null, 1));
  console.log("");
  console.log(L.acknowledgementFor(message, args.agent, generation));
  console.log("The id above is the rehearsal's; sending produces the same one, because");
  console.log("a message is numbered by what it says.");
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.agent) usage("handover: --agent <name> says who is handing over.");
  if (!args.open.length) {
    usage("handover: --open \"...\" is required. A builder that cannot state what is open has not stopped cleanly.");
  }
  if (!args.commit.length) usage("handover: --commit <sha> says what the ledger stands on.");

  const generation = args.generation === null ? R.generationOf(args.agent) : args.generation;
  if (!generation) {
    console.error(`handover: read.js has no role called "${args.agent}", so there is no generation to move on.`);
    console.error("        Add it to ROLES in governance/read.js first.");
    process.exit(1);
  }

  const problem = ledgerProblem(args.agent, args.dir);
  if (problem) {
    console.error("handover: " + problem);
    process.exit(1);
  }

  const message = P.normalise(L.handoverMessage({
    agent: args.agent, to: args.to, item: args.item,
    open: args.open, commit: args.commit, generation: generation
  }));
  P.assertValid(message, "handover");

  const file = messagesFile();

  if (args.dryRun) return rehearse(args, message, generation, file);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, P.toJsonl(message), "utf8");

  console.log(`${message.subject}.`);
  console.log(`  posted as ${message.id}`);
  console.log(`  ${path.relative(process.cwd(), file)}`);
  console.log("");
  console.log(L.acknowledgementFor(message, args.agent, generation));
  console.log("Last thing: set generation to " + (generation + 1) + " on the " +
    String(args.agent).toLowerCase() + " role in governance/read.js, and commit it.");
  console.log("The generation lives beside the role, not in a message that scrolls away.");
}

try {
  main();
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
