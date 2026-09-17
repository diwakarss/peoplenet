// Wren answers one of the Director's questions (spec section 27.2).
//
// The Director asks from the page; the question lands in governance/questions.jsonl
// within milliseconds. Wren watches that file and answers here. The page polls
// every two seconds, so the only latency the operator sees is Wren's own reading
// time -- which is the point of the channel.
//
// Usage:
//   node scripts/wren-answer.js <question-id> "<answer in plain English>"
//   node scripts/wren-answer.js q-abc123 "It only touches the cache key." --details "..."
//
//   --details "<technical>"   the part that goes below the fold on the card
//   --ref <thing>             repeatable: a ticket, commit, incident or spec entry
//   --from <who>              default "wren"
//   --list                    print the open questions and exit
//
// No chain, no gas: this writes a file. The files are the record until the
// contract can carry a comment cheaply.
const fs = require("fs");
const path = require("path");
const P = require("../governance/protocol.js");

const GOV = path.join(__dirname, "..", "governance");
const QUESTIONS = path.join(GOV, "questions.jsonl");
const ANSWERS = path.join(GOV, "answers.jsonl");

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  const { records, skipped } = P.parseJsonl(fs.readFileSync(file, "utf8"));
  if (skipped) console.warn(`${path.basename(file)}: skipped ${skipped} malformed line(s)`);
  return records;
}

function usage(message) {
  if (message) console.error(message + "\n");
  console.error('  node scripts/wren-answer.js <question-id> "<answer>" [--details "<technical>"] [--ref <r>]...');
  console.error("  node scripts/wren-answer.js --list");
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const out = { positional: [], details: "", refs: [], from: "wren", list: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--list") out.list = true;
    else if (arg === "--details") out.details = String(rest[++i] || "");
    else if (arg === "--from") out.from = String(rest[++i] || "wren");
    else if (arg === "--ref") out.refs.push(String(rest[++i] || ""));
    else if (arg === "--") continue;
    else if (arg.startsWith("--")) usage(`wren-answer: unknown option ${arg}`);
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

function listOpen(questions, answers) {
  const answered = new Set(answers.map((a) => a.question));
  if (!questions.length) {
    console.log("No questions yet.");
    return;
  }
  console.log(`${questions.length} question(s); ${questions.length - answered.size} unanswered.\n`);
  for (const q of questions) {
    const mark = answered.has(q.id) ? "answered" : "OPEN    ";
    const where = q.proposal === null || q.proposal === undefined ? "general" : `#${q.proposal}`;
    console.log(`  ${mark}  ${q.id}  ${where.padEnd(8)} ${P.typeLabel(q.type)}`);
    console.log(`            ${firstLine(q.text || q.summary, 88)}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const questions = readLog(QUESTIONS);
  const answers = readLog(ANSWERS);

  if (args.list) return listOpen(questions, answers);

  const [questionId, ...textParts] = args.positional;
  if (!questionId) usage("wren-answer: which question?");

  const question = questions.filter((q) => q.id === questionId)[0];
  if (!question) {
    usage(
      `wren-answer: no question with id "${questionId}". ` +
      "Run with --list to see the open ones."
    );
  }

  const text = textParts.join(" ").trim();
  if (!text) usage("wren-answer: an answer in plain English is required.");

  const now = new Date().toISOString();
  const message = P.normalise({
    // 27.5, the protocol envelope
    from: args.from,
    to: question.from || "director",
    type: "answer",
    subject: `Re: ${firstLine(question.subject || question.text, 80)}`,
    summary: text,
    details: args.details,
    refs: args.refs,
    ts: now,
    // 27.2, the thread's own fields
    question: question.id,
    proposal: question.proposal === undefined ? null : question.proposal,
    aaoId: question.aaoId === undefined ? 0 : question.aaoId,
    text: text,
    at: now
  }, { idPrefix: "a" });

  P.assertValid(message, "wren-answer");

  fs.mkdirSync(GOV, { recursive: true });
  fs.appendFileSync(ANSWERS, P.toJsonl(message), "utf8");

  const already = answers.filter((a) => a.question === question.id).length;
  console.log(`answered ${question.id}${already ? ` (answer ${already + 1} on this question)` : ""}`);
  console.log(`  asked:  ${firstLine(question.text || question.summary, 88)}`);
  console.log(`  answer: ${firstLine(text, 88)}`);
  if (args.details) console.log(`  details: ${args.details.length} characters, shown below the fold`);
  console.log(`  logged to ${path.relative(process.cwd(), ANSWERS)} as ${message.id}`);
  console.log("");
  console.log("The page picks it up within two seconds.");
}

try {
  main();
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
