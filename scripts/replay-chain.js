// Moves the governance record from one chain to another (proposal 50).
//
// Every AAO, member, proposal, vote and execution on the diamond is an event.
// Export reads them in order and maps each actor to its account index, so a
// target chain whose accounts come from a different mnemonic still gets the
// Director as account 0, Wren as 1, and so on. Replay sends the same
// transactions in the same order and checks each id comes out identical.
// Verify compares the target's state with the snapshot taken at export.
//
// Usage (the network is Hardhat's, picked with HARDHAT_NETWORK; default localhost):
//   node scripts/replay-chain.js export events.json
//   HARDHAT_NETWORK=cloud node scripts/replay-chain.js replay events.json 0xTargetDiamond [--send]
//   HARDHAT_NETWORK=cloud node scripts/replay-chain.js verify events.json 0xTargetDiamond
//
// Replay rehearses by default; nothing is sent without --send. It is idempotent:
// an event whose effect is already on the target is skipped, so a replay that
// stopped halfway is run again, not cleaned up.
//
// Three events on the live record cannot be replayed, and the facet says why:
// a vote cast on a proposal id before that proposal was filed. The old facet
// accepted it against a zero struct, set hasVoted, and lost the real vote that
// came after; the guard added since refuses it. Replay refuses those events by
// name rather than dying on the revert, and verify is what proves they changed
// nothing the record shows -- submitProposal overwrote the struct they touched,
// so the tally on the target comes out identical.

const fs = require("fs");
const R = require("../governance/read.js");

// The events that change governance state, in the order the facet emits them.
const EVENTS = ["AAOCreated", "AAOMemberJoined", "AAOMemberLeft", "AAOModified", "AAOTerminated",
  "ProposalSubmitted", "VoteCast", "ProposalExecuted"];

function argOf(args, name) {
  const v = args[name];
  return typeof v === "bigint" ? v.toString() : v;
}

// --- export -------------------------------------------------------------

async function exportEvents(contract, provider, signers) {
  const addressToIndex = {};
  signers.forEach((s, i) => { addressToIndex[s.address.toLowerCase()] = i; });

  // One block height for the whole export. watch.js executes proposals on its
  // own while this runs, so an export that read the events at one height and
  // the state at another would hand the replay a record that never verifies.
  const block = await provider.getBlockNumber();

  const logs = [];
  for (const name of EVENTS) {
    for (const l of await contract.queryFilter(contract.filters[name](), 0, block)) {
      const actor = actorOf(name, l.args);
      logs.push({
        name,
        block: l.blockNumber,
        logIndex: l.index,
        actor,
        account: actor ? addressToIndex[actor.toLowerCase()] : null,
        args: Object.fromEntries(Object.keys(l.args.toObject()).map((k) => [k, argOf(l.args, k)]))
      });
    }
  }
  logs.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);

  const unmapped = logs.filter((e) => e.actor && e.account === undefined);
  if (unmapped.length) {
    throw new Error(`${unmapped.length} event(s) by an address that is not one of this network's accounts, e.g. ${unmapped[0].actor}`);
  }

  // ProposalExecuted names no sender; the executor is whoever the rule set
  // says, and on every organisation so far that was the Director or Wren.
  // Executing is open to any member, so replaying it as the AAO's owner is
  // state-identical.
  return {
    sourceDiamond: await contract.getAddress(),
    blockNumber: block,
    accounts: signers.map((s) => s.address),
    events: logs,
    state: await snapshot(contract, block)
  };
}

function actorOf(name, args) {
  switch (name) {
    case "AAOCreated": return args.owner;
    case "AAOMemberJoined": return args.member;
    case "AAOMemberLeft": return args.member;
    case "AAOTerminated": return args.terminator;
    case "ProposalSubmitted": return args.proposer;
    case "VoteCast": return args.voter;
    default: return null; // AAOModified and ProposalExecuted: the owner acts
  }
}

// `block` pins every read to one height; omit it for the head of the chain.
async function snapshot(contract, block) {
  const at = { blockTag: block === undefined ? "latest" : block };
  const count = Number(await contract.aaoCount(at));
  const aaos = [];
  for (let id = 0; id < count; id++) {
    const a = await contract.getAAO(id, at);
    aaos.push({ id, topic: a.topic, owner: a.owner, active: a.active, members: (a.members || []).slice() });
  }
  const proposals = [];
  const submitted = await contract.queryFilter(contract.filters.ProposalSubmitted(), 0, at.blockTag);
  const ids = [...new Set(submitted.map((l) => Number(l.args.proposalId)))].sort((a, b) => a - b);
  for (const id of ids) {
    const p = await contract.getProposal(id, at);
    proposals.push({
      id, aaoId: p.aaoId.toString(), proposer: p.proposer, text: p.text,
      forVotes: p.forVotes.toString(), againstVotes: p.againstVotes.toString(), status: p.status.toString()
    });
  }
  return { aaoCount: count, aaos, proposals };
}

// --- replay -------------------------------------------------------------

// The key that says "this event, on this thing, by this actor". The n-th event
// with a key in the source is done on the target once the target holds n
// events with that key -- exact even for a member who joined and later left,
// which current membership alone cannot tell apart from one who never joined.
function keyOf(name, args, actorIndex) {
  switch (name) {
    case "AAOCreated": case "AAOModified": case "AAOTerminated": return `${name}:${args.aaoId}`;
    case "AAOMemberJoined": case "AAOMemberLeft": return `${name}:${args.aaoId}:${actorIndex}`;
    case "ProposalSubmitted": case "ProposalExecuted": return `${name}:${args.proposalId}`;
    case "VoteCast": return `${name}:${args.proposalId}:${actorIndex}`;
    default: return `${name}:?`;
  }
}

async function targetEventCounts(contract, signers) {
  const index = {};
  signers.forEach((s, i) => { index[s.address.toLowerCase()] = i; });
  const counts = {};
  for (const name of EVENTS) {
    for (const l of await contract.queryFilter(contract.filters[name](), 0, "latest")) {
      const actor = actorOf(name, l.args);
      const args = Object.fromEntries(Object.keys(l.args.toObject()).map((k) => [k, argOf(l.args, k)]));
      const k = keyOf(name, args, actor ? index[actor.toLowerCase()] : null);
      counts[k] = (counts[k] || 0) + 1;
    }
  }
  return counts;
}

async function replayEvents(data, contract, signers, options) {
  const opts = Object.assign({ send: false, log: () => {} }, options);
  const needed = Math.max(...data.events.map((e) => e.account || 0));
  if (signers.length <= needed) throw new Error(`the target network has ${signers.length} accounts; the record needs ${needed + 1}`);

  const ownerOf = {};
  const filed = new Set();
  const done = await targetEventCounts(contract, signers);
  const seen = {};
  let created = 0; // AAOs this run would create, so a rehearsal can check ids too
  const result = { sent: 0, skipped: 0, refused: [], mismatches: [] };

  for (const e of data.events) {
    const a = e.args;
    if (e.name === "AAOCreated") ownerOf[a.aaoId] = e.account;
    if (e.name === "ProposalSubmitted") filed.add(String(a.proposalId));

    // A vote or an execution on an id the record had not yet filed. The facet
    // refuses it now, so it is named and left out, before `seen` counts it --
    // the target will never hold it, and every run must refuse it the same way.
    if ((e.name === "VoteCast" || e.name === "ProposalExecuted") && !filed.has(String(a.proposalId))) {
      const why = `${e.name} on proposal ${a.proposalId} by account ${e.account} at source block ${e.block}: the proposal was not filed yet; the facet refuses it`;
      result.refused.push(why);
      opts.log(`refuse ${why}`);
      continue;
    }

    const accountIndex = e.account !== null && e.account !== undefined ? e.account : (ownerOf[a.aaoId] || 0);
    const signer = signers[accountIndex];
    const c = contract.connect(signer);
    const key = keyOf(e.name, a, e.account);
    seen[key] = (seen[key] || 0) + 1;
    let tx = null, expect = null;

    if (seen[key] <= (done[key] || 0)) {
      // Already on the target. For the two events that carry content, the
      // content must agree, or this is a different record wearing the same id.
      if (e.name === "AAOCreated" && (await contract.getAAO(a.aaoId)).topic !== a.topic) {
        result.mismatches.push(`AAO ${a.aaoId} exists with a different topic`); return result;
      }
      if (e.name === "ProposalSubmitted" && (await contract.getProposal(a.proposalId)).text !== a.text) {
        result.mismatches.push(`proposal ${a.proposalId} exists with different text`); return result;
      }
      result.skipped++; opts.log(`skip  ${key}`); continue;
    }

    switch (e.name) {
      case "AAOCreated": {
        const count = Number(await contract.aaoCount()) + (opts.send ? 0 : created);
        if (Number(a.aaoId) !== count) { result.mismatches.push(`AAO ${a.aaoId} would be created as ${count}`); return result; }
        created++;
        expect = { event: "AAOCreated", key: "aaoId", value: a.aaoId };
        if (opts.send) tx = await c.createAAO(a.topic, BigInt(a.duration));
        break;
      }
      case "AAOMemberJoined":
        if (opts.send) tx = await c.joinAAO(a.aaoId);
        break;
      case "AAOMemberLeft":
        if (opts.send) tx = await c.leaveAAO(a.aaoId);
        break;
      case "AAOModified":
        if (opts.send) tx = await c.modifyAAO(a.aaoId, a.newTopic, BigInt(a.newDuration));
        break;
      case "AAOTerminated":
        if (opts.send) tx = await c.terminateAAO(a.aaoId);
        break;
      case "ProposalSubmitted":
        expect = { event: "ProposalSubmitted", key: "proposalId", value: a.proposalId };
        if (opts.send) tx = await c.submitProposal(a.aaoId, a.text);
        break;
      case "VoteCast":
        if (opts.send) tx = await c.vote(a.proposalId, a.support === true || a.support === "true");
        break;
      case "ProposalExecuted":
        expect = { event: "ProposalExecuted", key: "passed", value: a.passed };
        if (opts.send) tx = await c.executeProposal(a.proposalId);
        break;
    }

    if (!opts.send) { opts.log(`would ${e.name} as account ${accountIndex} ${JSON.stringify(a).slice(0, 100)}`); result.sent++; continue; }

    const receipt = await tx.wait();
    result.sent++;
    if (expect) {
      const got = receipt.logs.map((l) => { try { return contract.interface.parseLog(l); } catch (err) { return null; } })
        .find((x) => x && x.name === expect.event);
      const v = got ? String(got.args[expect.key]) : "none";
      if (v !== String(expect.value)) {
        result.mismatches.push(`${expect.event}: source ${expect.key} ${expect.value}, target ${v} (block ${receipt.blockNumber})`);
        opts.log(`STOP  ${result.mismatches[result.mismatches.length - 1]}`);
        return result;
      }
    }
    opts.log(`sent  ${e.name} block ${receipt.blockNumber}`);
  }
  return result;
}

// --- verify -------------------------------------------------------------

async function verifyState(data, contract, signers) {
  const target = await snapshot(contract);
  const problems = [];
  // A source address becomes the target account with the same index. An address
  // the record does not know, or an index the target has no account for, is left
  // as it is, so the comparison below reports it instead of throwing.
  const mapAddr = (addr) => {
    const i = data.accounts.findIndex((x) => x.toLowerCase() === String(addr).toLowerCase());
    return i === -1 || !signers[i] ? String(addr) : signers[i].address;
  };
  if (target.aaoCount !== data.state.aaoCount) problems.push(`aaoCount source ${data.state.aaoCount} target ${target.aaoCount}`);
  data.state.aaos.forEach((s) => {
    const t = target.aaos[s.id];
    if (!t) { problems.push(`AAO ${s.id} missing`); return; }
    if (t.topic !== s.topic) problems.push(`AAO ${s.id} topic "${t.topic}" != "${s.topic}"`);
    if (t.active !== s.active) problems.push(`AAO ${s.id} active ${t.active} != ${s.active}`);
    // The owner is the only account that may modify or terminate the AAO, so a
    // record whose owner moved is not the same record.
    if (mapAddr(s.owner).toLowerCase() !== t.owner.toLowerCase()) problems.push(`AAO ${s.id} owner ${t.owner} != ${mapAddr(s.owner)}`);
    const want = s.members.map(mapAddr).map((x) => x.toLowerCase()).sort();
    const have = t.members.map((x) => x.toLowerCase()).sort();
    if (JSON.stringify(want) !== JSON.stringify(have)) problems.push(`AAO ${s.id} members differ`);
  });
  data.state.proposals.forEach((s) => {
    const t = target.proposals.find((x) => x.id === s.id);
    if (!t) { problems.push(`proposal ${s.id} missing`); return; }
    ["aaoId", "text", "forVotes", "againstVotes", "status"].forEach((k) => {
      if (String(t[k]) !== String(s[k])) problems.push(`proposal ${s.id} ${k}: target ${String(t[k]).slice(0, 40)} != source ${String(s[k]).slice(0, 40)}`);
    });
    if (mapAddr(s.proposer).toLowerCase() !== t.proposer.toLowerCase()) problems.push(`proposal ${s.id} proposer differs`);
  });
  return { ok: problems.length === 0, problems, aaos: target.aaoCount, proposals: target.proposals.length };
}

// --- cli ----------------------------------------------------------------

async function main() {
  // Set before hardhat is loaded, and only here: the test requires this file
  // and must keep the network the test runner chose.
  process.env.HARDHAT_NETWORK = process.env.HARDHAT_NETWORK || "localhost";
  const { ethers } = require("hardhat");
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const send = argv.includes("--send");
  const [cmd, file, diamondArg] = argv.filter((a) => !a.startsWith("--"));
  const signers = await ethers.getSigners();

  if (cmd === "export") {
    if (!file) throw new Error("export needs an output file");
    const contract = await ethers.getContractAt("AAOFacet", R.DIAMOND);
    const data = await exportEvents(contract, ethers.provider, signers);
    fs.writeFileSync(file, JSON.stringify(data, null, 1) + "\n", "utf8");
    console.log(`exported ${data.events.length} events, ${data.state.aaoCount} AAOs, ${data.state.proposals.length} proposals at block ${data.blockNumber} -> ${file}`);
    return;
  }
  if (cmd === "replay" || cmd === "verify") {
    if (!file || !diamondArg) throw new Error(`${cmd} needs the events file and the target diamond address`);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const contract = await ethers.getContractAt("AAOFacet", diamondArg);
    if (cmd === "replay") {
      const r = await replayEvents(data, contract, signers, { send, log: console.log });
      console.log(`${send ? "sent" : "would send"} ${r.sent}, skipped ${r.skipped}, refused ${r.refused.length}${r.mismatches.length ? ", STOPPED: " + r.mismatches.join("; ") : ""}`);
      r.refused.forEach((x) => console.log(`  refused: ${x}`));
      if (r.refused.length) console.log("Run verify: it says whether the refused events changed anything the record shows.");
      if (!send) console.log("Rehearsal. Add --send to replay for real.");
      process.exitCode = r.mismatches.length ? 1 : 0;
      return;
    }
    const v = await verifyState(data, contract, signers);
    console.log(v.ok ? `verified: ${v.aaos} AAOs, ${v.proposals} proposals identical` : `MISMATCH:\n  ${v.problems.join("\n  ")}`);
    process.exitCode = v.ok ? 0 : 1;
    return;
  }
  throw new Error("usage: export <file> | replay <file> <diamond> [--send] | verify <file> <diamond>");
}

module.exports = { exportEvents, replayEvents, verifyState, snapshot, keyOf, EVENTS };

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
