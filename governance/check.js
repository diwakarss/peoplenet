// governance/check.js -- runs the page's data layer against the live chain and
// prints what the page would show, then asserts the bits that must be true.
//
//   npm run governance:check
//   node governance/check.js
//
// This is the page's test. It imports the very same governance/read.js the
// browser loads, so a change that would break the page breaks this first. It
// only reads; it never sends a transaction.
//
// It also hits the page's own server for GET /wren-votes.json, so `npm run
// governance` must be up for the Wren checks; the chain checks run either way.
const assert = require("assert");
const ethers = require("ethers");
const R = require("./read.js");

const PAGE_URL = process.env.GOVERNANCE_URL ||
  `http://${process.env.GOVERNANCE_HOST || "127.0.0.1"}:${process.env.GOVERNANCE_PORT || 8787}`;

// Wren has voted on every proposal that existed when she sat down: twelve.
const EXPECTED_WREN_VOTES = Number(process.env.GOVERNANCE_EXPECTED_WREN_VOTES || 12);

// AAO 0 was seeded with the seven WP17d builder suggestions, and proposals only
// ever get added, never removed -- other sessions file more as the work goes on.
// So the floor is the assertion: at least these seven must still render. Set
// GOVERNANCE_EXPECTED_PROPOSALS to demand an exact count instead.
const EXACT_PROPOSALS = process.env.GOVERNANCE_EXPECTED_PROPOSALS
  ? Number(process.env.GOVERNANCE_EXPECTED_PROPOSALS)
  : null;
const MINIMUM_PROPOSALS = 7;

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

  // The same endpoint the page fetches, over the same server.
  let wrenRecords = null;
  let wrenError = null;
  try {
    wrenRecords = await R.fetchWrenVotes(fetch, PAGE_URL);
  } catch (e) {
    wrenError = e && e.message ? e.message : String(e);
  }
  const wrenByProposal = R.indexWrenVotes(wrenRecords || []);

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
    const wren = wrenByProposal[p.id];
    console.log(`      wren:   ${wren
      ? `voted ${wren.support ? "FOR" : "AGAINST"} — "${String(wren.reason || "").slice(0, 78)}"`
      : "has not voted"}`);
    console.log(`      casting vote: ${casting.allowed ? "ENABLED" : "disabled"} — ${casting.reason}`);
  }

  console.log("");
  console.log(`wren-votes.json  ${wrenError ? `UNAVAILABLE (${wrenError})` : `${wrenRecords.length} records from ${PAGE_URL}${R.WREN_VOTES_PATH}`}`);

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

  const countLabel = EXACT_PROPOSALS === null
    ? `AAO ${R.AAO_ID} has at least ${MINIMUM_PROPOSALS} proposals (read ${proposals.length})`
    : `AAO ${R.AAO_ID} has exactly ${EXACT_PROPOSALS} proposals`;
  check(countLabel, () => {
    if (EXACT_PROPOSALS !== null) {
      assert.strictEqual(
        proposals.length,
        EXACT_PROPOSALS,
        `expected ${EXACT_PROPOSALS} proposals, read ${proposals.length}`
      );
    } else {
      assert.ok(
        proposals.length >= MINIMUM_PROPOSALS,
        `expected at least ${MINIMUM_PROPOSALS} proposals, read ${proposals.length}`
      );
    }
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

  check(`GET ${R.WREN_VOTES_PATH} is served`, () => {
    assert.strictEqual(
      wrenError,
      null,
      `${PAGE_URL}${R.WREN_VOTES_PATH} did not answer (${wrenError}). Is "npm run governance" up?`
    );
    assert.ok(Array.isArray(wrenRecords), "the endpoint did not return an array");
  });

  check(`${R.WREN_VOTES_PATH} returns ${EXPECTED_WREN_VOTES} records`, () => {
    assert.strictEqual(
      wrenRecords.length,
      EXPECTED_WREN_VOTES,
      `expected ${EXPECTED_WREN_VOTES} records, got ${wrenRecords.length}`
    );
  });

  check("every record names a proposal, a direction and a reason", () => {
    wrenRecords.forEach((record, i) => {
      assert.ok(Number.isInteger(record.proposalId), `record ${i} has no proposalId`);
      assert.strictEqual(typeof record.support, "boolean", `record ${i} has no support flag`);
      assert.ok(
        typeof record.reason === "string" && record.reason.trim().length > 0,
        `record ${i} (proposal ${record.proposalId}) has no reason`
      );
      assert.ok(
        R.sameAddress(record.voter, R.WREN),
        `record ${i} was cast by ${record.voter}, not Wren`
      );
    });
  });

  check("the page shows one reason per proposal, the latest", () => {
    const ids = Object.keys(wrenByProposal).map(Number).sort((a, b) => a - b);
    assert.strictEqual(
      ids.length,
      new Set(wrenRecords.map((r) => r.proposalId)).size,
      "indexing lost or invented a proposal"
    );
    for (const id of ids) {
      const forThisProposal = wrenRecords.filter((r) => Number(r.proposalId) === id);
      const latest = forThisProposal[forThisProposal.length - 1];
      assert.strictEqual(
        wrenByProposal[id].at,
        latest.at,
        `proposal ${id} shows a record that is not the latest of its ${forThisProposal.length}`
      );
    }
  });

  check("each recorded direction matches the chain", () => {
    for (const p of proposals) {
      const record = wrenByProposal[p.id];
      if (!record) continue;
      const onChain = p.votes.filter((v) => R.sameAddress(v.voter, R.WREN))[0];
      assert.ok(onChain, `proposal ${p.id} has a Wren record but no Wren VoteCast on chain`);
      assert.strictEqual(
        onChain.support,
        Boolean(record.support),
        `proposal ${p.id}: the log says ${record.support ? "for" : "against"}, the chain says the opposite`
      );
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
