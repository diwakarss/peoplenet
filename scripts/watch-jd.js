// Watches the JD AAO (id 2) and the governance logs. Prints one line per new
// proposal, vote, execution, question, answer or message. Runs until killed.
//
//   node scripts/watch-jd.js            # from block now, tail the logs
//   node scripts/watch-jd.js --from 0   # replay history first
process.env.HARDHAT_NETWORK = process.env.HARDHAT_NETWORK || "localhost";
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const R = require("../governance/read.js");
const P = require("../governance/protocol.js");

const AAO = 2;
const GOV = path.join(__dirname, "..", "governance");
const LOGS = ["questions.jsonl", "answers.jsonl", "messages.jsonl", "drafts.jsonl", "wren-votes.jsonl", "builder-votes.jsonl"];
const fromArg = process.argv.indexOf("--from");
const INTERVAL = 5000;

function out(line) { process.stdout.write(line + "\n"); }

function title(text) {
  try { const d = JSON.parse(text); return d.title || text.slice(0, 120); } catch (e) { return text.slice(0, 120); }
}

async function main() {
  const f = await ethers.getContractAt("AAOFacet", R.DIAMOND);
  let last = fromArg !== -1 ? Number(process.argv[fromArg + 1]) - 1 : await ethers.provider.getBlockNumber();
  const sizes = {};
  for (const name of LOGS) {
    const p = path.join(GOV, name);
    sizes[name] = fs.existsSync(p) ? fs.statSync(p).size : 0;
  }
  out(`watching AAO ${AAO} from block ${last + 1}; logs: ${LOGS.join(", ")}`);

  for (;;) {
    try {
      const head = await ethers.provider.getBlockNumber();
      if (head > last) {
        const range = [last + 1, head];
        for (const l of await f.queryFilter(f.filters.ProposalSubmitted(AAO), ...range))
          out(`PROPOSAL #${l.args.proposalId} by ${R.labelFor(l.args.proposer)} block ${l.blockNumber}: ${title(l.args.text)}`);
        for (const l of await f.queryFilter(f.filters.VoteCast(AAO), ...range))
          out(`VOTE #${l.args.proposalId} ${l.args.support ? "for" : "against"} by ${R.labelFor(l.args.voter)} block ${l.blockNumber}`);
        for (const l of await f.queryFilter(f.filters.ProposalExecuted(AAO), ...range))
          out(`EXECUTED #${l.args.proposalId} ${l.args.passed ? "passed" : "rejected"} block ${l.blockNumber}`);
        for (const l of await f.queryFilter(f.filters.AAOMemberJoined(AAO), ...range))
          out(`JOINED ${R.labelFor(l.args.member)} block ${l.blockNumber}`);
        last = head;
      }
      for (const name of LOGS) {
        const p = path.join(GOV, name);
        if (!fs.existsSync(p)) continue;
        const size = fs.statSync(p).size;
        if (size <= sizes[name]) { sizes[name] = size; continue; }
        const fd = fs.openSync(p, "r");
        const buf = Buffer.alloc(size - sizes[name]);
        fs.readSync(fd, buf, 0, buf.length, sizes[name]);
        fs.closeSync(fd);
        sizes[name] = size;
        for (const m of P.parseJsonl(buf.toString("utf8")).records) {
          if (m.aaoId !== undefined && Number(m.aaoId) !== AAO) continue;
          const who = m.from || m.voter || "?";
          const what = m.subject || m.text || m.reason || "";
          out(`${name.replace(".jsonl", "").toUpperCase()} ${who}${m.proposal !== undefined ? " #" + m.proposal : ""}: ${what}${m.summary ? " :: " + m.summary : ""}`);
        }
      }
    } catch (e) {
      out(`ERROR ${e.message}`);
    }
    await new Promise(r => setTimeout(r, INTERVAL));
  }
}

main().catch(e => { out(`FATAL ${e.message}`); process.exit(1); });
