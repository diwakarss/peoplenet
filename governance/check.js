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

  const { aaos, aao, proposals, blockNumber } = await R.readGovernance(ethers, provider);
  const contract = R.getContract(ethers, provider);
  const allProposals = await R.readAllProposals(contract, aaos);

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
  for (const route of ["/questions.json", "/answers.json", "/messages.json"]) {
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
    console.log(
      `  #${p.id}  ${p.statusLabel}  by ${p.proposerLabel}  ${R.formatTime(p.createdAt)}` +
      (p.format.legacy ? "  [legacy format]" : "")
    );
    console.log(`      ${R.proposalHeadline(p).slice(0, 96)}`);
    if (!p.format.legacy && p.format.doc.summary) {
      console.log(`      ${String(p.format.doc.summary).slice(0, 96)}`);
    }
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
  for (const route of ["/questions.json", "/answers.json", "/messages.json"]) {
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

  // The Builder and the Widget are roles too, but they belong to the sub-AAO;
  // the main organisation has exactly the three that decide.
  check("the three governance roles are members of AAO 0", () => {
    const addresses = aao.members.map((m) => m.address.toLowerCase());
    for (const address of [R.DIRECTOR, R.WREN, R.CASTING]) {
      assert.ok(
        addresses.includes(address.toLowerCase()),
        `${R.labelFor(address)} (${address}) is not a member — run scripts/setup-governance-members.js`
      );
    }
    for (const address of [R.BUILDER, R.WIDGET]) {
      assert.ok(
        !addresses.includes(address.toLowerCase()),
        `${R.labelFor(address)} is on AAO 0; it belongs to the widget-builder sub-AAO`
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

  // The proposal counter is global across organisations, so AAO 0's ids are
  // ascending but not necessarily contiguous once the sub-AAO has proposals.
  check("proposal ids ascend, with no duplicates", () => {
    proposals.forEach((p, i) => {
      if (i > 0) {
        assert.ok(p.id > proposals[i - 1].id,
          `proposal ids are not ascending: ${proposals[i - 1].id} then ${p.id}`);
      }
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

  // --- the organisations and the sub-AAO (27.3, 27.4) -------------------

  check(`the page lists ${aaos.length} organisation(s), in id order`, () => {
    assert.ok(aaos.length >= 1, "no organisations on this chain");
    aaos.forEach((a, i) => {
      assert.strictEqual(a.id, i, `organisation at index ${i} has id ${a.id}`);
      assert.ok(a.topic, `organisation ${a.id} has no topic`);
      assert.ok(Array.isArray(a.members), `organisation ${a.id} has no member list`);
    });
  });

  check("the widget-builder sub-AAO has its four members", () => {
    const sub = aaos.filter((a) => a.topic === "widget-builder")[0];
    assert.ok(sub, "no widget-builder organisation — run scripts/create-widget-builder-aao.js");
    const labels = sub.members.map((m) => m.label).sort();
    assert.deepStrictEqual(labels, ["Builder", "Director", "Widget", "Wren"]);
    assert.ok(sub.note, "the sub-AAO has no plain-English line");
  });

  check("every organisation carries a plain-English line", () => {
    for (const a of aaos) {
      assert.ok(
        typeof a.note === "string",
        `organisation ${a.id} ("${a.topic}") has no note field`
      );
    }
  });

  check("the whole tree reads: every proposal belongs to a listed organisation", () => {
    const ids = new Set(aaos.map((a) => a.id));
    for (const p of allProposals) {
      assert.ok(ids.has(p.aaoId), `proposal ${p.id} is on unlisted organisation ${p.aaoId}`);
    }
  });

  check("proposal ids are unique across every organisation", () => {
    const seenIds = new Set();
    for (const p of allProposals) {
      assert.ok(!seenIds.has(p.id), `proposal id ${p.id} appears twice`);
      seenIds.add(p.id);
    }
  });

  // --- the proposal format (27.1) ---------------------------------------

  check("every proposal reads as either a 27.1 document or legacy free text", () => {
    for (const p of proposals) {
      const fmt = p.format;
      assert.ok(fmt, `proposal ${p.id} was not parsed`);
      assert.strictEqual(typeof fmt.legacy, "boolean");
      if (fmt.legacy) {
        assert.strictEqual(fmt.doc, null, `proposal ${p.id} is legacy but carries a document`);
        assert.ok(fmt.raw.length > 0, `proposal ${p.id} is legacy and empty`);
      } else {
        assert.ok(fmt.doc && typeof fmt.doc === "object", `proposal ${p.id} has no document`);
      }
    }
  });

  check("every 27.1 proposal has a title, a summary and a why", () => {
    for (const p of proposals) {
      if (p.format.legacy) continue;
      assert.ok(
        p.format.valid.ok,
        `proposal ${p.id}: ${p.format.valid.errors.join("; ")}`
      );
    }
  });

  check("the free-text proposals already on chain are left alone", () => {
    const legacy = proposals.filter((p) => p.format.legacy).map((p) => p.id);
    assert.ok(legacy.length >= 1, "expected the pre-27.1 proposals to still be here");
    // They were filed before the format landed, so they are the earliest ids and
    // nothing has been re-filed since.
    const structured = proposals.filter((p) => !p.format.legacy).map((p) => p.id);
    if (structured.length) {
      assert.ok(
        Math.max(...legacy) < Math.min(...structured),
        `a legacy proposal was filed after a 27.1 one (legacy ${legacy.join(",")}, 27.1 ${structured.join(",")})`
      );
    }
  });

  check("every proposal has a headline a person can read", () => {
    for (const p of proposals) {
      const headline = R.proposalHeadline(p);
      assert.ok(headline && headline !== "(no text)", `proposal ${p.id} has no headline`);
      assert.ok(headline.length <= 110, `proposal ${p.id} headline is ${headline.length} characters`);
    }
  });

  check("the proposal validator refuses what the scripts must refuse", () => {
    assert.strictEqual(R.validateProposalDoc(null).ok, false);
    assert.strictEqual(R.validateProposalDoc("free text").ok, false);
    assert.strictEqual(R.validateProposalDoc({ title: "t", summary: "s" }).ok, false);
    assert.strictEqual(R.validateProposalDoc({ title: "t", why: "w" }).ok, false);
    assert.strictEqual(R.validateProposalDoc({ summary: "s", why: "w" }).ok, false);
    assert.strictEqual(R.validateProposalDoc({ title: " ", summary: "s", why: "w" }).ok, false);
    assert.strictEqual(R.validateProposalDoc({ title: "t", summary: "s", why: "w", refs: "no" }).ok, false);
    assert.strictEqual(R.validateProposalDoc({ title: "t", summary: "s", why: "w" }).ok, true);
  });

  check("free text is read as legacy, not as a broken document", () => {
    assert.strictEqual(R.parseProposalText("2026-09-17 builder S1: do a thing").legacy, true);
    assert.strictEqual(R.parseProposalText("{not json").legacy, true);
    assert.strictEqual(R.parseProposalText('{"unrelated":1}').legacy, true);
    assert.strictEqual(R.parseProposalText('{"title":"t","summary":"s","why":"w"}').legacy, false);
  });

  // --- the question channel and the protocol (27.2, 27.5) ---------------

  check("the question channel endpoints are served", () => {
    for (const route of ["/questions.json", "/answers.json", "/messages.json"]) {
      const got = channel[route];
      assert.strictEqual(got.error, null, `${route} did not answer (${got.error})`);
      assert.ok(got.ok, `${route} returned a non-2xx status`);
      assert.ok(Array.isArray(got.records), `${route} did not return an array`);
    }
  });

  check("every question and answer on file is a valid protocol message", () => {
    for (const route of ["/questions.json", "/answers.json", "/messages.json"]) {
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

  check("every message names an organisation the page can show it on", () => {
    for (const route of ["/questions.json", "/answers.json", "/messages.json"]) {
      const ids = new Set(aaos.map((a) => a.id));
      (channel[route].records || []).forEach((m) => {
        const on = m.aaoId === undefined || m.aaoId === null ? R.AAO_ID : Number(m.aaoId);
        assert.ok(ids.has(on), `${route} ${m.id} is on unlisted organisation ${on}`);
      });
    }
  });

  check("a question names a proposal that is on the organisation it claims", () => {
    const byId = new Map(allProposals.map((p) => [p.id, p]));
    (channel["/questions.json"].records || []).forEach((q) => {
      if (q.proposal === null || q.proposal === undefined) return;
      const p = byId.get(Number(q.proposal));
      assert.ok(p, `question ${q.id} asks about proposal ${q.proposal}, which does not exist`);
      assert.strictEqual(
        p.aaoId, Number(q.aaoId),
        `question ${q.id} says organisation ${q.aaoId} but proposal ${q.proposal} is on ${p.aaoId}`
      );
    });
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
