// Wren completes a Director's draft into the 27.1 format and files it on chain.
//
// The Director writes one free-text field and nothing else (27.12): the page
// must not stand between having the thought and writing it down. The draft lands
// in governance/drafts.jsonl. Wren reads it, supplies the title, the why and the
// technical detail, and files it -- keeping the Director's own words as the
// summary's first sentence, because they are what the Director actually meant.
//
// Usage:
//   node scripts/wren-file-draft.js --list
//   node scripts/wren-file-draft.js draft-abc123 \
//        --title "..." --why "..." [--technical "..."] [--risk "..."] [--effort "..."] \
//        [--summary "<more sentences after the Director's>"] [--ref X]... [--dry-run]
//
// --title and --why are required: the whole point of the format is that a person
// can read what this is and why it matters. Everything else is optional.
process.env.HARDHAT_NETWORK = process.env.HARDHAT_NETWORK || "localhost";

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const R = require("../governance/read.js");
const P = require("../governance/protocol.js");

const GOV = path.join(__dirname, "..", "governance");
const DRAFTS = path.join(GOV, "drafts.jsonl");

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  const { records, skipped } = P.parseJsonl(fs.readFileSync(file, "utf8"));
  if (skipped) console.warn(`${path.basename(file)}: skipped ${skipped} malformed line(s)`);
  return records;
}

function usage(message) {
  if (message) console.error(message + "\n");
  console.error('  node scripts/wren-file-draft.js <draft-id> --title "..." --why "..." [--technical "..."]');
  console.error("  node scripts/wren-file-draft.js --list");
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const out = { id: null, refs: [], dryRun: false, list: false, account: 1, doc: {} };
  const fields = ["title", "summary", "why", "technical", "risk", "effort"];
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") continue;
    else if (arg === "--list") out.list = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--ref") out.refs.push(String(rest[++i] || ""));
    else if (arg === "--account") out.account = Number(rest[++i]);
    else if (arg.startsWith("--") && fields.indexOf(arg.slice(2)) !== -1) {
      out.doc[arg.slice(2)] = String(rest[++i] || "");
    } else if (arg.startsWith("--")) usage(`wren-file-draft: unknown option ${arg}`);
    else if (out.id === null) out.id = arg;
    else usage(`wren-file-draft: unexpected argument ${arg}`);
  }
  out.refs = out.refs.filter(Boolean);
  return out;
}

// The Director's words come first, whole, and keep their full stop. Wren's extra
// sentences follow. Nothing the Director wrote is paraphrased away.
function buildSummary(directorText, wrenExtra) {
  let first = String(directorText).trim().replace(/\s+/g, " ");
  if (!/[.!?]$/.test(first)) first += ".";
  const extra = String(wrenExtra || "").trim();
  return extra ? first + " " + extra : first;
}

function serialise(doc) {
  const ordered = {};
  R.PROPOSAL_FIELDS.forEach((field) => {
    if (doc[field] !== undefined && doc[field] !== null && doc[field] !== "") ordered[field] = doc[field];
  });
  Object.keys(doc).forEach((field) => {
    if (ordered[field] === undefined && R.PROPOSAL_FIELDS.indexOf(field) === -1) ordered[field] = doc[field];
  });
  return JSON.stringify(ordered);
}

function firstLine(text, max) {
  const line = String(text).split(/\r?\n/)[0].trim();
  const limit = max || 100;
  return line.length > limit ? line.slice(0, limit - 1) + "…" : line;
}

// The log is append-only, so a draft's state is the latest record about it.
function stateOf(records, id) {
  let state = null;
  for (const r of records) {
    if (r.id !== id && r.draft !== id) continue;
    if (r.filed !== undefined || r.state === "filed") state = r;
    else if (state === null) state = r;
  }
  return state;
}

function isFiled(records, id) {
  return records.some((r) => (r.draft === id || r.id === id) && (r.state === "filed" || r.proposalId !== undefined));
}

function listDrafts(records) {
  const originals = records.filter((r) => r.text !== undefined && r.state !== "filed");
  if (!originals.length) {
    console.log("No drafts.");
    return;
  }
  const waiting = originals.filter((d) => !isFiled(records, d.id));
  console.log(`${originals.length} draft(s); ${waiting.length} awaiting Wren.\n`);
  for (const d of originals) {
    const filedRecord = records.filter((r) => r.draft === d.id && r.state === "filed")[0];
    const mark = filedRecord ? `filed as ${filedRecord.proposalId}` : "AWAITING WREN";
    console.log(`  ${mark.padEnd(16)} ${d.id}  AAO ${d.aaoId}  ${d.at}`);
    console.log(`                   ${firstLine(d.text, 92)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const records = readLog(DRAFTS);

  if (args.list) return listDrafts(records);
  if (!args.id) usage("wren-file-draft: which draft?");

  const draft = records.filter((r) => r.id === args.id && r.text !== undefined)[0];
  if (!draft) usage(`wren-file-draft: no draft with id "${args.id}". Run with --list.`);
  if (isFiled(records, draft.id)) {
    const filed = records.filter((r) => r.draft === draft.id && r.state === "filed")[0];
    usage(`wren-file-draft: draft ${draft.id} was already filed as proposal ${filed.proposalId}.`);
  }

  const doc = {
    title: (args.doc.title || "").trim(),
    summary: buildSummary(draft.text, args.doc.summary),
    why: (args.doc.why || "").trim(),
    technical: (args.doc.technical || "").trim(),
    risk: (args.doc.risk || "").trim(),
    effort: (args.doc.effort || "").trim(),
    refs: args.refs.concat(["draft " + draft.id]),
    from: "director",          // the proposal is the Director's; Wren only shaped it
    filed_at: new Date().toISOString(),
    drafted_by: "director",
    completed_by: "wren"
  };
  Object.keys(doc).forEach((k) => {
    if (doc[k] === "" || (Array.isArray(doc[k]) && !doc[k].length)) delete doc[k];
  });

  const result = R.validateProposalDoc(doc);
  if (!result.ok) {
    console.error("wren-file-draft: refusing to file this proposal.\n");
    result.errors.forEach((e) => console.error("  - " + e));
    console.error("");
    console.error("A draft needs a --title and a --why from Wren. The Director already");
    console.error("supplied the summary; do not paraphrase it away.");
    process.exit(1);
  }

  console.log(`draft   ${draft.id}  (${draft.at})`);
  console.log(`director's words: ${firstLine(draft.text, 92)}`);
  console.log("");
  console.log(`title:   ${doc.title}`);
  console.log(`summary: ${firstLine(doc.summary, 110)}`);
  console.log(`why:     ${doc.why}`);

  // The Director's text must survive verbatim into the summary.
  const kept = String(draft.text).trim().replace(/\s+/g, " ");
  const keptCore = kept.replace(/[.!?]$/, "");
  if (doc.summary.indexOf(keptCore) !== 0) {
    throw new Error("the Director's words are not the first sentence of the summary; refusing to file");
  }

  if (args.dryRun) {
    console.log("\n--dry-run: valid, nothing filed.");
    return;
  }

  const signers = await ethers.getSigners();
  const signer = signers[args.account];
  if (!signer) throw new Error(`No Hardhat account ${args.account} on this network.`);

  const aaoFacet = await ethers.getContractAt("AAOFacet", R.DIAMOND);
  const aaoId = draft.aaoId === undefined ? R.AAO_ID : Number(draft.aaoId);
  if (!(await aaoFacet.isMember(aaoId, signer.address))) {
    throw new Error(`${signer.address} is not a member of AAO ${aaoId}.`);
  }

  const tx = await aaoFacet.connect(signer).submitProposal(aaoId, serialise(doc));
  const receipt = await tx.wait();
  const log = receipt.logs
    .map((l) => { try { return aaoFacet.interface.parseLog(l); } catch (e) { return null; } })
    .find((p) => p && p.name === "ProposalSubmitted");
  const proposalId = log ? Number(log.args.proposalId) : null;
  if (proposalId === null) throw new Error("submitProposal did not emit ProposalSubmitted.");

  // Mark the draft filed. Append-only: the original line stays exactly as the
  // Director wrote it, and this record says what became of it.
  const filedRecord = {
    id: P.newId("filed"),
    draft: draft.id,
    state: "filed",
    proposalId: proposalId,
    aaoId: aaoId,
    filedBy: "wren",
    at: new Date().toISOString(),
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber
  };
  fs.appendFileSync(DRAFTS, P.toJsonl(filedRecord), "utf8");

  console.log("");
  console.log(`filed as proposal ${proposalId} on AAO ${aaoId} (block ${receipt.blockNumber})`);
  console.log(`draft ${draft.id} marked filed in ${path.relative(process.cwd(), DRAFTS)}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
