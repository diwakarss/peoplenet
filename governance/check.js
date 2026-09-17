// governance/check.js -- runs the page's data layer against the live chain and
// prints what the page would show, then asserts the bits that must be true.
//
//   npm run governance:check
//   node governance/check.js
//
// This is the page's test. It imports the very same governance/read.js the
// browser loads, so a change that would break the page breaks this first. It
// only reads; it never sends a transaction.
const assert = require("assert");
const ethers = require("ethers");
const R = require("./read.js");

const EXPECTED_PROPOSALS = Number(process.env.GOVERNANCE_EXPECTED_PROPOSALS || 7);

function bar(count, total, width) {
  const w = width || 18;
  const filled = total > 0 ? Math.round((count / total) * w) : 0;
  return "[" + "#".repeat(filled) + ".".repeat(w - filled) + "]";
}

async function main() {
  const provider = R.getProvider(ethers);

  let network;
  try {
    network = await provider.getNetwork();
  } catch (e) {
    throw new Error(
      `No chain at ${R.RPC_URL}. Start the Hardhat node first (npm run node).`
    );
  }
  assert.strictEqual(Number(network.chainId), R.CHAIN_ID, `expected chain id ${R.CHAIN_ID}`);

  const code = await provider.getCode(R.DIAMOND);
  assert.notStrictEqual(code, "0x", `no contract deployed at ${R.DIAMOND}`);

  const { aao, proposals, blockNumber } = await R.readGovernance(ethers, provider);

  // --- the rendering ---------------------------------------------------
  console.log(`AAO ${aao.id}: ${aao.topic}`);
  console.log(`creator   ${aao.creatorLabel} ${aao.creator}`);
  console.log(`created   ${R.formatTime(aao.createdAt)}`);
  console.log(`block     ${blockNumber} on chain ${R.CHAIN_ID}`);
  console.log(`members   ${aao.members.length}`);
  for (const m of aao.members) {
    console.log(`  ${m.label.padEnd(12)} ${m.address}${m.isCreator ? "  [creator]" : ""}`);
  }
  console.log("");
  console.log(`proposals ${proposals.length}`);
  for (const p of proposals) {
    const total = Math.max(p.forVotes + p.againstVotes, aao.members.length, 1);
    const voters = p.votes.length
      ? p.votes.map((v) => `${v.label} ${v.support ? "for" : "against"}`).join(", ")
      : "no votes yet";
    const casting = R.castingVoteState(p);
    console.log("");
    console.log(`  #${p.id}  ${p.statusLabel}  by ${p.proposerLabel}  ${R.formatTime(p.createdAt)}`);
    console.log(`      ${String(p.text).slice(0, 96)}`);
    console.log(`      for     ${bar(p.forVotes, total)} ${p.forVotes}`);
    console.log(`      against ${bar(p.againstVotes, total)} ${p.againstVotes}`);
    console.log(`      voted:  ${voters}`);
    console.log(`      casting vote: ${casting.allowed ? "ENABLED" : "disabled"} — ${casting.reason}`);
  }

  // --- the assertions --------------------------------------------------
  const checks = [];
  function check(name, fn) {
    fn();
    checks.push(name);
  }

  check(`AAO ${R.AAO_ID} exists and is active`, () => {
    assert.ok(aao.topic, "AAO has no topic");
    assert.strictEqual(aao.active, true, "AAO is not active");
  });

  check("AAO 0 is the trilogy widget", () => {
    assert.strictEqual(aao.topic, "trilogy widget");
  });

  check("the three governance roles are members", () => {
    const addresses = aao.members.map((m) => m.address.toLowerCase());
    for (const role of R.ROLES) {
      assert.ok(
        addresses.includes(role.address.toLowerCase()),
        `${role.label} (${role.address}) is not a member — run scripts/setup-governance-members.js`
      );
    }
  });

  check("the creator is the Director", () => {
    assert.ok(R.sameAddress(aao.creator, R.DIRECTOR), `creator is ${aao.creator}`);
  });

  check(`AAO ${R.AAO_ID} has ${EXPECTED_PROPOSALS} proposals`, () => {
    assert.strictEqual(
      proposals.length,
      EXPECTED_PROPOSALS,
      `expected ${EXPECTED_PROPOSALS} proposals, read ${proposals.length}`
    );
  });

  check("proposal ids are contiguous from 0", () => {
    proposals.forEach((p, i) => {
      assert.strictEqual(p.id, i, `proposal at index ${i} has id ${p.id}`);
      assert.strictEqual(p.aaoId, R.AAO_ID);
      assert.ok(p.text && p.text.length > 0, `proposal ${p.id} has no text`);
      assert.ok(R.STATUS[p.status], `proposal ${p.id} has unknown status ${p.status}`);
    });
  });

  check("the tie rule only fires on an actual tie", () => {
    for (const p of proposals) {
      const state = R.castingVoteState(p);
      if (state.allowed) {
        assert.strictEqual(p.forVotes, p.againstVotes, `proposal ${p.id} is not tied`);
        assert.strictEqual(p.status, 0, `proposal ${p.id} is not open`);
        assert.ok(R.hasVoted(p, R.DIRECTOR) && R.hasVoted(p, R.WREN));
      }
    }
  });

  console.log("");
  for (const name of checks) console.log(`  ok  ${name}`);
  console.log("");
  console.log(`${checks.length} checks passed.`);
}

main().catch((e) => {
  console.error("");
  console.error("FAILED: " + (e.message || e));
  process.exit(1);
});
