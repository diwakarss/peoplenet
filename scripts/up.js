// Brings the whole thing back: node, diamond, record, server, watcher.
//
// Proposal 92. On 2026-09-19 a Windows sign-out destroyed the chain and the
// recovery took a builder most of an hour, working from an order. This is that
// order as a command.
//
//   node scripts/up.js            # bring it up, or report that it is already up
//   node scripts/up.js --status   # say what is running and stop
//
// Idempotent. If the node answers and the diamond holds a record, it changes
// nothing and says so: running it twice must never cost anything.
//
// Every process it starts is written to a state file by its own process id.
// Nothing here is ever found, or stopped, by name -- a name match once killed
// an architect's watch three times in an afternoon.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const ethers = require("ethers");
const R = require("../governance/read.js");
const S = require("../governance/snapshots.js");

const REPO = path.join(__dirname, "..");
const HARDHAT = path.join("node_modules", "hardhat", "internal", "cli", "bootstrap.js");
const NODE_PORT = Number(process.env.PEOPLENET_NODE_PORT || 8545);
const SERVER_PORT = Number(process.env.GOVERNANCE_PORT || 8787);
const RPC = process.env.PEOPLENET_RPC || `http://127.0.0.1:${NODE_PORT}`;
const STATE = process.env.PEOPLENET_STATE
  ? path.resolve(process.env.PEOPLENET_STATE)
  : path.join(os.homedir(), "peoplenet-snapshots", "up-state.json");
const LOG_DIR = process.env.PEOPLENET_LOG_DIR
  ? path.resolve(process.env.PEOPLENET_LOG_DIR)
  : path.join(os.homedir(), "peoplenet-snapshots", "logs");

function out(line) { process.stdout.write(line + "\n"); }

// --- what is already running --------------------------------------------

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (e) { return { started: [] }; }
}

// By process id, always. `started` is append-only within a run so a crash
// between two writes still leaves the earlier pid recorded.
function recordPid(what, pid, extra) {
  const state = readState();
  state.started = (state.started || []).filter((p) => p.what !== what);
  state.started.push(Object.assign({ what, pid, at: new Date().toISOString() }, extra || {}));
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  S.writeAtomic(STATE, JSON.stringify(state, null, 1) + "\n");
  return state;
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

async function chainAnswers() {
  try {
    const provider = new ethers.JsonRpcProvider(RPC);
    const block = await provider.getBlockNumber();
    return { up: true, block };
  } catch (e) {
    return { up: false, why: e.shortMessage || e.message || String(e) };
  }
}

// A diamond with a record on it, as opposed to a fresh empty one.
async function chainHoldsRecord() {
  try {
    const provider = new ethers.JsonRpcProvider(RPC);
    const contract = R.getContract(ethers, provider, R.DIAMOND);
    const aaos = Number(await contract.aaoCount());
    if (!aaos) return { held: false, aaos: 0, proposals: 0 };
    const filed = await contract.queryFilter(contract.filters.ProposalSubmitted(), 0, "latest");
    const proposals = new Set(filed.map((l) => Number(l.args.proposalId))).size;
    return { held: aaos > 0, aaos, proposals };
  } catch (e) {
    return { held: false, why: e.shortMessage || e.message || String(e) };
  }
}

async function serverAnswers() {
  try {
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/`, { method: "HEAD" });
    return response.ok || response.status < 500;
  } catch (e) {
    return false;
  }
}

// --- starting things ------------------------------------------------------

function startDetached(what, args, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, args, {
    cwd: REPO, detached: true, stdio: ["ignore", log, log],
    env: Object.assign({}, process.env)
  });
  child.unref();
  recordPid(what, child.pid, { log: logFile });
  return child.pid;
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO, env: Object.assign({}, process.env, env || {})
    });
    let text = "";
    child.stdout.on("data", (d) => { text += d; });
    child.stderr.on("data", (d) => { text += d; });
    child.on("close", (code) => resolve({ code, text }));
  });
}

async function waitFor(check, seconds, what) {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > until) throw new Error(`${what} did not come up within ${seconds}s`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// --- the vote guard -------------------------------------------------------

// The facet that lost a vote on proposal 27 accepted a vote on an unfiled id.
// A deploy that brought back the old one would look identical from outside, so
// the guard is proved by calling it, not by trusting the address.
async function voteGuardPresent() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const contract = R.getContract(ethers, provider, R.DIAMOND);
  try {
    await contract.vote.staticCall(999999, true);
    return false;
  } catch (e) {
    return /does not exist/i.test(e.shortMessage || e.message || "");
  }
}

// --- the whole thing ------------------------------------------------------

async function status() {
  const chain = await chainAnswers();
  const record = chain.up ? await chainHoldsRecord() : { held: false };
  const server = await serverAnswers();
  const state = readState();
  out(`node    ${RPC}  ${chain.up ? `up, block ${chain.block}` : "down"}`);
  out(`record  ${record.held ? `${record.aaos} AAOs, ${record.proposals} proposals` : "none"}`);
  out(`server  http://127.0.0.1:${SERVER_PORT}  ${server ? "up" : "down"}`);
  (state.started || []).forEach((p) => {
    out(`  started ${p.what} as pid ${p.pid}, ${alive(p.pid) ? "alive" : "gone"}  ${p.log || ""}`);
  });
  return { chain, record, server };
}

async function main() {
  if (process.argv.includes("--status")) { await status(); return; }

  const chain = await chainAnswers();
  if (chain.up) {
    const record = await chainHoldsRecord();
    if (record.held) {
      out(`already up: block ${chain.block}, ${record.aaos} AAOs, ${record.proposals} proposals.`);
      if (!(await serverAnswers())) {
        const pid = startDetached("server", ["governance/server.js"],
          path.join(LOG_DIR, "governance-server.log"));
        await waitFor(serverAnswers, 30, "the governance server");
        out(`started the governance server as pid ${pid}.`);
      } else {
        out(`the governance server is up too. Nothing to do.`);
      }
      return;
    }
    out(`the node is up at block ${chain.block} but the diamond holds no record.`);
  } else {
    out(`the node is not answering on ${RPC}; starting it.`);
    const pid = startDetached("node",
      [HARDHAT, "node", "--port", String(NODE_PORT)],
      path.join(LOG_DIR, "hardhat-node.log"));
    out(`  hardhat node as pid ${pid}`);
    await waitFor(async () => (await chainAnswers()).up, 90, "the hardhat node");
    out(`  node answering.`);
  }

  out("deploying the diamond...");
  const deployed = await run([HARDHAT, "run", "scripts/deploy/deploy-all.js", "--network", "localhost"]);
  const address = (deployed.text.match(/Diamond address:\s*(0x[0-9a-fA-F]{40})/) || [])[1];
  if (!address) throw new Error("the deploy did not print a diamond address:\n" + deployed.text.slice(-400));
  if (address.toLowerCase() !== R.DIAMOND.toLowerCase()) {
    throw new Error(`the diamond came out at ${address}, not ${R.DIAMOND}. Refusing to replay onto it.`);
  }
  out(`  diamond ${address}, as expected.`);

  if (!(await voteGuardPresent())) {
    throw new Error("the vote guard is absent: a vote on an unfiled id was accepted. " +
      "This is the facet that lost a vote on proposal 27. Refusing to go on.");
  }
  out("  vote guard present.");

  const snapshot = S.newestGood();
  if (!snapshot) throw new Error(`no readable snapshot in ${S.directory()}; nothing to replay.`);
  out(`replaying ${path.basename(snapshot.file)} (${snapshot.summary.events} events, ` +
    `${snapshot.summary.proposals} proposals at block ${snapshot.summary.block})...`);

  // replay-chain.js carries its own CLI and sets HARDHAT_NETWORK itself, so it
  // is run as a plain node script.
  const sent = await run(["scripts/replay-chain.js", "replay", snapshot.file, R.DIAMOND, "--send"]);
  const line = (sent.text.match(/^sent \d+.*$/m) || [])[0] || sent.text.slice(-200);
  out(`  ${line.trim()}`);
  if (sent.code !== 0) throw new Error("the replay stopped:\n" + sent.text.slice(-500));

  const verified = await run(["scripts/replay-chain.js", "verify", snapshot.file, R.DIAMOND]);
  out(`  ${(verified.text.match(/^(verified|MISMATCH).*$/m) || [verified.text.slice(-200)])[0].trim()}`);
  if (verified.code !== 0) throw new Error("the replayed record does not verify:\n" + verified.text.slice(-500));

  if (!(await serverAnswers())) {
    const pid = startDetached("server", ["governance/server.js"],
      path.join(LOG_DIR, "governance-server.log"));
    await waitFor(serverAnswers, 30, "the governance server");
    out(`started the governance server as pid ${pid}; the watcher runs with it.`);
  }

  out("");
  await status();
  out("");
  out("To have this run at logon, run this yourself -- it is not installed:");
  out(`  schtasks /create /tn "PeopleNet up" /tr "node \\"${path.join(REPO, "scripts", "up.js")}\\"" /sc onlogon /rl highest`);
}

module.exports = { readState, recordPid, alive, chainAnswers, chainHoldsRecord, status, STATE };

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
