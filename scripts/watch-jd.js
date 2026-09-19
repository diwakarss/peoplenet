// Kural's watch: JD and every room under it, plus the governance logs. Prints
// one line per new proposal, vote, execution, question, answer or message, each
// prefixed with the organisation it came from. Runs until killed.
//
//   node scripts/watch-jd.js            # resume where the last run stopped
//   node scripts/watch-jd.js --from 0   # replay the chain from the start
//   node scripts/watch-jd.js --from 274 # replay the chain from one block
//
// --from overrides the cursor and replays blocks; the logs still start at their
// ends, which is what it has always done.
//
// Proposal 68. It used to watch AAO 2 alone, so proposal 66 went past unseen on
// JD-build -- the refused first vote, the vote, the execution, all of it. The
// organisations now come off the rule sets in read.js, so the next room is
// covered the day its rule set names its parent.
//
// It also used to start from the head of the chain and the end of every log, so
// a restart lost whatever happened while it was down. A cursor outside the
// repository holds the last block and the byte offset per log, written after
// every pass; a restart resumes from it, and --from overrides it.
//
// Everything decided here lives in governance/architect-watch.js, where it is
// tested without starting a loop.
process.env.HARDHAT_NETWORK = process.env.HARDHAT_NETWORK || "localhost";
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const R = require("../governance/read.js");
const P = require("../governance/protocol.js");
const W = require("../governance/architect-watch.js");

const ARCHITECT = R.KURAL;
const WATCH_NAME = "kural";
const GOV = path.join(__dirname, "..", "governance");
const LOGS = ["questions.jsonl", "answers.jsonl", "messages.jsonl", "drafts.jsonl",
  "wren-votes.jsonl", "builder-votes.jsonl", "kural-votes.jsonl", "kalam-votes.jsonl"];
const INTERVAL = 5000;

const fromArg = process.argv.indexOf("--from");
const CURSOR = W.cursorPath(WATCH_NAME);

function out(line) { process.stdout.write(line + "\n"); }

function title(text) {
  try { const d = JSON.parse(text); return d.title || text.slice(0, 120); } catch (e) { return text.slice(0, 120); }
}

function sizeOf(name) {
  const file = path.join(GOV, name);
  return fs.existsSync(file) ? fs.statSync(file).size : 0;
}

// Reads a log from `from` to its end and returns the records in it.
function tail(name, from) {
  const file = path.join(GOV, name);
  const size = sizeOf(name);
  if (size <= from) return { records: [], size };
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(size - from);
  fs.readSync(fd, buffer, 0, buffer.length, from);
  fs.closeSync(fd);
  return { records: P.parseJsonl(buffer.toString("utf8")).records, size };
}

async function main() {
  const facet = await ethers.getContractAt("AAOFacet", R.DIAMOND);
  const aaos = await R.readAAOs(facet);
  const { organisations, missing, ids } = W.resolve(W.topicsFor(ARCHITECT), aaos);
  if (!organisations.length) throw new Error("no organisation on this chain for " + R.labelFor(ARCHITECT));
  const topicOf = {};
  organisations.forEach((o) => { topicOf[o.id] = o.topic; });
  if (missing.length) out(`NOTE these have a rule set but no organisation on this chain: ${missing.join(", ")}`);

  const head = await ethers.provider.getBlockNumber();
  const offsets = {};
  let last;

  if (fromArg !== -1) {
    // --from is about the chain, as it always was: it replays blocks, and the
    // logs start at their ends. Rewinding the logs too would turn
    // "--from 0" into every line ever written, which is not what anyone
    // running it has meant by it.
    last = Number(process.argv[fromArg + 1]) - 1;
    LOGS.forEach((name) => { offsets[name] = sizeOf(name); });
    out(`starting at block ${last + 1}, logs from their ends (--from overrides the cursor)`);
  } else {
    const { cursor, why } = W.readCursor(CURSOR);
    if (!cursor) {
      last = head;
      LOGS.forEach((name) => { offsets[name] = sizeOf(name); });
      out(`starting at the head, block ${last + 1}: ${why}`);
    } else {
      last = cursor.block;
      LOGS.forEach((name) => {
        const where = W.offsetFor(cursor, name, sizeOf(name));
        offsets[name] = where.from;
        if (where.shrank) out(`NOTE ${name} is shorter than the cursor; reading it whole again`);
      });
      out(`resuming at block ${last + 1}, from the cursor written ${cursor.at || "at an unknown time"}`);
    }
  }

  out(`watching ${organisations.map((o) => `${o.topic} (AAO ${o.id})`).join(", ")}`);
  out(`logs: ${LOGS.join(", ")}`);
  out(`cursor: ${CURSOR}`);

  for (;;) {
    try {
      const now = await ethers.provider.getBlockNumber();
      if (now > last) {
        const range = [last + 1, now];
        for (const { id, topic } of organisations) {
          for (const l of await facet.queryFilter(facet.filters.ProposalSubmitted(id), ...range))
            out(`[${topic}] PROPOSAL #${l.args.proposalId} by ${R.labelFor(l.args.proposer)} block ${l.blockNumber}: ${title(l.args.text)}`);
          for (const l of await facet.queryFilter(facet.filters.VoteCast(id), ...range))
            out(`[${topic}] VOTE #${l.args.proposalId} ${l.args.support ? "for" : "against"} by ${R.labelFor(l.args.voter)} block ${l.blockNumber}`);
          for (const l of await facet.queryFilter(facet.filters.ProposalExecuted(id), ...range))
            out(`[${topic}] EXECUTED #${l.args.proposalId} ${l.args.passed ? "passed" : "rejected"} block ${l.blockNumber}`);
          for (const l of await facet.queryFilter(facet.filters.AAOMemberJoined(id), ...range))
            out(`[${topic}] JOINED ${R.labelFor(l.args.member)} block ${l.blockNumber}`);
        }
        last = now;
      }

      for (const name of LOGS) {
        const { records, size } = tail(name, offsets[name]);
        offsets[name] = size;
        for (const m of records) {
          if (!W.recordIsMine(m, ids)) continue;
          const where = m.aaoId === undefined || m.aaoId === null || m.aaoId === ""
            ? "all" : (topicOf[Number(m.aaoId)] || ("AAO " + m.aaoId));
          const who = m.from || m.voter || "?";
          const what = m.subject || m.text || m.reason || "";
          out(`[${where}] ${name.replace(".jsonl", "").toUpperCase()} ${who}` +
            `${m.proposal !== undefined ? " #" + m.proposal : ""}: ${what}${m.summary ? " :: " + m.summary : ""}`);
        }
      }

      // After the pass, never during it: a cursor written before the lines are
      // printed would skip them on a restart that landed in between.
      W.writeCursor(CURSOR, { block: last, offsets });
    } catch (e) {
      out(`ERROR ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

main().catch((e) => { out(`FATAL ${e.message}`); process.exit(1); });
