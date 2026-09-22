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
//
// A draft is filed once, by the architect of the organisation it was written on
// (proposal 89). The rehearsal applies both checks, so it refuses what the real
// run would refuse.
//   node scripts/wren-file-draft.js draft-abc123 \
//        --title "..." --why "..." [--technical "..."] [--risk "..."] [--effort "..."] \
//        [--summary "<more sentences after the Director's>"] [--ref X]... [--dry-run]
//
// --title and --why are required: the whole point of the format is that a person
// can read what this is and why it matters. Everything else is optional.
process.env.HARDHAT_NETWORK = process.env.HARDHAT_NETWORK || "localhost";

const fs = require("fs");
const path = require("path");
const R = require("../governance/read.js");
const P = require("../governance/protocol.js");

// hardhat is required inside main(), not here: it is heavy, it reads the
// network config, and this file is also require()d by governance/check.js for
// the one function below that has nothing to do with a chain. (proposal 54)

// The same GOVERNANCE_LOG_DIR the server honours, and the same default -- the
// draft log and the inbox beside it are one directory, so a test can point
// both somewhere safe and nothing here goes near the real record.
const GOV = process.env.GOVERNANCE_LOG_DIR
  ? path.resolve(process.env.GOVERNANCE_LOG_DIR)
  : path.join(__dirname, "..", "governance");
const DRAFTS = path.join(GOV, "drafts.jsonl");

// The images are not beside the log by default: proposal 91 keeps them outside
// the repository. Asking the same function the server asks is what makes this
// script delete the file the server actually wrote.
const IMAGE_ROOT = require("../governance/inbox-dir.js").inboxRoot().root;

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
  const out = { id: null, refs: [], dryRun: !R.wantsSend(process.argv), list: false, account: 1, doc: {} };
  const fields = ["title", "summary", "why", "technical", "risk", "effort"];
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") continue;
    else if (arg === "--list") out.list = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--send") { /* decided by wantsSend */ }
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
    // Proposal 54: say that there is a picture, and where, so it can be opened
    // before the title and the why are written. The bytes and the hash are
    // here because the file is not in git and this line is the only record
    // that it was ever the right file.
    const image = R.draftImage(d);
    if (image) {
      console.log(
        `                   image: ${path.join(IMAGE_ROOT, image.path)}  ` +
        `${R.describeBytes(image.bytes)}  ${String(image.sha256 || "").slice(0, 16)}…`
      );
    }
  }
}

// --- BEGIN proposal 54: the image is deleted as the proposal is filed -----
//
// The picture was a note to whoever had to write the title and the why. Once
// that text exists on the chain, what is left on disk is a screenshot of a
// ticket, which may carry a customer's name, an email address or a credential
// -- so it goes, and the filed record says so with the hash, which is all that
// should outlive it.
//
// Called only after the transaction has landed. It therefore never throws: a
// filing that succeeded on chain must not be reported as a failure because a
// file could not be unlinked. `rehearsal` is the whole reason for the flag --
// --dry-run says what the real run would remove and removes nothing.
//
// `unlink` is injectable so the tests can prove the deletion happens without
// going near a chain or a real filing.
function discardDraftImage(draft, options) {
  const o = options || {};
  const image = R.draftImage(draft);
  if (!image) return null;

  const file = path.join(o.dir || IMAGE_ROOT, image.path);
  if (o.rehearsal) {
    return { image: image, file: file, deleted: false, note: "rehearsal: left in place" };
  }

  const unlink = o.unlink || fs.unlinkSync;
  try {
    unlink(file);
    return { image: image, file: file, deleted: true, note: "deleted" };
  } catch (e) {
    // Already gone is still gone -- the hourly sweep may have reached it first.
    if (e && e.code === "ENOENT") {
      return { image: image, file: file, deleted: true, note: "already gone" };
    }
    return {
      image: image, file: file, deleted: false,
      note: "could NOT be deleted: " + (e && (e.code || e.message))
    };
  }
}
// --- END proposal 54 -------------------------------------------------------

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

  // Who may file this, and whether it is already filed (proposal 89). Both are
  // asked on the rehearsal path too: a dry run that says "valid, nothing filed"
  // about a draft the real run would refuse is a dry run that lies.
  // Required here rather than at the top of the file: it is heavy, it reads
  // the network config, and neither --list nor the checks above it have any
  // business needing a chain to run. (proposal 54)
  const { ethers } = require("hardhat");

  const signers = await ethers.getSigners();
  const signer = signers[args.account];
  if (!signer) throw new Error(`No Hardhat account ${args.account} on this network.`);

  const aaoFacet = await ethers.getContractAt("AAOFacet", R.DIAMOND);
  const aaoId = draft.aaoId === undefined ? R.AAO_ID : Number(draft.aaoId);
  const aao = await aaoFacet.getAAO(aaoId);
  const rules = R.rulesFor({ topic: aao.topic });

  // The log is re-read HERE, not at the top: another watcher may have filed
  // this draft in the seconds since. That is exactly how 87 and 88 happened.
  const filedNow = readLog(DRAFTS).filter((record) => record.draft === draft.id);
  const problem = R.draftFilingProblem(rules, signer.address, filedNow, { topic: aao.topic });
  if (problem) {
    console.error("");
    console.error("wren-file-draft: " + problem);
    process.exit(1);
  }

  if (!(await aaoFacet.isMember(aaoId, signer.address))) {
    throw new Error(`${signer.address} is not a member of AAO ${aaoId}.`);
  }

  if (args.dryRun) {
    console.log("");
    console.log(`would file on ${aao.topic} (AAO ${aaoId}) as ${R.labelFor(signer.address)}.`);
    // Say what the real run would delete, and delete nothing (proposal 54).
    const wouldDiscard = discardDraftImage(draft, { rehearsal: true });
    if (wouldDiscard) {
      console.log(`would delete ${wouldDiscard.file} after filing (${wouldDiscard.note}).`);
    }
    console.log("--dry-run: valid, nothing filed.");
    return;
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
    // Who actually signed, not who the script is named after. Wren is not a
    // member of JD, so every draft filed there was signed by another account
    // and the record still said "wren". --account picks the signer; this reads
    // the label back off it.
    filedBy: R.labelFor(signer.address).toLowerCase(),
    at: new Date().toISOString(),
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber
  };

  // The proposal exists now, so the picture has done its work (proposal 54).
  // The record keeps the hash, which is the only part of it that should
  // outlive the filing.
  const discarded = discardDraftImage(draft);
  if (discarded) {
    filedRecord.image_deleted = discarded.deleted;
    filedRecord.image_sha256 = discarded.image.sha256;
  }

  fs.appendFileSync(DRAFTS, P.toJsonl(filedRecord), "utf8");

  console.log("");
  console.log(`filed as proposal ${proposalId} on AAO ${aaoId} (block ${receipt.blockNumber})`);
  console.log(`draft ${draft.id} marked filed in ${path.relative(process.cwd(), DRAFTS)}`);
  if (discarded) console.log(`image ${discarded.file}: ${discarded.note}`);
}

// Required by governance/check.js for discardDraftImage, which is why main()
// only runs when this file is the one that was started. (proposal 54)
if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}

module.exports = { discardDraftImage: discardDraftImage, DRAFTS: DRAFTS, GOV: GOV };
