// A builder writes its own ledger at every stop (proposal 96).
//
// The memory that matters lives outside the session, because the session ends.
// One file per agent, governance/ledger/<agent>.md, and a dated section
// appended at every stop — never edited, because a correction is a later
// section.
//
// Usage:
//   node scripts/ledger.js --agent kalam \
//     --item "proposal 99, reminders" \
//     --decided "A reminder on a closed proposal fires when that reminder closed it." \
//     --decided "The topic is read from the environment and from nowhere else." \
//     --tried "Asking triggerHasFired from the watcher; it silences real triggers." \
//     --open "94 and 98 point at 61 and 62, which are still waiting." \
//     --commit b1a6fc5
//
//   --decided, --tried, --open and --commit are repeatable; each becomes a line.
//   --list                 the sections already in this ledger
//   --dir <path>           write somewhere else (a test does this)
//   --send                 do it for real
//
// Rehearses by default, like every other write script here. What it writes is a
// file, not a transaction, and nothing on the chain moves.
const fs = require("fs");
const path = require("path");
const R = require("../governance/read.js");
const L = require("../governance/ledger.js");

const LEDGER_DIR = path.join(__dirname, "..", "governance", "ledger");

function usage(message) {
  if (message) console.error(message + "\n");
  console.error("  node scripts/ledger.js --agent <name> --item \"...\" --decided \"...\" \\");
  console.error("       --open \"...\" --commit <sha> [--tried \"...\"] [--send]");
  console.error("  node scripts/ledger.js --agent <name> --list");
  console.error("");
  console.error("The five parts a successor needs:");
  L.PARTS.forEach((p) => console.error(
    `  ${p.key.padEnd(9)} ${p.required ? "required" : "optional"}  ${p.hint}`));
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const out = {
    agent: "", item: [], decided: [], tried: [], open: [], commit: [],
    dir: LEDGER_DIR, list: false, dryRun: !R.wantsSend(process.argv)
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") continue;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--send") { /* decided by wantsSend */ }
    else if (arg === "--list") out.list = true;
    else if (arg === "--agent") out.agent = String(rest[++i] || "");
    else if (arg === "--dir") out.dir = path.resolve(String(rest[++i] || ""));
    else if (arg === "--item") out.item.push(String(rest[++i] || ""));
    else if (arg === "--decided") out.decided.push(String(rest[++i] || ""));
    else if (arg === "--tried") out.tried.push(String(rest[++i] || ""));
    else if (arg === "--open") out.open.push(String(rest[++i] || ""));
    else if (arg === "--commit") out.commit.push(String(rest[++i] || ""));
    else if (arg.startsWith("--")) usage(`ledger: unknown option ${arg}`);
    else usage(`ledger: ${arg} is not an argument. Every part has a flag.`);
  }
  return out;
}

function fileFor(args) {
  return path.join(args.dir, args.agent.toLowerCase() + ".md");
}

function listSections(args) {
  const file = fileFor(args);
  if (!fs.existsSync(file)) {
    console.log(`No ledger yet for ${L.label(args.agent)}. The first stop writes one.`);
    return;
  }
  const sections = L.sectionsIn(fs.readFileSync(file, "utf8"));
  if (!sections.length) {
    console.log(`${path.relative(process.cwd(), file)} has no dated sections yet.`);
    return;
  }
  console.log(`${sections.length} section${sections.length === 1 ? "" : "s"} in ` +
    `${path.relative(process.cwd(), file)}, oldest first:`);
  console.log("");
  sections.forEach((s) => console.log(`  ${s.date}  ${s.item}`));
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.agent) usage("ledger: --agent <name> says whose ledger this is.");
  if (args.list) return listSections(args);

  const report = {
    agent: args.agent,
    item: args.item,
    decided: args.decided,
    tried: args.tried,
    open: args.open,
    commit: args.commit,
    generation: R.generationOf(args.agent)
  };

  const problem = L.validate(report);
  if (!problem.ok) {
    console.error("ledger: this report cannot be written.\n");
    problem.errors.forEach((e) => console.error("  - " + e));
    console.error("");
    console.error("A hand-over loses what was never written down. That is why these are required.");
    process.exit(1);
  }

  const file = fileFor(args);
  const exists = fs.existsSync(file);
  const section = L.renderSection(report);

  if (args.dryRun) {
    console.log("");
    console.log(R.describePlan({
      standing: [
        `${L.label(args.agent)}, generation ${report.generation}.`,
        exists
          ? `${L.sectionsIn(fs.readFileSync(file, "utf8")).length} section(s) already there; this is appended.`
          : "There is no ledger yet, so the file is created with its header.",
        "This writes a file, not a transaction: no chain state changes."
      ],
      to: "(no transaction)",
      from: "(no account)",
      call: `append a dated section to ${L.label(args.agent)}'s ledger`,
      effect: "a successor could take the work from here without asking anyone",
      logFile: path.relative(process.cwd(), file)
    }));
    console.log("");
    console.log(section);
    return;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!exists) fs.writeFileSync(file, L.headerFor(args.agent), "utf8");
  fs.appendFileSync(file, section, "utf8");

  console.log(`${L.label(args.agent)}'s ledger: one section appended.`);
  console.log(`  ${path.relative(process.cwd(), file)}`);
  console.log("");
  console.log("Commit it. A ledger that is not committed is a ledger that is in one session.");
}

try {
  main();
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
