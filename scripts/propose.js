// File a proposal in the 27.1 format on an AAO.
//
// Every proposal, from whichever agent, is a JSON document stored as the
// on-chain text: title, summary, why, technical, risk, effort, refs, from,
// filed_at. The first three are required and this script refuses without them --
// a proposal nobody can read in plain English is not ready to be voted on.
//
// Usage:
//   node scripts/propose.js --file proposal.json [--aao 0] [--account 0]
//   node scripts/propose.js --title "..." --summary "..." --why "..." \
//        [--technical "..."] [--risk "..."] [--effort "..."] [--ref X]... \
//        [--from builder] [--aao 0] [--account 0]
//   node scripts/propose.js --file proposal.json --dry-run    # validate only
//
// --account is the Hardhat account index that signs: 0 Director, 1 Wren,
// 3 builder, 4 widget. The network defaults to localhost.
process.env.HARDHAT_NETWORK = process.env.HARDHAT_NETWORK || "localhost";

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const R = require("../governance/read.js");

const FROM_BY_ACCOUNT = { 0: "director", 1: "wren", 3: "builder", 4: "widget" };

function usage(message) {
  if (message) console.error(message + "\n");
  console.error("  node scripts/propose.js --file proposal.json [--aao 0] [--account 0]");
  console.error('  node scripts/propose.js --title "..." --summary "..." --why "..." [--technical "..."]');
  console.error("");
  console.error("Required in every proposal: title, summary, why.");
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const out = { refs: [], aao: R.AAO_ID, account: 0, dryRun: !R.wantsSend(process.argv), file: null, doc: {} };
  const rest = argv.slice(2);
  const stringFields = ["title", "summary", "why", "technical", "risk", "effort", "from"];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") continue;
    if (arg === "--dry-run") { out.dryRun = true; continue; }
    if (arg === "--send") { continue; }
    if (arg === "--file") { out.file = String(rest[++i] || ""); continue; }
    if (arg === "--aao") { out.aao = Number(rest[++i]); continue; }
    if (arg === "--account") { out.account = Number(rest[++i]); continue; }
    if (arg === "--ref") { out.refs.push(String(rest[++i] || "")); continue; }
    const field = arg.replace(/^--/, "");
    if (arg.startsWith("--") && stringFields.indexOf(field) !== -1) {
      out.doc[field] = String(rest[++i] || "");
      continue;
    }
    usage(`propose: unknown option ${arg}`);
  }
  out.refs = out.refs.filter(Boolean);
  return out;
}

function buildDoc(args) {
  let doc = {};
  if (args.file) {
    const target = path.resolve(process.cwd(), args.file);
    if (!fs.existsSync(target)) usage(`propose: no such file ${target}`);
    try {
      doc = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (e) {
      usage(`propose: ${args.file} is not valid JSON (${e.message})`);
    }
  }
  // Flags win over the file, so a file can be a template.
  Object.keys(args.doc).forEach((k) => { doc[k] = args.doc[k]; });
  if (args.refs.length) doc.refs = (doc.refs || []).concat(args.refs);
  if (!doc.from) doc.from = FROM_BY_ACCOUNT[args.account] || "director";
  if (!doc.filed_at) doc.filed_at = new Date().toISOString();
  if (doc.refs === undefined) doc.refs = [];
  return doc;
}

// The on-chain text: the document itself, with the fields in a fixed order so a
// diff of two proposals reads cleanly.
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

async function main() {
  const args = parseArgs(process.argv);
  const doc = buildDoc(args);

  const result = R.validateProposalDoc(doc);
  if (!result.ok) {
    console.error("propose: refusing to file this proposal.\n");
    result.errors.forEach((e) => console.error("  - " + e));
    console.error("");
    console.error("A proposal needs a title, a plain-English summary and a why. The");
    console.error("technical detail can wait; the reason a person should care cannot.");
    process.exit(1);
  }

  const text = serialise(doc);
  console.log(`title:    ${doc.title}`);
  console.log(`summary:  ${doc.summary}`);
  console.log(`why:      ${doc.why}`);
  console.log(`from:     ${doc.from}`);
  console.log(`on-chain: ${text.length} bytes`);

  if (args.dryRun) {
    console.log("\n--dry-run: valid, nothing filed.");
    return;
  }

  const signers = await ethers.getSigners();
  const signer = signers[args.account];
  if (!signer) throw new Error(`No Hardhat account ${args.account} on this network.`);

  const aaoFacet = await ethers.getContractAt("AAOFacet", R.DIAMOND);
  if (!(await aaoFacet.isMember(args.aao, signer.address))) {
    throw new Error(
      `${signer.address} is not a member of AAO ${args.aao}; only members may file a proposal.`
    );
  }

  const tx = await aaoFacet.connect(signer).submitProposal(args.aao, text);
  const receipt = await tx.wait();
  const log = receipt.logs
    .map((l) => { try { return aaoFacet.interface.parseLog(l); } catch (e) { return null; } })
    .find((p) => p && p.name === "ProposalSubmitted");
  const id = log ? Number(log.args.proposalId) : "?";

  console.log("");
  console.log(`filed as proposal ${id} on AAO ${args.aao} by ${R.labelFor(signer.address)}`);
  console.log(`tx ${receipt.hash} (block ${receipt.blockNumber})`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
