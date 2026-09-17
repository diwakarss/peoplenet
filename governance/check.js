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
const P = require("./protocol.js");

const PAGE_URL = process.env.GOVERNANCE_URL ||
  `http://${process.env.GOVERNANCE_HOST || "127.0.0.1"}:${process.env.GOVERNANCE_PORT || 8787}`;

// Wren had voted twelve times when the reasons first went on the page, and she
// keeps voting as proposals arrive. A fixed number would go red on its own, so
// the floor is the assertion and the real invariant is the one below it: every
// Wren vote the chain knows about has a reason on file. Set
// GOVERNANCE_EXPECTED_WREN_VOTES to demand an exact count instead.
const EXACT_WREN_VOTES = process.env.GOVERNANCE_EXPECTED_WREN_VOTES
  ? Number(process.env.GOVERNANCE_EXPECTED_WREN_VOTES)
  : null;
const MINIMUM_WREN_VOTES = 12;

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

  // The same endpoints the page fetches, over the same server.
  let wrenRecords = null;
  let wrenError = null;
  try {
    wrenRecords = await R.fetchWrenVotes(fetch, PAGE_URL);
  } catch (e) {
    wrenError = e && e.message ? e.message : String(e);
  }
  const wrenByProposal = R.indexWrenVotes(wrenRecords || []);

  // The question channel (27.2). An empty log is the normal state until the
  // Director asks something, so the assertion is on the endpoint, not the count.
  const channel = {};
  for (const route of ["/questions.json", "/answers.json"]) {
    try {
      const response = await fetch(PAGE_URL + route, { cache: "no-store" });
      const body = await response.json();
      channel[route] = { ok: response.ok, records: body, error: null };
    } catch (e) {
      channel[route] = { ok: false, records: null, error: e && e.message ? e.message : String(e) };
    }
  }

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
  for (const route of ["/questions.json", "/answers.json"]) {
    const got = channel[route];
    console.log(`${route.padEnd(16)} ${got.error ? `UNAVAILABLE (${got.error})` : `${got.records.length} records`}`);
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

  const wrenCountLabel = EXACT_WREN_VOTES === null
    ? `${R.WREN_VOTES_PATH} returns at least ${MINIMUM_WREN_VOTES} records (got ${(wrenRecords || []).length})`
    : `${R.WREN_VOTES_PATH} returns exactly ${EXACT_WREN_VOTES} records`;
  check(wrenCountLabel, () => {
    if (EXACT_WREN_VOTES !== null) {
      assert.strictEqual(
        wrenRecords.length,
        EXACT_WREN_VOTES,
        `expected ${EXACT_WREN_VOTES} records, got ${wrenRecords.length}`
      );
    } else {
      assert.ok(
        wrenRecords.length >= MINIMUM_WREN_VOTES,
        `expected at least ${MINIMUM_WREN_VOTES} records, got ${wrenRecords.length}`
      );
    }
  });

  check("every Wren vote on chain has a reason on file", () => {
    for (const p of proposals) {
      const onChain = p.votes.filter((v) => R.sameAddress(v.voter, R.WREN))[0];
      if (!onChain) continue;
      assert.ok(
        wrenByProposal[p.id],
        `proposal ${p.id}: Wren voted ${onChain.support ? "for" : "against"} on chain but gave no reason`
      );
    }
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

  // --- the question channel and the protocol (27.2, 27.5) ---------------

  check("the question channel endpoints are served", () => {
    for (const route of ["/questions.json", "/answers.json"]) {
      const got = channel[route];
      assert.strictEqual(got.error, null, `${route} did not answer (${got.error})`);
      assert.ok(got.ok, `${route} returned a non-2xx status`);
      assert.ok(Array.isArray(got.records), `${route} did not return an array`);
    }
  });

  check("every question and answer on file is a valid protocol message", () => {
    for (const route of ["/questions.json", "/answers.json"]) {
      (channel[route].records || []).forEach((record, i) => {
        const result = P.validate(record);
        assert.ok(result.ok, `${route}[${i}] (${record.id}): ${result.errors.join("; ")}`);
      });
    }
  });

  check("every answer points at a question that exists", () => {
    const ids = new Set((channel["/questions.json"].records || []).map((q) => q.id));
    (channel["/answers.json"].records || []).forEach((a) => {
      assert.ok(ids.has(a.question), `answer ${a.id} answers unknown question ${a.question}`);
    });
  });

  check("the protocol validator refuses a message without subject and summary", () => {
    assert.strictEqual(P.validate({ from: "wren", type: "answer", subject: "x" }).ok, false);
    assert.strictEqual(P.validate({ from: "wren", type: "answer", summary: "x" }).ok, false);
    assert.strictEqual(P.validate({ from: "wren", type: "answer", subject: " ", summary: "x" }).ok, false);
    assert.strictEqual(
      P.validate({ from: "wren", type: "answer", subject: "x", summary: "y" }).ok,
      true
    );
  });

  check("the protocol validator refuses an unknown type and a bad shape", () => {
    const bad = P.validate({ from: "wren", type: "gossip", subject: "x", summary: "y" });
    assert.strictEqual(bad.ok, false);
    assert.ok(bad.errors.join(" ").includes("gossip"));
    assert.strictEqual(P.validate(null).ok, false);
    assert.strictEqual(P.validate("a string").ok, false);
    assert.strictEqual(
      P.validate({ from: "wren", type: "answer", subject: "x", summary: "y", refs: "no" }).ok,
      false
    );
  });

  check("normalise fills id, ts, to and refs without touching what was written", () => {
    const message = P.normalise({ from: "director", type: "question", subject: "s", summary: "m" });
    assert.ok(message.id && message.ts, "id and ts were not filled");
    assert.strictEqual(message.to, "all");
    assert.deepStrictEqual(message.refs, []);
    assert.strictEqual(message.subject, "s");
    assert.strictEqual(P.validate(message).ok, true);
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
