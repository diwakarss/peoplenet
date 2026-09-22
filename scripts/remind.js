// The architect sets a reminder for the Director (proposal 99).
//
// A reminder is not a proposal. The Director never files one and never votes on
// one: he writes a waiting note with a time in it -- "wait a week", "remind me
// Thursday" -- and the organisation's architect turns that into a record here.
// When it falls due the watcher pushes it to his phone, posts a line on the
// page, and brings the proposal back into his vote list.
//
// Usage:
//   node scripts/remind.js list [--proposal N] [--history]
//   node scripts/remind.js set <proposal> --due <ISO date> --text "..." [--aao N]
//   node scripts/remind.js move <id> --due <ISO date>
//   node scripts/remind.js cancel <id>
//
//   --from <who>    who is setting it; default "kural"
//   --aao <id>      the organisation; default 2 (JD)
//   --topic "<t>"   the organisation's topic, when the chain cannot be reached
//   --send          do it for real. Without it this rehearses, like every other
//                   write script here.
//
// Only the organisation's architect may set, move or cancel one, which is the
// same rule that files a draft (proposal 89) and answers a question (90), read
// out of governance/read.js so all three refuse the same thing for the same
// reason.
//
// This writes a file, not a transaction. governance/reminders.jsonl is
// append-only: moving a reminder appends a new line and cancelling one appends
// a line saying so. Nothing is ever edited.
const fs = require("fs");
const path = require("path");
const P = require("../governance/protocol.js");
const R = require("../governance/read.js");
const RM = require("../governance/reminders.js");

const GOV = path.join(__dirname, "..", "governance");
const REMINDERS = path.join(GOV, "reminders.jsonl");

const JD_AAO_ID = 2;

function logFile() {
  // The same escape hatch every other writer here has: a test points the log
  // somewhere safe rather than being trusted to remember not to write the real
  // one.
  return process.env.GOVERNANCE_LOG_DIR
    ? path.join(path.resolve(process.env.GOVERNANCE_LOG_DIR), "reminders.jsonl")
    : REMINDERS;
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  const { records, skipped } = P.parseJsonl(fs.readFileSync(file, "utf8"));
  if (skipped) console.warn(`${path.basename(file)}: skipped ${skipped} malformed line(s)`);
  return records;
}

function usage(message) {
  if (message) console.error(message + "\n");
  console.error('  node scripts/remind.js set <proposal> --due <ISO> --text "<what it is about>"');
  console.error("  node scripts/remind.js move <id> --due <ISO>");
  console.error("  node scripts/remind.js cancel <id>");
  console.error("  node scripts/remind.js list [--proposal N] [--history]");
  console.error("");
  console.error("Rehearses by default. Add --send to write the line.");
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const out = {
    positional: [], due: "", text: "", from: "kural", aaoId: JD_AAO_ID, topic: null,
    proposal: null, history: false, dryRun: !R.wantsSend(process.argv)
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") continue;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--send") { /* decided by wantsSend */ }
    else if (arg === "--history") out.history = true;
    else if (arg === "--due") out.due = String(rest[++i] || "");
    else if (arg === "--text") out.text = String(rest[++i] || "");
    else if (arg === "--from") out.from = String(rest[++i] || "kural");
    else if (arg === "--topic") out.topic = String(rest[++i] || "");
    else if (arg === "--aao") out.aaoId = Number(rest[++i]);
    else if (arg === "--proposal") out.proposal = Number(rest[++i]);
    else if (arg.startsWith("--")) usage(`remind: unknown option ${arg}`);
    else out.positional.push(arg);
  }
  return out;
}

// The organisation's topic, which is what the rule set is keyed on. From the
// chain when it answers, from --topic when it does not. A guess would be worse
// than a refusal: the rule that decides who may set a reminder is read off it.
async function topicFor(aaoId, given) {
  if (given) return given;
  try {
    const { ethers } = require("ethers");
    const provider = new ethers.JsonRpcProvider(R.RPC_URL);
    const contract = R.getContract(ethers, provider);
    const organisation = await contract.getAAO(aaoId);
    return organisation.topic;
  } catch (e) {
    return null;
  }
}

function describeState(reminder) {
  return String(reminder.state || "?").padEnd(10);
}

function listReminders(records, args) {
  const rows = args.history ? records : RM.current(records);
  const wanted = args.proposal === null
    ? rows
    : rows.filter((r) => Number(r.proposal) === Number(args.proposal));

  if (!wanted.length) {
    console.log(args.proposal === null ? "No reminders." : `No reminders on proposal ${args.proposal}.`);
    return;
  }

  console.log(`${wanted.length} reminder${wanted.length === 1 ? "" : "s"}` +
    (args.history ? ", every line ever written, oldest first:" : ", as they stand:"));
  console.log("");
  wanted
    .slice()
    .sort((a, b) => new Date(a.due) - new Date(b.due))
    .forEach((r) => {
      console.log(`  ${RM.describeDue(r)}  #${String(r.proposal).padEnd(4)} ${describeState(r)} ${r.text}`);
      console.log(`              ${r.id}  set by ${r.set_by}`);
    });
}

function rehearse(args, what, record, existing) {
  console.log("");
  console.log(R.describePlan({
    standing: [
      `Proposal ${record.proposal} on AAO ${record.aaoId}: ${args.from} may set a reminder here.`,
      existing ? `It supersedes the line written at ${existing.at || "an unrecorded time"}.`
        : "It is a new reminder; nothing is superseded.",
      "This writes a file, not a transaction: no chain state changes."
    ],
    to: "(no transaction)",
    from: "(no account)",
    call: `${what} a reminder on proposal ${record.proposal}, due ${RM.describeDue(record)}`,
    effect: record.state === "set"
      ? "the watcher would push it, post a line and bring the proposal back when it falls due"
      : `the reminder would be ${record.state} and would never fire`,
    logFile: path.relative(process.cwd(), logFile())
  }));
  console.log("");
  console.log(JSON.stringify(record, null, 1));
}

async function main() {
  const args = parseArgs(process.argv);
  const records = readLog(logFile());
  const command = args.positional[0];

  if (!command || command === "list") return listReminders(records, args);

  const known = ["set", "move", "cancel"];
  if (known.indexOf(command) === -1) usage(`remind: "${command}" is not one of: list, ${known.join(", ")}`);

  const byId = RM.latest(records);

  if (command === "set") {
    const proposal = Number(args.positional[1]);
    if (!Number.isInteger(proposal) || proposal < 0) usage("remind: which proposal is this reminder about?");
    if (!args.due) usage("remind: --due <ISO date> says when it falls due.");
    if (!RM.isIsoDate(args.due)) usage(`remind: "${args.due}" is not a date.`);
    if (!args.text.trim()) usage('remind: --text "<what it is about>" is what the Director will read.');

    const topic = await topicFor(args.aaoId, args.topic);
    if (topic === null) {
      console.error(`remind: could not read the topic of AAO ${args.aaoId} from the chain, and`);
      console.error("        the rule that says who may set a reminder is keyed on it.");
      console.error(`        Start the node, or pass --topic "<the organisation's topic>".`);
      process.exit(1);
    }

    const problem = R.reminderProblem(R.rulesFor({ topic: topic }), args.from, { topic: topic });
    if (problem) {
      console.error("remind: " + problem);
      process.exit(1);
    }

    const record = {
      id: P.newId("remind"),
      proposal: proposal,
      aaoId: args.aaoId,
      due: new Date(args.due).toISOString(),
      text: args.text.trim(),
      set_by: args.from,
      state: "set",
      at: new Date().toISOString()
    };
    RM.assertValid(record, "remind");

    if (args.dryRun) return rehearse(args, "set", record, null);
    return write(record);
  }

  // move and cancel both act on an existing reminder, so both start here.
  const id = args.positional[1];
  if (!id) usage(`remind: which reminder? Pass its id; "remind.js list" shows them.`);
  const existing = byId[id];
  if (!existing) {
    console.error(`remind: there is no reminder ${id}. "remind.js list" shows what there is.`);
    process.exit(1);
  }

  const topic = await topicFor(existing.aaoId, args.topic);
  if (topic === null) {
    console.error(`remind: could not read the topic of AAO ${existing.aaoId} from the chain.`);
    console.error(`        Start the node, or pass --topic "<the organisation's topic>".`);
    process.exit(1);
  }
  const problem = R.reminderProblem(R.rulesFor({ topic: topic }), args.from, { topic: topic });
  if (problem) {
    console.error("remind: " + problem);
    process.exit(1);
  }

  if (existing.state !== "set") {
    console.error(`remind: reminder ${id} is ${existing.state}, so there is nothing to ${command}.`);
    process.exit(1);
  }

  if (command === "move") {
    if (!args.due) usage("remind: --due <ISO date> says where it moves to.");
    if (!RM.isIsoDate(args.due)) usage(`remind: "${args.due}" is not a date.`);
    // Two lines, because the file is append-only and both facts are worth
    // keeping: the old one was moved, and the new one stands.
    const moved = RM.supersede(existing, { state: "moved", moved_to: new Date(args.due).toISOString() });
    const standing = RM.supersede(existing, { state: "set", due: new Date(args.due).toISOString() });
    RM.assertValid(standing, "remind");

    if (args.dryRun) return rehearse(args, "move", standing, existing);
    write(moved);
    return write(standing);
  }

  const cancelled = RM.supersede(existing, { state: "cancelled" });
  RM.assertValid(cancelled, "remind");
  if (args.dryRun) return rehearse(args, "cancel", cancelled, existing);
  return write(cancelled);
}

// Declared below every dry-run check on purpose, and hoisted: the only line
// that touches the log is the last thing in this file, so a reader can see at a
// glance that nothing reaches it without passing a rehearsal first.
function write(record) {
  const file = logFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, P.toJsonl(record), "utf8");
  console.log(`reminder ${record.id}: ${record.state}`);
  console.log(`  proposal ${record.proposal}, due ${RM.describeDue(record)}`);
  console.log(`  ${record.text}`);
  console.log(`  written to ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
