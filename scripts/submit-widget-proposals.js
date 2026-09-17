// Files the trilogy widget builder's suggestions as proposals on AAO 0.
//
//   node scripts/submit-widget-proposals.js            (reads proposals.json next to it)
//   node scripts/submit-widget-proposals.js --dry-run  (validate, file nothing)
//   node scripts/submit-widget-proposals.js --file other.json --aao 1
//
// Since 27.1 every entry in proposals.json must be a proposal document with at
// least title, summary and why. Free text is refused, with a pointer at
// scripts/propose.js. The free-text proposals already on chain stay exactly as
// they are and the page marks them "legacy format"; nothing is re-filed.
process.env.HARDHAT_NETWORK = process.env.HARDHAT_NETWORK || "localhost";

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const R = require("../governance/read.js");

function parseArgs(argv) {
  const out = {
    file: path.join(__dirname, "proposals.json"),
    aao: R.AAO_ID,
    account: 0,
    dryRun: !R.wantsSend(argv)
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") continue;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--send") { /* the default is a rehearsal; wantsSend decides */ }
    else if (arg === "--file") out.file = path.resolve(process.cwd(), String(rest[++i] || ""));
    else if (arg === "--aao") out.aao = Number(rest[++i]);
    else if (arg === "--account") out.account = Number(rest[++i]);
    else {
      console.error(`submit-widget-proposals: unknown option ${arg}`);
      process.exit(1);
    }
  }
  return out;
}

// Turn one entry into a document, or explain why it is not one.
function asDocument(entry, index) {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    if (trimmed.charAt(0) === "{") {
      try {
        return { doc: JSON.parse(trimmed) };
      } catch (e) {
        return { errors: [`entry ${index} looks like JSON but does not parse: ${e.message}`] };
      }
    }
    return {
      errors: [
        `entry ${index} is free text, which 27.1 no longer accepts:`,
        `  "${trimmed.slice(0, 72)}${trimmed.length > 72 ? "…" : ""}"`,
        "  Give it a title, a plain-English summary and a why, or file it with",
        "  scripts/propose.js. The free-text proposals already on chain stay as",
        "  they are; nothing is re-filed."
      ]
    };
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) return { doc: entry };
  return { errors: [`entry ${index} is neither a proposal document nor JSON text`] };
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

async function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.file)) throw new Error(`No such file: ${args.file}`);

  const list = JSON.parse(fs.readFileSync(args.file, "utf8"));
  if (!Array.isArray(list)) throw new Error(`${args.file} must hold a JSON array of proposals.`);

  // Validate the whole file before filing anything: a half-filed batch is worse
  // than a refused one.
  const ready = [];
  const problems = [];
  list.forEach((entry, index) => {
    const { doc, errors } = asDocument(entry, index);
    if (errors) return problems.push(errors.join("\n"));
    if (!doc.from) doc.from = "builder";
    if (!doc.filed_at) doc.filed_at = new Date().toISOString();
    const result = R.validateProposalDoc(doc);
    if (!result.ok) {
      return problems.push(
        `entry ${index} ("${String(doc.title || "").slice(0, 50)}"):\n  - ` + result.errors.join("\n  - ")
      );
    }
    ready.push(doc);
  });

  if (problems.length) {
    console.error(`Refusing to file: ${problems.length} of ${list.length} entries are not 27.1 proposals.\n`);
    problems.forEach((p) => console.error(p + "\n"));
    process.exit(1);
  }

  console.log(`${ready.length} proposal(s) valid.`);
  if (args.dryRun) {
    ready.forEach((doc, i) => console.log(`  ${i}  ${doc.title}`));
    console.log("\n--dry-run: nothing filed.");
    return;
  }

  const signers = await ethers.getSigners();
  const signer = signers[args.account];
  if (!signer) throw new Error(`No Hardhat account ${args.account} on this network.`);

  const aaoFacet = await ethers.getContractAt("AAOFacet", R.DIAMOND);
  if (!(await aaoFacet.isMember(args.aao, signer.address))) {
    throw new Error(`${signer.address} is not a member of AAO ${args.aao}.`);
  }

  for (const doc of ready) {
    const tx = await aaoFacet.connect(signer).submitProposal(args.aao, serialise(doc));
    const receipt = await tx.wait();
    const log = receipt.logs
      .map((l) => { try { return aaoFacet.interface.parseLog(l); } catch (e) { return null; } })
      .find((p) => p && p.name === "ProposalSubmitted");
    const id = log ? Number(log.args.proposalId) : "?";
    console.log(`proposal ${id} | ${doc.title}`);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
