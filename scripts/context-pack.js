// The pack a builder is handed for one item (proposal 96).
//
//   node scripts/context-pack.js 99
//
// Prints the proposal, everything said on it, the files it names, who else
// touches the symbols it names, and the rules attached to the capabilities it
// will use. A builder starts from this and not from the repository: reading
// everything is how a context fills before the work does.
//
// Where the callers come from is said out loud. gbrain's code index answers
// when it is built for this repository; when it is not, this greps the
// repository instead and says so, because a pack that quietly changed its
// source would be a pack whose gaps nobody could see.
//
//   --no-brain     skip gbrain and grep
//   --files-only   just the file list, for piping
//
// Read-only. It touches no log, no chain and no server.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const P = require("../governance/protocol.js");
const R = require("../governance/read.js");
const C = require("../governance/context-pack.js");

const REPO = path.join(__dirname, "..");
const GOV = path.join(REPO, "governance");

function usage(message) {
  if (message) console.error(message + "\n");
  console.error("  node scripts/context-pack.js <proposal> [--no-brain] [--files-only]");
  process.exit(message ? 1 : 0);
}

function readLog(name) {
  const file = path.join(GOV, name);
  if (!fs.existsSync(file)) return [];
  return P.parseJsonl(fs.readFileSync(file, "utf8")).records;
}

async function readProposal(id) {
  const { ethers } = require("ethers");
  const provider = new ethers.JsonRpcProvider(R.RPC_URL);
  const contract = R.getContract(ethers, provider);
  const raw = await contract.getProposal(BigInt(id));
  const text = String(raw.text || "");
  let doc = null;
  try { doc = JSON.parse(text); } catch (e) { doc = null; }
  return {
    id: Number(raw.id),
    aaoId: Number(raw.aaoId),
    status: Number(raw.status),
    forVotes: Number(raw.forVotes),
    againstVotes: Number(raw.againstVotes),
    text: text,
    format: doc ? { doc: doc } : null
  };
}

// --- who else touches this symbol ---------------------------------------

// gbrain's code index, when it is built for this repository. `not_built` is a
// real answer and not a failure: the index simply has not been made, and the
// pack says so rather than printing an empty section that reads as "nobody
// calls this".
function fromBrain(symbol) {
  let out;
  try {
    out = execFileSync("gbrain", ["code-refs", symbol, "--json"], {
      encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"]
    });
  } catch (e) {
    return { ok: false, why: "gbrain did not answer" };
  }
  const start = out.indexOf("{");
  if (start === -1) return { ok: false, why: "gbrain answered with no JSON" };
  let parsed;
  try { parsed = JSON.parse(out.slice(start)); } catch (e) {
    return { ok: false, why: "gbrain's answer could not be read" };
  }
  if (parsed.status === "not_built" || parsed.ready === false) {
    return { ok: false, why: "gbrain's code index is not built for this repository" };
  }
  return { ok: true, hits: (parsed.results || []).map((r) => r.path || r.slug || String(r)) };
}

// The fallback, and an honest one: git grep over the tracked files only, so
// ui/.next and node_modules do not drown the answer.
function fromGrep(symbol) {
  try {
    const out = execFileSync("git", ["grep", "-l", "--", symbol], {
      cwd: REPO, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"]
    });
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    // git grep exits 1 when it matches nothing, which is an answer.
    return [];
  }
}

function heading(text) {
  console.log("");
  console.log(text);
  console.log("-".repeat(text.length));
}

function firstLine(text, max) {
  const line = String(text || "").split(/\r?\n/)[0].trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

async function main() {
  const argv = process.argv.slice(2);
  const noBrain = argv.includes("--no-brain");
  const filesOnly = argv.includes("--files-only");
  const id = Number(argv.filter((a) => !a.startsWith("--"))[0]);
  if (!Number.isInteger(id) || id < 0) usage("context-pack: which proposal?");

  let proposal;
  try {
    proposal = await readProposal(id);
  } catch (e) {
    console.error(`context-pack: could not read proposal ${id} from ${R.RPC_URL}.`);
    console.error("        Start the node, or run npm run up.");
    process.exit(1);
  }

  const prose = C.proseOf(proposal);
  // A bare "protocol.js" is resolved against the directories this repository
  // keeps its code in, and dropped when it is in none of them.
  const files = C.filesNamedIn(prose, (name) => {
    for (const dir of C.SEARCHED) {
      if (fs.existsSync(path.join(REPO, dir, name))) return dir + "/" + name;
    }
    return null;
  });

  if (filesOnly) {
    files.forEach((f) => console.log(f));
    return;
  }

  const doc = proposal.format && proposal.format.doc;
  console.log("");
  console.log(`Context pack for proposal ${id}`);
  console.log(`AAO ${proposal.aaoId} · ${["Active", "Executed", "Rejected"][proposal.status] || proposal.status}` +
    ` · ${proposal.forVotes} for, ${proposal.againstVotes} against`);

  heading("The proposal");
  if (doc) {
    console.log(doc.title || "(no title)");
    console.log("");
    console.log(doc.summary || "");
    if (doc.why) { console.log(""); console.log("Why: " + doc.why); }
    if (doc.technical) { console.log(""); console.log("Technical: " + doc.technical); }
    if (doc.risk) { console.log(""); console.log("Risk: " + doc.risk); }
  } else {
    console.log(proposal.text);
  }

  heading("What was said on it");
  const said = C.saidOn(
    readLog("questions.jsonl").concat(readLog("answers.jsonl")).concat(readLog("messages.jsonl")),
    id);
  if (!said.length) {
    console.log("Nothing. Nobody has asked or decided anything on this proposal.");
  } else {
    said.forEach((m) => {
      console.log(`  ${String(m.ts || "").slice(0, 16).padEnd(17)} ${String(m.type).padEnd(10)} ` +
        `${String(m.from).padEnd(9)} ${firstLine(m.summary || m.text, 90)}`);
    });
  }

  heading("The files it names");
  if (!files.length) {
    console.log("None. The proposal names no path, so start from the capabilities below.");
  } else {
    files.forEach((f) => {
      const full = path.join(REPO, f);
      const there = fs.existsSync(full);
      const lines = there ? fs.readFileSync(full, "utf8").split(/\r?\n/).length : 0;
      console.log(`  ${f.padEnd(40)} ${there ? lines + " lines" : "does not exist yet"}`);
    });
  }

  const symbols = C.symbolsNamedIn(prose);
  if (symbols.length) {
    heading("Who else touches what it names");
    let source = null;
    symbols.forEach((symbol) => {
      let hits = [];
      if (!noBrain && source !== "grep") {
        const brain = fromBrain(symbol);
        if (brain.ok) { source = "gbrain's code index"; hits = brain.hits; }
        else { source = "grep"; console.log(`  (${brain.why}; grepping the repository instead)`); }
      }
      if (source !== "gbrain's code index") hits = fromGrep(symbol);
      console.log(`  ${symbol}()`);
      if (!hits.length) console.log("      nothing else names it");
      hits.slice(0, 8).forEach((h) => console.log("      " + h));
    });
    console.log("");
    console.log(`Source: ${source === "gbrain's code index" ? "gbrain's code index" : "a grep of the repository"}.`);
  }

  heading("The rules on what it will touch");
  const capabilities = C.capabilitiesFor(prose, files);
  if (!capabilities.length) {
    console.log("None matched. Read governance/ledger/<your name>.md before you start anyway.");
  }
  capabilities.forEach((capability) => {
    console.log("");
    console.log("  " + capability.label);
    capability.rules.forEach((rule) => {
      console.log("    - " + rule.rule);
      if (rule.because) console.log("      " + rule.because);
      console.log("      " + rule.source);
    });
  });

  console.log("");
  console.log("Start here. Reading the rest of the repository is how a context fills");
  console.log("before the work does.");
  console.log("");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
