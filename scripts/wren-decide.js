// Wren posts a decision about a proposal: where it has got to (27.9), or that
// something else solved it (27.12 (3)).
//
// A proposal the Director executes is a build item within the hour. The page
// should say so without anyone having to ask, so Wren posts one plain-English
// line as it moves and the card shows an adoption chip read from the words:
//
//   queued                  it is on the standing channel, in vote order
//   building                the builder has started
//   built in commit <x>     the code exists
//   in the widget           it is live after the restart
//   closed: solved by <x>   another item solved it on the way
//
// Usage:
//   node scripts/wren-decide.js <proposal> "<what happened, in plain English>"
//   node scripts/wren-decide.js 16 "queued behind S12; the builder starts tomorrow."
//   node scripts/wren-decide.js 16 "built in commit 4ebb5a5, in the widget after the next restart."
//   node scripts/wren-decide.js 3 "closed: solved by the shared mtime_cache helper in commit 83bc522."
//
//   --details "<technical>"   below the fold on the card
//   --ref <thing>             repeatable; the proposal ref is added for you
//   --from <who>              default "wren"
//   --list                    the decisions so far, newest last
//
// No chain and no gas: this appends to governance/messages.jsonl, which the
// page reads every two seconds.
const fs = require("fs");
const path = require("path");
const P = require("../governance/protocol.js");
const A = require("../governance/adoption.js");

const GOV = path.join(__dirname, "..", "governance");
const MESSAGES = path.join(GOV, "messages.jsonl");

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  const { records, skipped } = P.parseJsonl(fs.readFileSync(file, "utf8"));
  if (skipped) console.warn(`${path.basename(file)}: skipped ${skipped} malformed line(s)`);
  return records;
}

function usage(message) {
  if (message) console.error(message + "\n");
  console.error('  node scripts/wren-decide.js <proposal> "<what happened>" [--details "..."] [--ref X]');
  console.error("  node scripts/wren-decide.js --list");
  console.error("");
  console.error("The state is read from your words. These are the phrases that carry it:");
  A.STATES.forEach((s) => console.error(`  ${s.label.padEnd(22)} ${s.hint}`));
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const out = { positional: [], details: "", refs: [], from: "wren", aaoId: 0, list: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") continue;
    else if (arg === "--list") out.list = true;
    else if (arg === "--details") out.details = String(rest[++i] || "");
    else if (arg === "--from") out.from = String(rest[++i] || "wren");
    else if (arg === "--aao") out.aaoId = Number(rest[++i]);
    else if (arg === "--ref") out.refs.push(String(rest[++i] || ""));
    else if (arg.startsWith("--")) usage(`wren-decide: unknown option ${arg}`);
    else out.positional.push(arg);
  }
  out.refs = out.refs.filter(Boolean);
  return out;
}

function firstLine(text, max) {
  const line = String(text).split(/\r?\n/)[0].trim();
  const limit = max || 100;
  return line.length > limit ? line.slice(0, limit - 1) + "…" : line;
}

function listDecisions(messages) {
  const decisions = messages.filter((m) => m.type === "decision");
  if (!decisions.length) {
    console.log("No decisions yet.");
    return;
  }
  const byProposal = A.indexDecisions(decisions);
  console.log(`${decisions.length} decision(s) across ${Object.keys(byProposal).length} proposal(s).\n`);
  Object.keys(byProposal)
    .map(Number)
    .sort((a, b) => a - b)
    .forEach((id) => {
      const latest = byProposal[id];
      const state = A.stateOf(latest);
      console.log(`  #${String(id).padEnd(4)} ${state.label.padEnd(22)} ${firstLine(latest.summary, 76)}`);
    });
}

function main() {
  const args = parseArgs(process.argv);
  const messages = readLog(MESSAGES);

  if (args.list) return listDecisions(messages);

  const [rawId, ...textParts] = args.positional;
  if (rawId === undefined) usage("wren-decide: which proposal?");
  const proposal = Number(rawId);
  if (!Number.isInteger(proposal) || proposal < 0) {
    usage(`wren-decide: "${rawId}" is not a proposal id.`);
  }

  const text = textParts.join(" ").trim();
  if (!text) usage("wren-decide: say in plain English what happened.");

  const state = A.stateOf({ summary: text });
  if (state.key === "unknown") {
    console.error("wren-decide: those words do not say where the proposal has got to.\n");
    console.error("Use one of these phrases, so the card can show a state:");
    A.STATES.forEach((s) => console.error(`  ${s.label.padEnd(22)} ${s.hint}`));
    console.error("");
    console.error(`You wrote: ${text}`);
    process.exit(1);
  }

  const message = P.normalise({
    from: args.from,
    to: "director",
    type: "decision",
    subject: `Proposal ${proposal}: ${state.label}`,
    summary: text,
    details: args.details,
    refs: [`proposal ${proposal}`].concat(args.refs),
    proposal: proposal,
    aaoId: args.aaoId
  }, { idPrefix: "decision" });

  P.assertValid(message, "wren-decide");

  fs.mkdirSync(GOV, { recursive: true });
  fs.appendFileSync(MESSAGES, P.toJsonl(message), "utf8");

  console.log(`proposal ${proposal}: ${state.label}`);
  console.log(`  ${text}`);
  if (args.details) console.log(`  details: ${args.details.length} characters, below the fold`);
  console.log(`  logged to ${path.relative(process.cwd(), MESSAGES)} as ${message.id}`);
  console.log("");
  console.log("The card shows it within two seconds.");
}

try {
  main();
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
