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
const A = require("./adoption.js");
const W = require("./watch.js");
const CTRL = require("../scripts/check-control-characters.js");
const path = require("path");
const fs = require("fs");
const os = require("os");

// The trigger evaluator is tested against fixtures under governance/fixtures,
// never against the real incidents file: a check that reads the widget's own
// log would go red or green for reasons nothing here controls.
const FIXTURES = {
  incidentsFile: path.join(__dirname, "fixtures", "incidents.jsonl"),
  versionFile: path.join(__dirname, "fixtures", "version.py"),
  reportDir: path.join(__dirname, "fixtures", "reports"),
  widgetRepo: path.join(__dirname, "fixtures", "no-such-repo")
};

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

  // The builder's log, the same shape through the same endpoint (proposal 29).
  let builderRecords = null;
  let builderError = null;
  try {
    builderRecords = await R.fetchBuilderVotes(fetch, PAGE_URL);
  } catch (e) {
    builderError = e && e.message ? e.message : String(e);
  }
  const builderByProposal = R.indexWrenVotes(builderRecords || []);

  // The widget's, empty until its add-on casts the first vote (proposal 30).
  let widgetRecords = null;
  let widgetError = null;
  try {
    widgetRecords = await R.fetchWidgetVotes(fetch, PAGE_URL);
  } catch (e) {
    widgetError = e && e.message ? e.message : String(e);
  }

  // Wren's translations of the legacy proposals (27.10), read-only.
  let translations = {};
  let translationsError = null;
  try {
    const response = await fetch(PAGE_URL + "/translations.json", { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    translations = await response.json();
  } catch (e) {
    translationsError = e && e.message ? e.message : String(e);
  }

  // The question channel (27.2). An empty log is the normal state until the
  // Director asks something, so the assertion is on the endpoint, not the count.
  const channel = {};
  for (const route of ["/questions.json", "/answers.json", "/messages.json", "/drafts.json"]) {
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
    const tr = p.format.legacy ? translations[p.id] : null;
    console.log(`      ${(tr && tr.title ? tr.title : R.proposalHeadline(p)).slice(0, 96)}${tr ? "  [translated]" : ""}`);
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
  console.log(`builder-votes    ${builderError ? `UNAVAILABLE (${builderError})` : `${builderRecords.length} records from ${PAGE_URL}${R.BUILDER_VOTES_PATH}`}`);
  console.log(`widget-votes     ${widgetError ? `UNAVAILABLE (${widgetError})` : `${widgetRecords.length} records from ${PAGE_URL}${R.WIDGET_VOTES_PATH}`}`);
  if (!wrenError && !builderError && !widgetError) {
    const all = [...wrenRecords, ...builderRecords, ...widgetRecords];
    const withRefs = all.filter((r) => R.voteRefs(r).length);
    console.log(`vote refs        ${withRefs.length} of ${all.length} ` +
      "records say what they were cast against");
  }
  for (const route of ["/questions.json", "/answers.json", "/messages.json", "/drafts.json"]) {
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
      // A correction is Wren writing down that an earlier record was wrong. The
      // log is append-only, so that is the only way to say so: it names no
      // proposal, carries no direction, and indexWrenVotes skips it.
      if (record.correction) {
        assert.ok(
          typeof record.reason === "string" && record.reason.trim().length > 0,
          `correction ${i} has no reason`
        );
        return;
      }
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
    // A correction names no proposal -- it is Wren writing down that an earlier
    // record was wrong -- so it is not a vote and must not be counted as one.
    const voteRecords = wrenRecords.filter((r) => !r.correction);
    assert.strictEqual(
      ids.length,
      new Set(voteRecords.map((r) => r.proposalId)).size,
      "indexing lost or invented a proposal"
    );
    for (const id of ids) {
      const forThisProposal = voteRecords.filter((r) => Number(r.proposalId) === id);
      const latest = forThisProposal[forThisProposal.length - 1];
      assert.strictEqual(
        wrenByProposal[id].at,
        latest.at,
        `proposal ${id} shows a record that is not the latest of its ${forThisProposal.length}`
      );
    }
  });

  // --- what a vote points at (proposal 29) -------------------------------

  check(`GET ${R.BUILDER_VOTES_PATH} is served, in the same shape`, () => {
    assert.strictEqual(
      builderError, null,
      `${PAGE_URL}${R.BUILDER_VOTES_PATH} did not answer (${builderError}). Is "npm run governance" up?`
    );
    assert.ok(Array.isArray(builderRecords), "the endpoint did not return an array");
    // The builder's reasons were being written to a file nothing served and
    // nothing showed. Same fields as Wren's, so one reader does both.
    builderRecords.forEach((record, i) => {
      if (record.correction) return;
      assert.ok(Number.isInteger(record.proposalId), `builder record ${i} has no proposalId`);
      assert.strictEqual(typeof record.support, "boolean", `builder record ${i} has no support flag`);
      assert.ok(typeof record.reason === "string" && record.reason.trim(),
        `builder record ${i} has no reason`);
      assert.ok(R.sameAddress(record.voter, R.BUILDER),
        `builder record ${i} was cast by ${record.voter}, not the Builder`);
    });
  });

  check(`GET ${R.WIDGET_VOTES_PATH} answers before the widget has ever voted`, () => {
    // The widget's log does not exist until its add-on casts the first vote, and
    // an endpoint that 404s then would mean deploying something on the day it
    // does. A missing log answers [] instead, so the card is simply right.
    assert.strictEqual(
      widgetError, null,
      `${PAGE_URL}${R.WIDGET_VOTES_PATH} did not answer (${widgetError}). Is "npm run governance" up?`
    );
    assert.ok(Array.isArray(widgetRecords), "the endpoint did not return an array");
    widgetRecords.forEach((record, i) => {
      if (record.correction) return;
      assert.ok(R.sameAddress(record.voter, R.WIDGET),
        `widget record ${i} was cast by ${record.voter}, not the Widget`);
    });
  });

  check("one vote script, and each agent's is a wrapper on it", () => {
    // Proposal 30. builder-vote.js was wren-vote.js with two names changed, so
    // the unfiled-id guard was written twice and --dry-run remembered twice.
    const V = require("./vote.js");
    const scriptsDir = path.join(__dirname, "..", "scripts");

    for (const [file, account, log] of [
      ["wren-vote.js", 1, "wren-votes.jsonl"],
      ["builder-vote.js", 3, "builder-votes.jsonl"],
      ["widget-vote.js", 4, "widget-votes.jsonl"]
    ]) {
      const source = fs.readFileSync(path.join(scriptsDir, file), "utf8");
      assert.ok(source.includes('require("../governance/vote.js").run('),
        `${file} does not use the shared vote script`);
      assert.ok(source.includes(`account: ${account}`), `${file} does not say which account it is`);
      assert.ok(source.includes(`"${log}"`), `${file} does not name its own log`);
      assert.ok(!source.includes("getContractAt"), `${file} has its own chain code again`);
    }

    // Rehearsing is the default for all three, decided in one place.
    const rehearse = V.parseArgs(["node", "v.js", "3", "for", "why"], { defaultAaoId: 1 });
    const send = V.parseArgs(["node", "v.js", "3", "for", "why", "--send"], { defaultAaoId: 1 });
    assert.strictEqual(rehearse.dryRun, true, "the shared script sends by default");
    assert.strictEqual(send.dryRun, false, "the shared script ignores --send");
  });

  check("refs on a vote record are a list of non-empty strings, or absent", () => {
    // Free-form, like a proposal's own refs -- a commit, another proposal, a
    // spec entry, a URL. What must hold is the shape, so the card can render it
    // without guessing. Records written before proposal 29 carry none, and that
    // is a legitimate state: the log is append-only and nothing rewrites a line.
    for (const [name, records] of [["wren", wrenRecords], ["builder", builderRecords]]) {
      (records || []).forEach((record, i) => {
        if (record.refs === undefined) return;
        assert.ok(Array.isArray(record.refs), `${name} record ${i}: refs must be an array`);
        record.refs.forEach((ref, j) => {
          assert.strictEqual(typeof ref, "string", `${name} record ${i} ref ${j} is not a string`);
          assert.ok(ref.trim(), `${name} record ${i} ref ${j} is empty`);
        });
        // What the card renders, which drops blanks and duplicates.
        assert.deepStrictEqual(R.voteRefs(record), record.refs.map((r) => r.trim()).filter(Boolean)
          .filter((r, k, all) => all.indexOf(r) === k));
      });
    }
  });

  check("voteRefs reads a record the way the card renders it", () => {
    assert.deepStrictEqual(R.voteRefs({ refs: ["commit abc", "proposal 26"] }),
      ["commit abc", "proposal 26"]);
    assert.deepStrictEqual(R.voteRefs({ refs: ["  spec 27.1  ", "", "   "] }), ["spec 27.1"],
      "blanks are dropped and the rest trimmed");
    assert.deepStrictEqual(R.voteRefs({ refs: ["proposal 26", "proposal 26"] }), ["proposal 26"],
      "the same reference twice is one reference");
    // A record from before proposal 29, and a malformed one: no refs, no throw.
    assert.deepStrictEqual(R.voteRefs({ reason: "an old record" }), []);
    assert.deepStrictEqual(R.voteRefs({ refs: "not an array" }), []);
    assert.deepStrictEqual(R.voteRefs(null), []);
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

  // --- the legacy translations (27.10) -----------------------------------

  check("GET /translations.json is served and is an object", () => {
    assert.strictEqual(translationsError, null,
      `/translations.json did not answer (${translationsError})`);
    assert.ok(
      translations && typeof translations === "object" && !Array.isArray(translations),
      "/translations.json did not return a JSON object"
    );
  });

  check("every legacy proposal has a translation", () => {
    const missing = proposals
      .filter((p) => p.format.legacy && !translations[p.id])
      .map((p) => p.id);
    assert.strictEqual(missing.length, 0,
      `legacy proposals with no translation: ${missing.join(", ")}`);
  });

  check("a translation carries a title, a summary and a why", () => {
    Object.keys(translations).forEach((key) => {
      if (key.startsWith("_")) return;   // notes to the reader, not translations
      const t = translations[key];
      for (const field of ["title", "summary", "why"]) {
        assert.ok(
          typeof t[field] === "string" && t[field].trim(),
          `translation ${key} has no ${field}`
        );
      }
      assert.ok(
        t.technical === undefined || typeof t.technical === "string",
        `translation ${key} has a non-string technical`
      );
    });
  });

  check("translations belong to proposals that exist and are legacy", () => {
    const byId = new Map(allProposals.map((p) => [p.id, p]));
    Object.keys(translations).forEach((key) => {
      if (key.startsWith("_")) return;
      const id = Number(key);
      assert.ok(Number.isInteger(id), `translation key "${key}" is not a proposal id`);
      const p = byId.get(id);
      assert.ok(p, `translation ${key} names a proposal that does not exist`);
      assert.ok(
        p.format.legacy,
        `proposal ${id} is already in the 27.1 format; it should not need a translation`
      );
    });
  });

  check("a translation never replaces the chain text", () => {
    // The point of 27.10: the chain text is untouched and still there to show.
    for (const p of proposals.filter((x) => x.format.legacy)) {
      assert.ok(p.format.raw && p.format.raw.length > 0, `proposal ${p.id} lost its chain text`);
      const t = translations[p.id];
      if (!t) continue;
      assert.notStrictEqual(t.title, p.format.raw,
        `translation ${p.id} is just a copy of the chain text`);
    }
  });

  // --- the trigger evaluator (27.12 (2)) ---------------------------------

  const triggerChecks = [];
  function triggerCheck(name, fn) { triggerChecks.push({ name, fn }); }

  function withTrigger(rule, filedAt, extra) {
    return Object.assign({
      id: 99,
      aaoId: 0,
      text: "",
      format: {
        legacy: false,
        doc: Object.assign({
          title: "t", summary: "s", why: "w",
          filed_at: filedAt || "2026-09-10T00:00:00Z",
          trigger: { text: "when the thing happens", rule: rule }
        }, (extra || {}).doc || {})
      },
      createdAt: 0
    }, extra || {});
  }

  check("a trigger rule is parsed, and a bad one says why", () => {
    assert.strictEqual(W.parseRule("date:2026-01-01").kind, "date");
    assert.strictEqual(W.parseRule("count:x.json:5").kind, "count");
    assert.ok(W.parseRule("nonsense").error, "a rule with no kind should error");
    assert.ok(W.parseRule("teleport:now").error, "an unknown kind should error");
    assert.ok(W.parseRule("date:").error, "a rule with no argument should error");
  });

  check("the glob matches the way a person would read it", () => {
    const cases = [
      ["tools/fa/citations.py", "tools/fa/*.py", true],
      ["tools/fa/sub/x.py", "tools/fa/*.py", false],
      ["tools/fa/sub/x.py", "tools/**/*.py", true],
      ["tools/fa/gates.py", "tools/fa/{citations,gates}.py", true],
      ["tools/fa/other.py", "tools/fa/{citations,gates}.py", false],
      ["a.b.c", "a.b.c", true],
      ["aXbXc", "a.b.c", false]
    ];
    cases.forEach(([file, glob, want]) => {
      assert.strictEqual(
        W.globToRegExp(glob).test(file), want,
        `glob ${glob} against ${file}`
      );
    });
  });

  check("triggerOf reads a trigger, and ignores a proposal without one", () => {
    assert.ok(W.triggerOf(withTrigger("date:2020-01-01")));
    assert.strictEqual(W.triggerOf({ format: { doc: { title: "t" } } }), null);
    assert.strictEqual(W.triggerOf({ format: { legacy: true, doc: null } }), null);
  });

  console.log("");
  console.log("trigger evaluator (fixtures only, never the real incidents file):");

  // --- adoption and waiting (27.9) ---------------------------------------

  const decisions = (channel["/messages.json"].records || []).filter((m) => m.type === "decision");
  const adoptions = A.indexDecisions(decisions);

  check("every decision names a proposal and says where it has got to", () => {
    decisions.forEach((m) => {
      const id = A.proposalOf(m);
      assert.ok(
        Number.isInteger(id),
        `decision ${m.id} names no proposal; it needs refs ["proposal N"]`
      );
      const state = A.stateOf(m);
      assert.notStrictEqual(
        state.key, "unknown",
        `decision ${m.id} does not say where proposal ${id} has got to: "${String(m.summary).slice(0, 70)}"`
      );
    });
  });

  check("every decision names a proposal that exists", () => {
    const byId = new Map(allProposals.map((x) => [x.id, x]));
    decisions.forEach((m) => {
      const id = A.proposalOf(m);
      if (id === null) return;
      assert.ok(byId.get(id), `decision ${m.id} names proposal ${id}, which does not exist`);
    });
  });

  check("the adoption state reader agrees with the phrases it documents", () => {
    const table = [
      ["queued behind S12; the builder starts tomorrow.", "queued"],
      ["The builder has started on it.", "building"],
      ["Built in commit 506df15, in the widget after the next restart.", "in-widget"],
      ["Built in commit 4ebb5a5.", "built"],
      ["waiting: not until the Postman work lands.", "waiting"],
      ["back in the queue: brought back by the Director.", "back"],
      ["closed: solved by the shared mtime_cache helper.", "closed"],
      ["something that says nothing", "unknown"]
    ];
    table.forEach(([text, want]) => {
      assert.strictEqual(
        A.stateOf({ summary: text }).key, want,
        `"${text}" read as ${A.stateOf({ summary: text }).key}, expected ${want}`
      );
    });
    // "closed: solved by the build" must not read as "built".
    assert.strictEqual(A.stateOf({ summary: "closed: solved by the build in commit x" }).key, "closed");
  });

  check("the latest decision wins, so a waiting proposal can come back", () => {
    const log = [
      { type: "decision", ts: "2026-01-01T00:00:00Z", refs: ["proposal 9"], summary: "queued." },
      { type: "decision", ts: "2026-01-02T00:00:00Z", refs: ["proposal 9"], summary: "waiting: not yet." },
      { type: "decision", ts: "2026-01-03T00:00:00Z", refs: ["proposal 9"], summary: "back in the queue." }
    ];
    const index = A.indexDecisions(log);
    assert.strictEqual(A.stateOf(index[9]).key, "back");
    assert.strictEqual(A.isWaiting(A.adoptionOf(index, 9)), false);
    assert.strictEqual(A.isWaiting(A.adoptionOf(A.indexDecisions(log.slice(0, 2)), 9)), true);
  });

  check("a waiting proposal gives its reason, and a closed one names what solved it", () => {
    Object.keys(adoptions).forEach((id) => {
      const adoption = A.adoptionOf(adoptions, id);
      if (A.isWaiting(adoption)) {
        const reason = A.waitingReason(adoption);
        assert.ok(reason && reason.trim(), `proposal ${id} is waiting with no reason`);
      }
      if (A.isClosedByBuild(adoption)) {
        assert.ok(A.solvedBy(adoption), `proposal ${id} is closed but does not name what solved it`);
      }
    });
  });

  check("a waiting proposal is a real proposal and holds exactly one state", () => {
    // Waiting says nothing about the chain: a proposal can be Rejected on chain
    // and still kept in view (proposal 1 is), and 27.12(3) allows the reverse --
    // closed on the card while Active on chain. What must hold is that the
    // latest decision gives it one state, not two.
    const waiting = Object.keys(adoptions)
      .filter((id) => A.isWaiting(A.adoptionOf(adoptions, id)))
      .map(Number);
    const byId = new Map(allProposals.map((x) => [x.id, x]));
    for (const id of waiting) {
      assert.ok(byId.get(id), `proposal ${id} is waiting but does not exist`);
      const adoption = A.adoptionOf(adoptions, id);
      assert.strictEqual(
        A.isClosedByBuild(adoption), false,
        `proposal ${id} reads as both waiting and closed by a build`
      );
    }
  });

  // --- the Director's drafts (27.12) -------------------------------------

  const draftRecords = channel["/drafts.json"].records || [];
  const originalDrafts = draftRecords.filter((r) => r.text !== undefined);
  const filedDrafts = draftRecords.filter((r) => r.state === "filed");

  check("GET /drafts.json is served", () => {
    const got = channel["/drafts.json"];
    assert.strictEqual(got.error, null, `/drafts.json did not answer (${got.error})`);
    assert.ok(got.ok && Array.isArray(got.records), "/drafts.json did not return an array");
  });

  check("every draft carries the Director's text and nothing more is demanded", () => {
    originalDrafts.forEach((d, i) => {
      assert.ok(typeof d.id === "string" && d.id, `draft ${i} has no id`);
      assert.ok(typeof d.text === "string" && d.text.trim(), `draft ${d.id} has no text`);
      assert.strictEqual(d.from, "director", `draft ${d.id} is from ${d.from}`);
      assert.ok(typeof d.at === "string" && d.at, `draft ${d.id} has no timestamp`);
      assert.ok(Number.isInteger(d.aaoId), `draft ${d.id} names no organisation`);
    });
  });

  check("a filed draft points at a proposal that exists", () => {
    const byId = new Map(allProposals.map((p) => [p.id, p]));
    filedDrafts.forEach((r) => {
      assert.ok(
        originalDrafts.some((d) => d.id === r.draft),
        `filed record ${r.id} names draft ${r.draft}, which is not in the log`
      );
      assert.ok(Number.isInteger(r.proposalId), `filed record ${r.id} has no proposal id`);
      assert.ok(byId.get(r.proposalId), `filed record ${r.id} names proposal ${r.proposalId}, which does not exist`);
    });
  });

  check("a filed draft's words survived into the summary's first sentence", () => {
    const byId = new Map(allProposals.map((p) => [p.id, p]));
    filedDrafts.forEach((r) => {
      const draft = originalDrafts.filter((d) => d.id === r.draft)[0];
      const proposal = byId.get(r.proposalId);
      if (!draft || !proposal || proposal.format.legacy) return;
      const words = String(draft.text).trim().replace(/\s+/g, " ").replace(/[.!?]$/, "");
      assert.strictEqual(
        String(proposal.format.doc.summary).indexOf(words), 0,
        `proposal ${r.proposalId} does not start with the Director's own words from ${draft.id}`
      );
    });
  });

  check("the drafts log is append-only: a draft line is never rewritten", () => {
    // Every id appears at most once as an original; filing adds a record, it
    // does not edit one.
    const seenDraftIds = new Set();
    originalDrafts.forEach((d) => {
      assert.ok(!seenDraftIds.has(d.id), `draft ${d.id} appears twice as an original`);
      seenDraftIds.add(d.id);
    });
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

  // --- the message id (proposal 26) --------------------------------------

  check("the same message written twice is one message, not two", () => {
    // What proposal 26 is for. Under the old clock-based scheme these were two
    // ids, so a retry after a crash counted as two incidents and could invent a
    // builder item that never happened.
    const say = () => P.normalise({
      from: "widget", type: "incident",
      subject: "Citations went stale for one turn after a KBA edit",
      summary: "The citation cache kept the old body for one turn."
    });
    assert.strictEqual(say().id, say().id, "two writings of one message must share an id");

    // And two messages that say different things do not.
    const other = P.normalise({
      from: "widget", type: "incident",
      subject: "Citations went stale for one turn after a KBA edit",
      summary: "Something else happened."
    });
    assert.notStrictEqual(say().id, other.id);

    // ts is out of the fingerprint on purpose: a retry gets a new clock and must
    // keep its id. refs are out too -- a corrector may add a reference without
    // changing what was said.
    const withTs = P.normalise(Object.assign(say(), { id: "", ts: "2020-01-01T00:00:00.000Z" }));
    const withRefs = P.normalise(Object.assign(say(), { id: "", refs: ["incident-1", "commit abc"] }));
    assert.strictEqual(withTs.id, say().id, "the clock must not change the id");
    assert.strictEqual(withRefs.id, say().id, "a added reference must not change the id");
  });

  check("an id computed here is the id protocol.py computes", () => {
    // The whole point of proposal 26 is that both implementations number the
    // same message the same way. These ids were produced by the widget's
    // protocol.py; if this file's scheme drifts -- a different field set, a
    // different canonical form, a different digest length -- they stop matching
    // and this says so before anything is written with the wrong number.
    //
    // Regenerate with, from the widget's directory:
    //   python -c "import json,protocol as P; print(P.normalise({...})['id'])"
    const fromPython = [
      [{ from: "widget", type: "incident", subject: "S", summary: "P" },
        "incident-5d629ac9f82cca"],
      [{ from: "builder", to: "wren", type: "status",
        subject: "Working on the cache key",
        summary: "Half done. Nothing needed.",
        details: "citations.py line 40" },
        "status-6b55dd1ab61d33"],
      [{ from: "wren", type: "decision",
        subject: "Proposal 26: executed automatically",
        summary: "It passed 2 to 0. Decisive with every vote in.",
        details: "executed by Wren in block 7",
        refs: ["proposal 26"] },
        "decision-c226dbb8b4fabe"],
      // Non-ASCII, because the canonical form is ensure_ascii=False on both
      // sides and a wrong UTF-8 encoding would only show up here.
      [{ from: "widget", type: "incident",
        subject: "café — naïve 日本語",
        summary: "unicode 🙂 in the subject",
        details: "line one\nline two\ttabbed" },
        "incident-349898fd758b9e"],
      // Characters JSON has to escape, on both sides, the same way.
      [{ from: "director", type: "question",
        subject: 'a quote " and a backslash \\',
        summary: "punctuation that JSON has to escape",
        details: "carriage\rreturn and a null-ish \u0001 byte" },
        "question-27a85f72ea8926"],
      [{ from: "builder", type: "status", subject: "no details at all",
        summary: "details defaults to the empty string" },
        "status-f44bcf533173b0"]
    ];

    for (const [partial, expected] of fromPython) {
      const got = P.normalise(JSON.parse(JSON.stringify(partial))).id;
      assert.strictEqual(got, expected,
        `protocol.py numbers this message ${expected}; protocol.js gave ${got}`);
    }
  });

  check("the digest is sha256, the one everybody else computes", () => {
    // protocol.js carries its own sha256 because it loads in the browser too,
    // where the platform's is asynchronous and an id cannot wait for it. That
    // is only safe while it agrees with a real one.
    const crypto = require("crypto");
    const cases = ["", "abc", "a".repeat(1000), "café 🙂", '{"a": null}'];
    for (const text of cases) {
      assert.strictEqual(
        P.sha256Hex(text),
        crypto.createHash("sha256").update(text, "utf8").digest("hex"),
        `sha256 disagrees with node's on ${JSON.stringify(text.slice(0, 20))}`
      );
    }
  });

  check("a message whose identity is more than its words says which fields", () => {
    // "Why?" asked on proposal 3 and on proposal 5 are two questions. The six
    // fields do not tell them apart, so the question channel names the proposal
    // as part of the identity -- and the answers that point at a question id
    // then point at one question.
    const ask = (proposalId) => P.normalise({
      from: "director", to: "wren", type: "question",
      subject: "Why?", summary: "Why?",
      proposal: proposalId, aaoId: 0
    }, { idFields: ["proposal", "aaoId"] });

    assert.notStrictEqual(ask(3).id, ask(5).id, "one id for two questions");
    assert.strictEqual(ask(3).id, ask(3).id, "and the same question is still one id");

    // Without the extra fields they would collide, which is exactly why they
    // are named.
    const bare = (proposalId) => P.normalise({
      from: "director", to: "wren", type: "question",
      subject: "Why?", summary: "Why?", proposal: proposalId, aaoId: 0
    });
    assert.strictEqual(bare(3).id, bare(5).id,
      "the six fields alone cannot tell these apart -- that is the reason for idFields");
  });

  check("every message already on file has an id nothing else shares", () => {
    // The records written before proposal 26 carry clock-based ids and stay as
    // they are -- the logs are append-only and nothing here rewrites one. What
    // must hold either way is that no two messages answer to the same name.
    const seen = new Map();
    for (const route of ["/questions.json", "/answers.json", "/messages.json"]) {
      for (const record of channel[route].records || []) {
        if (!record || !record.id) continue;
        const where = seen.get(record.id);
        assert.ok(!where, `id ${record.id} is in both ${where} and ${route}`);
        seen.set(record.id, route);
      }
    }
  });

  // --- the trigger rules, evaluated against fixtures ---------------------

  async function checkAsync(name, fn) {
    await fn();
    checks.push(name);
  }

  await checkAsync("incident-key fires only on an incident filed after the proposal", async () => {
    // The fixture has two "stale-cache" incidents: 2026-09-01 and 2026-09-18.
    const earlyProposal = withTrigger("incident-key:stale-cache", "2026-09-10T00:00:00Z");
    const early = await W.evaluate(W.triggerOf(earlyProposal), earlyProposal, FIXTURES);
    assert.strictEqual(early.fired, true, early.because);

    const lateProposal = withTrigger("incident-key:stale-cache", "2026-09-20T00:00:00Z");
    const late = await W.evaluate(W.triggerOf(lateProposal), lateProposal, FIXTURES);
    assert.strictEqual(late.fired, false, "an incident from before the proposal is not news");

    const noneProposal = withTrigger("incident-key:never-happened", "2026-01-01T00:00:00Z");
    const none = await W.evaluate(W.triggerOf(noneProposal), noneProposal, FIXTURES);
    assert.strictEqual(none.fired, false, none.because);
  });

  await checkAsync("version fires when the widget reaches it, and not before", async () => {
    // The fixture says VERSION = "1.4.0".
    const cases = [["1.3.0", true], ["1.4.0", true], ["1.5.0", false], ["2.0.0", false]];
    for (const [want, fired] of cases) {
      const proposal = withTrigger("version:" + want);
      const result = await W.evaluate(W.triggerOf(proposal), proposal, FIXTURES);
      assert.strictEqual(result.fired, fired, `version:${want} -- ${result.because}`);
    }
  });

  await checkAsync("date fires once the date has passed", async () => {
    const past = withTrigger("date:2020-01-01");
    const future = withTrigger("date:2099-01-01");
    assert.strictEqual((await W.evaluate(W.triggerOf(past), past, FIXTURES)).fired, true);
    assert.strictEqual((await W.evaluate(W.triggerOf(future), future, FIXTURES)).fired, false);
    const bad = withTrigger("date:not-a-date");
    assert.strictEqual((await W.evaluate(W.triggerOf(bad), bad, FIXTURES)).fired, false);
  });

  await checkAsync("count fires when a report crosses the line", async () => {
    // stale-names.json holds {"count": 42}; bare.txt holds 7.
    const cases = [
      ["count:stale-names.json:40", true],
      ["count:stale-names.json:42", true],
      ["count:stale-names.json:50", false],
      ["count:bare.txt:5", true],
      ["count:bare.txt:9", false],
      ["count:no-such-report.json:1", false]
    ];
    for (const [rule, fired] of cases) {
      const proposal = withTrigger(rule);
      const result = await W.evaluate(W.triggerOf(proposal), proposal, FIXTURES);
      assert.strictEqual(result.fired, fired, `${rule} -- ${result.because}`);
    }
  });

  await checkAsync("a count rule may not read outside the reports directory", async () => {
    const proposal = withTrigger("count:../../package.json:1");
    const result = await W.evaluate(W.triggerOf(proposal), proposal, FIXTURES);
    assert.strictEqual(result.fired, false);
    assert.ok(/outside the reports directory/.test(result.because), result.because);
  });

  check("the reports directory a count rule reads from exists", () => {
    // Without it no count: trigger can ever fire, and the failure reads exactly
    // like a count that has not been reached yet. Git cannot carry an empty
    // directory, so governance/reports/README.md is what keeps this true.
    assert.ok(fs.existsSync(W.DEFAULTS.reportDir),
      `there is no reports directory at ${W.DEFAULTS.reportDir}; ` +
      "no count: trigger can fire until there is one");
  });

  await checkAsync("a missing reports directory says so, instead of looking like a low count",
    async () => {
      const os = require("os");
      const gone = path.join(os.tmpdir(), "governance-reports-gone-" + Date.now());
      const proposal = withTrigger("count:anything.json:1");
      const result = await W.evaluate(
        W.triggerOf(proposal), proposal, Object.assign({}, FIXTURES, { reportDir: gone }));
      assert.strictEqual(result.fired, false);
      assert.strictEqual(result.invalid, true, "a rule that can never fire must be reported as broken");
      assert.ok(/no reports directory/.test(result.because), result.because);
    });

  await checkAsync("a broken rule reports itself instead of firing", async () => {
    for (const rule of ["nonsense", "teleport:now", "date:"]) {
      const proposal = withTrigger(rule);
      const trigger = W.triggerOf(proposal) || { rule: rule, parsed: W.parseRule(rule) };
      const result = await W.evaluate(trigger, proposal, FIXTURES);
      assert.strictEqual(result.fired, false, rule);
      assert.ok(result.because, `${rule} gave no reason`);
    }
  });

  await checkAsync("a fired trigger posts one message, and only one", async () => {
    const os = require("os");
    const tmp = path.join(os.tmpdir(), "governance-watch-check-" + Date.now() + ".jsonl");
    const proposal = withTrigger("date:2020-01-01");
    proposal.id = 4242;

    const first = await W.runOnce([proposal], Object.assign({}, FIXTURES, { messagesFile: tmp }));
    assert.strictEqual(first.fired.length, 1, "the first pass should fire");
    const message = first.fired[0].message;
    assert.strictEqual(message.from, "watch");
    assert.strictEqual(message.type, "status");
    assert.strictEqual(P.validate(message).ok, true, P.validate(message).errors.join("; "));
    assert.deepStrictEqual(message.refs, ["proposal 4242"]);
    assert.ok(/when the thing happens/.test(message.summary), message.summary);

    const second = await W.runOnce([proposal], Object.assign({}, FIXTURES, { messagesFile: tmp }));
    assert.strictEqual(second.fired.length, 0, "a trigger that fired must not fire again");

    fs.unlinkSync(tmp);
  });

  await checkAsync("a proposal with no trigger is never touched", async () => {
    const os = require("os");
    const tmp = path.join(os.tmpdir(), "governance-watch-none-" + Date.now() + ".jsonl");
    const plain = { id: 7, aaoId: 0, format: { legacy: false, doc: { title: "t" } } };
    const result = await W.runOnce([plain], Object.assign({}, FIXTURES, { messagesFile: tmp }));
    assert.strictEqual(result.fired.length, 0);
    assert.strictEqual(result.looked.length, 0);
    assert.strictEqual(fs.existsSync(tmp), false, "nothing should have been written");
  });

  // --- how each organisation decides -------------------------------------

  check("each organisation has a rule set with plain-English lines", () => {
    for (const a of aaos) {
      const rules = R.rulesFor(a);
      assert.ok(Array.isArray(rules.plain) && rules.plain.length,
        `AAO ${a.id} ("${a.topic}") has no plain-English rules`);
      rules.plain.forEach((line) => {
        assert.ok(typeof line === "string" && line.trim(), `AAO ${a.id} has an empty rule line`);
      });
    }
  });

  check("the Director votes on the main organisation and watches the sub-AAO", () => {
    const main = R.rulesFor("trilogy widget");
    const sub = R.rulesFor("widget-builder");

    assert.strictEqual(R.voterProblem(main, R.DIRECTOR), null, "the Director votes on the main AAO");
    assert.strictEqual(R.voterProblem(main, R.WREN), null);
    assert.ok(R.voterProblem(sub, R.DIRECTOR), "the Director must not vote on the sub-AAO");
    assert.ok(/watches/.test(R.voterProblem(sub, R.DIRECTOR)), R.voterProblem(sub, R.DIRECTOR));
    assert.strictEqual(R.voterProblem(sub, R.BUILDER), null);
    assert.strictEqual(R.voterProblem(sub, R.WIDGET), null);
    assert.strictEqual(R.voterProblem(sub, R.WREN), null, "Wren is the sub-AAO's casting vote");
    assert.strictEqual(R.sameAddress(sub.casting, R.WREN), true);
    assert.strictEqual(R.sameAddress(main.casting, R.CASTING), true);
  });

  check("the sub-AAO executes automatically, on the rules it publishes", () => {
    const sub = R.rulesFor("widget-builder");
    const now = 1000000;
    // The window runs from the first vote, so the votes carry the age, not the
    // filing. `filedHoursAgo` is separate and deliberately long: a proposal that
    // has been sitting there for a month must still give its window.
    const make = (f, a, voters, voteAgeHours, filedHoursAgo) => ({
      status: 0, forVotes: f, againstVotes: a,
      createdAt: now - (filedHoursAgo === undefined ? 30 * 24 : filedHoursAgo) * 3600,
      votes: voters.map((v) => ({ voter: v, support: true, at: now - voteAgeHours * 3600 }))
    });

    const both = R.autoExecuteState(sub, make(2, 0, [R.BUILDER, R.WIDGET], 1), now);
    assert.strictEqual(both.should, true, both.reason);
    assert.strictEqual(R.sameAddress(both.by, R.WREN), true, "the sub-AAO executes as Wren");

    const level = R.autoExecuteState(sub, make(1, 1, [R.BUILDER, R.WIDGET], 1), now);
    assert.strictEqual(level.should, false);
    assert.strictEqual(level.tied, true, "a level tally with both votes in notifies Wren");
    assert.ok(/Wren breaks it/.test(level.reason), level.reason);

    const fresh = R.autoExecuteState(sub, make(1, 0, [R.BUILDER], 1), now);
    assert.strictEqual(fresh.should, false, "a builder-only vote waits out the window");

    const aged = R.autoExecuteState(sub, make(1, 0, [R.BUILDER], 25), now);
    assert.strictEqual(aged.should, true, aged.reason);

    const none = R.autoExecuteState(sub, make(0, 0, [], 48), now);
    assert.strictEqual(none.should, false, "no votes, nothing to execute");

    // A vote nobody can date does not start a window. Falling back to the filing
    // time is what closed 26, 29 and 30 on the spot: the proposals were older
    // than the window, so the first vote executed them immediately.
    const undated = {
      status: 0, forVotes: 1, againstVotes: 0, createdAt: now - 30 * 24 * 3600,
      votes: [{ voter: R.BUILDER, support: true }]
    };
    const blind = R.autoExecuteState(sub, undated, now);
    assert.strictEqual(blind.should, false,
      "an undated vote must not execute a month-old proposal on the spot");
    assert.ok(/cannot be measured/.test(blind.reason), blind.reason);

    const main = R.rulesFor("trilogy widget");
    assert.strictEqual(R.autoExecuteState(main, make(1, 0, [R.DIRECTOR], 1), now).should, false,
      "the main organisation executes on the Director's vote, not on a timer");
  });

  // --- the interim rule on the widget-builder ----------------------------

  check("the widget-builder runs whichever rule the chain says, and says which", () => {
    const now = 1000000;
    const under = (voters) => R.effectiveRules(
      { topic: "widget-builder" },
      [{ votes: voters.map((v) => ({ voter: v })) }]
    );

    const interim = under([R.BUILDER]);
    assert.strictEqual(interim.interim, true, "the widget has never voted, so the interim rule runs");
    assert.ok(interim.regime && /interim/i.test(interim.regime), interim.regime);
    assert.deepStrictEqual(interim.voters.map(R.labelFor), ["Builder", "Wren"]);
    assert.strictEqual(interim.casting, null, "two voters leave nobody to break their tie");
    assert.strictEqual(interim.windowHours, 1);

    // The widget keeps its standing throughout: its first vote is the only thing
    // that ends this regime, so a rule that barred it could never be lifted.
    assert.strictEqual(R.voterProblem(interim, R.WIDGET), null,
      "the widget must still be able to cast the vote that ends the interim rule");
    assert.strictEqual(R.voterProblem(interim, R.WREN), null);
    assert.ok(/watches/.test(R.voterProblem(interim, R.DIRECTOR) || ""),
      "the Director still only watches");

    const standing = under([R.WIDGET]);
    assert.notStrictEqual(standing.interim, true, "the widget has voted, so the standing rule is back");
    assert.deepStrictEqual(standing.voters.map(R.labelFor), ["Builder", "Widget"]);
    assert.strictEqual(R.sameAddress(standing.casting, R.WREN), true);
    assert.strictEqual(standing.windowHours, 24);

    // And the interim window really is one hour, measured from the vote.
    const lone = {
      status: 0, forVotes: 1, againstVotes: 0, createdAt: now - 30 * 24 * 3600,
      votes: [{ voter: R.BUILDER, support: true, at: now - 30 * 60 }]
    };
    assert.strictEqual(R.autoExecuteState(interim, lone, now).should, false,
      "half an hour after a lone vote it holds");
    lone.votes[0].at = now - 61 * 60;
    assert.strictEqual(R.autoExecuteState(interim, lone, now).should, true,
      "an hour and a minute after a lone vote it carries");

    // Both voters in and decisive: no window at all.
    const agreed = {
      status: 0, forVotes: 2, againstVotes: 0, createdAt: now - 3600,
      votes: [
        { voter: R.BUILDER, support: true, at: now - 60 },
        { voter: R.WREN, support: true, at: now - 30 }
      ]
    };
    const decided = R.autoExecuteState(interim, agreed, now);
    assert.strictEqual(decided.should, true, decided.reason);
    assert.strictEqual(R.sameAddress(decided.by, R.WREN), true);

    // Level, with no tie-breaker: it pins and says so rather than naming nobody.
    const tied = {
      status: 0, forVotes: 1, againstVotes: 1, createdAt: now - 3600,
      votes: [
        { voter: R.BUILDER, support: true, at: now - 60 },
        { voter: R.WREN, support: false, at: now - 30 }
      ]
    };
    const pinned = R.autoExecuteState(interim, tied, now);
    assert.strictEqual(pinned.should, false);
    assert.strictEqual(pinned.tied, true);
    assert.ok(/no tie-breaker/.test(pinned.reason), pinned.reason);
  });

  // --- no control characters in tracked source ---------------------------

  check("no tracked source file carries a raw control character", () => {
    // The pre-commit hook in .githooks runs this too, but a hook is per clone
    // and this is not. Twice a heredoc ate the backslashes in a regex and left
    // backspace bytes behind; the regex still parsed, matched nothing, and the
    // guard it broke let a real vote through.
    const result = CTRL.run({ mode: "all", files: [] });
    assert.ok(result.scanned > 0, "no source files were scanned");
    assert.strictEqual(
      result.bad.length, 0,
      "control characters in tracked source:" + "\n" + CTRL.report(result)
    );
  });

  check("the control-character checker actually catches one", () => {
    // A checker whose own pattern was mangled would report a clean repo
    // forever. Hand it a line with a backspace in it and make it say so.
    const bs = String.fromCharCode(8);
    const found = CTRL.offences("const r = /" + bs + "word" + bs + "/;");
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].count, 2);
    assert.ok(found[0].codes.indexOf("0x08") !== -1);
    // Tab, newline and carriage return are not offences.
    assert.strictEqual(CTRL.offences("a" + String.fromCharCode(9) + "b" + String.fromCharCode(10) + "c" + String.fromCharCode(13) + String.fromCharCode(10) + "d").length, 0);
  });

  // --- the vote guard ----------------------------------------------------

  check("a vote on an unfiled proposal id is refused", () => {
    // The bug this closes: AAOFacet.vote() accepts an id that was never filed,
    // records hasVoted against the zero struct, and the real vote is then
    // refused with "Already voted". A vote was lost that way on id 27.
    assert.ok(R.voteTargetProblem(27, { text: "", createdAt: 0 }));
    assert.ok(R.voteTargetProblem(27, { text: "   ", createdAt: 0 }));
    assert.ok(R.voteTargetProblem(27, { text: "something", createdAt: 0 }));
    assert.strictEqual(R.voteTargetProblem(3, { text: "filed", createdAt: 123 }), null);
  });

  check("a vote is refused when the proposal is not the one you read", () => {
    const filed = { text: JSON.stringify({ title: "A thing", summary: "s", why: "w" }), createdAt: 1 };
    assert.ok(R.voteTargetProblem(3, filed, { title: "Another thing" }));
    assert.strictEqual(R.voteTargetProblem(3, filed, { title: "  a  THING " }), null);
    assert.ok(R.voteTargetProblem(3, filed, { text: "different text entirely" }));
    assert.strictEqual(R.voteTargetProblem(3, filed, { text: filed.text }), null);
  });

  check("every proposal on chain would pass the vote guard", () => {
    for (const p of allProposals) {
      assert.strictEqual(
        R.voteTargetProblem(p.id, p), null,
        `proposal ${p.id} would be refused by the vote guard`
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
