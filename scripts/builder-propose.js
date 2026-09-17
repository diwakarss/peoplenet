// The standing builder files a proposal on the "widget-builder" sub-AAO when it is
// unsure (learning-assist spec sections 25, 27.1 and 27.4).
//
// "Unsure" means: two defensible readings of a spec entry, a change that would touch
// something another builder owns, or a fix whose blast radius the builder cannot bound.
// The proposal is how the builder asks without stopping; Wren votes, the Director may.
//
// The text is section 27.1's proposal document, not free prose: title, summary in plain
// English, why, and the technical detail underneath. A proposal without a title, a
// summary and a why is refused here, before it reaches the chain, because a proposal a
// human cannot read cannot be voted on.
//
// Usage:
//   node scripts/builder-propose.js "Title | plain-English summary | why"
//   node scripts/builder-propose.js --file proposal.json
//   node scripts/builder-propose.js --title "..." --summary "..." --why "..." \
//        [--technical "..."] [--risk "..."] [--effort "..."] [--refs a,b] [--dry]
//
// Runs through Hardhat so it can sign as the builder (account 3):
//   npx hardhat run scripts/builder-propose.js --network localhost -- "Title | summary | why"

const fs = require("fs");
const path = require("path");

const DIAMOND = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const TOPIC = "widget-builder";
const BUILDER_ACCOUNT = 3;

function parseArgs(argv) {
  const out = { refs: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") { out.dry = true; continue; }
    if (a === "--file") { out.file = argv[++i]; continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[++i];
      if (key === "refs") out.refs = String(val || "").split(",").map(s => s.trim()).filter(Boolean);
      else out[key] = val;
      continue;
    }
    rest.push(a);
  }
  if (!out.title && rest.length) {
    // "Title | summary | why" -- the shortest form, for the common case.
    const parts = rest.join(" ").split("|").map(s => s.trim());
    out.title = parts[0] || "";
    out.summary = parts[1] || "";
    out.why = parts[2] || "";
    if (parts.length > 3) out.technical = parts.slice(3).join(" | ");
  }
  return out;
}

// Section 27.1, and it must match protocol.py's validate_proposal exactly.
function buildDoc(a) {
  const doc = {
    title: (a.title || "").trim(),
    summary: (a.summary || "").trim(),
    why: (a.why || "").trim(),
    technical: a.technical || "",
    risk: (a.risk || "unknown").trim(),
    effort: (a.effort || "unknown").trim(),
    refs: a.refs || [],
    from: "builder",
    filed_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
  };
  const missing = ["title", "summary", "why"].filter(k => !doc[k]);
  if (missing.length) {
    throw new Error(
      `a proposal needs ${missing.join(", ")}. The summary is PLAIN ENGLISH, two to four ` +
      `sentences, written for a person; the technical detail goes in --technical.`);
  }
  return doc;
}

async function main() {
  const argv = process.argv.slice(2).filter(a => a !== "--");
  const args = parseArgs(argv);
  const doc = args.file
    ? buildDoc(JSON.parse(fs.readFileSync(path.resolve(args.file), "utf8")))
    : buildDoc(args);
  const text = JSON.stringify(doc);

  console.log(`title:   ${doc.title}`);
  console.log(`summary: ${doc.summary}`);
  console.log(`why:     ${doc.why}`);
  if (doc.refs.length) console.log(`refs:    ${doc.refs.join(", ")}`);
  console.log("");

  if (args.dry) {
    console.log("--dry: nothing was sent. The document above is what would be filed.");
    return;
  }

  const { ethers } = require("hardhat");
  const signers = await ethers.getSigners();
  const builder = signers[BUILDER_ACCOUNT];
  if (!builder) throw new Error(`Need at least ${BUILDER_ACCOUNT + 1} accounts on this network.`);
  const aaoFacet = await ethers.getContractAt("AAOFacet", DIAMOND);

  const deployer = signers[0];
  const ids = await aaoFacet.getAAOsByCreator(deployer.address);
  let aaoId = null;
  for (const id of ids) {
    const a = await aaoFacet.getAAO(id);
    if (a.topic === TOPIC) { aaoId = ethers.toNumber(id); break; }
  }
  if (aaoId === null) {
    throw new Error(`no "${TOPIC}" AAO on this chain. Run scripts/create-widget-builder-aao.js first.`);
  }
  if (!(await aaoFacet.isMember(aaoId, builder.address))) {
    throw new Error(`account ${BUILDER_ACCOUNT} is not a member of AAO ${aaoId}. ` +
                    `Run scripts/create-widget-builder-aao.js first.`);
  }

  const tx = await aaoFacet.connect(builder).submitProposal(aaoId, text);
  const rc = await tx.wait();
  const ev = rc.logs.find(l => l.topics[0] === ethers.id("ProposalSubmitted(uint256,uint256,address,string)"))
          || rc.logs.find(l => l.topics.length > 1);
  const id = ev ? ethers.toNumber(ev.topics[1]) : "?";
  console.log(`filed proposal ${id} on AAO ${aaoId} ("${TOPIC}") as the builder (account ${BUILDER_ACCOUNT}).`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
