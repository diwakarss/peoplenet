// governance/read.js -- the data layer for the governance page.
//
// One module, two homes: require() it from Node (scripts, governance/check.js)
// or drop it in a <script> tag next to the ethers UMD bundle and use
// window.GovernanceRead. It never creates a provider or a signer of its own;
// callers hand it an `ethers` namespace and a provider, so the browser can use
// the CDN build and Node can use the one in node_modules.
//
// Everything here is a read. Writes (vote / casting vote / execute) live in
// app.js and wren-vote.js, where they are one operator click or one Wren
// command each.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GovernanceRead = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // The local chain the page and the scripts talk to (spec section 24, WP17d).
  var RPC_URL = "http://127.0.0.1:8545";
  var CHAIN_ID = 31337;
  var DIAMOND = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
  var AAO_ID = 0;

  // The three governance roles, as Hardhat's default accounts. These are the
  // public addresses only; the matching private keys are Hardhat's well-known
  // defaults, they live in the node, and nothing here ever holds or shows one.
  var DIRECTOR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // account 0, deployer + AAO creator
  var WREN = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";     // account 1, the architect session
  var CASTING = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";  // account 2, the Director's casting vote

  // The widget-builder sub-AAO (27.4) adds two more: the builder that writes the
  // code and the widget that reports on its own behaviour.
  var BUILDER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // account 3
  var WIDGET = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";  // account 4

  var ROLES = [
    { key: "director", label: "Director", address: DIRECTOR, ordinary: true },
    { key: "wren", label: "Wren", address: WREN, ordinary: true },
    { key: "casting", label: "Casting vote", address: CASTING, ordinary: false },
    { key: "builder", label: "Builder", address: BUILDER, ordinary: true },
    { key: "widget", label: "Widget", address: WIDGET, ordinary: true }
  ];

  // What each AAO is for, in one line, for the tree and the AAO list.
  var AAO_NOTES = {
    "trilogy widget": "Where the Director decides what the widget should become.",
    "widget-builder": "Where the widget, its builder and Wren work out what to propose."
  };

  // --- who decides where -------------------------------------------------
  //
  // The two organisations do not govern the same way, and the difference is not
  // a detail of the page: it is the rule. So it lives here, once, and the page,
  // the scripts and the checks all read it from the same place. Each rule set
  // carries its own plain-English lines, which the page prints on the header --
  // a rule nobody can read is a rule nobody can hold you to.
  //
  // Keyed by topic, because a topic is stabler than an id.
  var AAO_RULES = {
    "trilogy widget": {
      key: "main",
      voters: [DIRECTOR, WREN],
      viewers: [],
      casting: CASTING,
      // The Director's vote settles it: the page executes as soon as the vote
      // confirms and the tally is not level.
      autoExecute: "on-director-vote",
      executeAs: DIRECTOR,
      windowHours: null,
      plain: [
        "The Director and Wren each have one vote.",
        "The Director's vote settles it: the page executes straight away unless the tally is level.",
        "A level tally is broken by the Director's casting vote, and by nothing else."
      ]
    },
    "widget-builder": {
      key: "sub",
      voters: [BUILDER, WIDGET],
      viewers: [DIRECTOR],
      casting: WREN,
      // Nobody presses a button here: the watcher, or the last voter's script,
      // executes once the tally is decisive.
      autoExecute: "automatic",
      executeAs: WREN,
      windowHours: 24,
      plain: [
        "The builder and the widget vote. The Director watches and never votes here.",
        "Wren votes only to break a level tally, after both have voted.",
        "Execution is automatic: a decisive tally with both votes in, or after 24 hours with at least one vote and a decisive tally.",
        "A level tally after both have voted notifies Wren and pins the proposal."
      ]
    }
  };

  var DEFAULT_RULES = {
    key: "default",
    voters: [],
    viewers: [],
    casting: null,
    autoExecute: "none",
    executeAs: null,
    windowHours: null,
    plain: ["Every member has one vote, and a proposal passes on more for than against."]
  };

  // The rule set for an organisation. Takes an AAO object or a topic.
  function rulesFor(aao) {
    var topic = aao && aao.topic !== undefined ? aao.topic : aao;
    return AAO_RULES[topic] || DEFAULT_RULES;
  }

  function mayVote(rules, address) {
    var r = rules || DEFAULT_RULES;
    if (r.voters.some(function (a) { return sameAddress(a, address); })) return true;
    return Boolean(r.casting && sameAddress(r.casting, address));
  }

  function isViewerOnly(rules, address) {
    var r = rules || DEFAULT_RULES;
    return r.viewers.some(function (a) { return sameAddress(a, address); }) &&
      !r.voters.some(function (a) { return sameAddress(a, address); });
  }

  // Why an account may not vote here, in a sentence, or null when it may.
  function voterProblem(rules, address) {
    var r = rules || DEFAULT_RULES;
    if (mayVote(r, address)) return null;
    if (isViewerOnly(r, address)) {
      return labelFor(address) + " watches this organisation and does not vote in it.";
    }
    return labelFor(address) + " is not one of its voters (" +
      r.voters.map(labelFor).join(", ") + ").";
  }

  // Minimal human-readable ABI: exactly the AAOFacet surface the page touches.
  var AAO_ABI = [
    "function getAAO(uint256 aaoId) view returns (tuple(string topic, uint256 duration, address owner, bool active, bool isMacro, address[] members, uint256 macroAAOId))",
    "function getProposal(uint256 proposalId) view returns (tuple(uint256 id, uint256 aaoId, address proposer, string text, uint256 forVotes, uint256 againstVotes, uint8 status, uint256 createdAt))",
    "function getMembers(uint256 aaoId) view returns (address[])",
    "function getMembersCount(uint256 aaoId) view returns (uint256)",
    "function isMember(uint256 aaoId, address member) view returns (bool)",
    "function aaoCount() view returns (uint256)",
    "function joinAAO(uint256 aaoId)",
    "function submitProposal(uint256 aaoId, string proposalText) returns (uint256)",
    "function vote(uint256 proposalId, bool support)",
    "function executeProposal(uint256 proposalId)",
    "event AAOCreated(uint256 indexed aaoId, string topic, address indexed owner, uint256 duration)",
    "event AAOMemberJoined(uint256 indexed aaoId, address indexed member)",
    "event ProposalSubmitted(uint256 indexed aaoId, uint256 indexed proposalId, address indexed proposer, string text)",
    "event VoteCast(uint256 indexed aaoId, uint256 indexed proposalId, address indexed voter, bool support)",
    "event ProposalExecuted(uint256 indexed aaoId, uint256 indexed proposalId, bool passed)"
  ];

  // LibAAO.ProposalStatus
  var STATUS = ["Active", "Executed", "Rejected"];

  function lower(a) {
    return String(a || "").toLowerCase();
  }

  function sameAddress(a, b) {
    return lower(a) === lower(b);
  }

  function shortAddress(address) {
    var a = String(address || "");
    return a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : a;
  }

  // "Director" / "Wren" / "Casting vote", or a short 0x1234...cdef for anyone else.
  function labelFor(address) {
    for (var i = 0; i < ROLES.length; i++) {
      if (sameAddress(ROLES[i].address, address)) return ROLES[i].label;
    }
    return shortAddress(address);
  }

  function roleFor(address) {
    for (var i = 0; i < ROLES.length; i++) {
      if (sameAddress(ROLES[i].address, address)) return ROLES[i];
    }
    return null;
  }

  function num(v) {
    return typeof v === "bigint" ? Number(v) : Number(v || 0);
  }

  // Build the AAOFacet handle. `runner` is a provider (reads) or a signer (writes).
  function getContract(ethers, runner, diamond) {
    return new ethers.Contract(diamond || DIAMOND, AAO_ABI, runner);
  }

  function getProvider(ethers, url) {
    // staticNetwork: the local chain never changes id, so skip the re-detection
    // round trip on every call.
    return new ethers.JsonRpcProvider(
      url || RPC_URL,
      { chainId: CHAIN_ID, name: "hardhat-local" },
      { staticNetwork: true }
    );
  }

  // --- reads -------------------------------------------------------------

  // The AAO itself. createdAt is not a struct field, so it comes from the block
  // that carried the AAOCreated event.
  async function readAAO(contract, aaoId) {
    var id = aaoId === undefined ? AAO_ID : aaoId;
    var raw = await contract.getAAO(id);
    var createdAt = null;
    try {
      var logs = await contract.queryFilter(contract.filters.AAOCreated(id), 0, "latest");
      if (logs.length) {
        var block = await logs[0].getBlock();
        createdAt = num(block.timestamp);
      }
    } catch (e) {
      // An RPC without log history still gives a usable page; just no timestamp.
    }
    var members = (raw.members || []).map(function (address) {
      var role = roleFor(address);
      return {
        address: address,
        label: labelFor(address),
        role: role ? role.key : null,
        ordinary: role ? role.ordinary : true,
        isCreator: sameAddress(address, raw.owner)
      };
    });
    return {
      id: num(id),
      topic: raw.topic,
      creator: raw.owner,
      creatorLabel: labelFor(raw.owner),
      active: raw.active,
      isMacro: raw.isMacro,
      duration: num(raw.duration),
      createdAt: createdAt,
      members: members
    };
  }

  // Every proposal on the AAO. The id list comes from ProposalSubmitted (the
  // facet has no proposalCount getter); the live tallies come from getProposal,
  // so a refresh always shows the chain, not the event history.
  async function readProposals(contract, aaoId) {
    var id = aaoId === undefined ? AAO_ID : aaoId;
    var submitted = await contract.queryFilter(contract.filters.ProposalSubmitted(id), 0, "latest");
    var voteLogs = await contract.queryFilter(contract.filters.VoteCast(id), 0, "latest");
    var executedLogs = await contract.queryFilter(contract.filters.ProposalExecuted(id), 0, "latest");

    var votesByProposal = {};
    voteLogs.forEach(function (log) {
      var pid = num(log.args.proposalId);
      (votesByProposal[pid] = votesByProposal[pid] || []).push({
        voter: log.args.voter,
        label: labelFor(log.args.voter),
        support: Boolean(log.args.support),
        blockNumber: log.blockNumber
      });
    });

    var outcomeByProposal = {};
    executedLogs.forEach(function (log) {
      outcomeByProposal[num(log.args.proposalId)] = Boolean(log.args.passed);
    });

    var ids = submitted
      .map(function (log) { return num(log.args.proposalId); })
      .filter(function (v, i, a) { return a.indexOf(v) === i; })
      .sort(function (a, b) { return a - b; });

    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var p = await contract.getProposal(ids[i]);
      var votes = (votesByProposal[ids[i]] || []).slice().sort(function (a, b) {
        return a.blockNumber - b.blockNumber;
      });
      var status = num(p.status);
      out.push({
        id: num(p.id),
        aaoId: num(p.aaoId),
        text: p.text,
        format: parseProposalText(p.text),
        proposer: p.proposer,
        proposerLabel: labelFor(p.proposer),
        forVotes: num(p.forVotes),
        againstVotes: num(p.againstVotes),
        status: status,
        statusLabel: STATUS[status] || "Unknown",
        createdAt: num(p.createdAt),
        votes: votes,
        outcome: ids[i] in outcomeByProposal ? outcomeByProposal[ids[i]] : null
      });
    }
    return out;
  }

  // Every AAO on the chain, in id order, each with its members and its
  // plain-English line. The page's AAO list and the structure tree both use it.
  async function readAAOs(contract) {
    var count = num(await contract.aaoCount());
    var out = [];
    for (var id = 0; id < count; id++) {
      var aao = await readAAO(contract, id);
      aao.note = AAO_NOTES[aao.topic] || "";
      out.push(aao);
    }
    return out;
  }

  // One shot for the page: every AAO, one of them read in full with its
  // proposals, and the block it was all read at.
  async function readGovernance(ethers, provider, options) {
    var opts = options || {};
    var contract = getContract(ethers, provider, opts.diamond);
    var aaos = await readAAOs(contract);
    var aaoId = opts.aaoId === undefined ? AAO_ID : opts.aaoId;
    if (!aaos.some(function (a) { return a.id === aaoId; })) aaoId = aaos.length ? aaos[0].id : AAO_ID;
    var aao = aaos.filter(function (a) { return a.id === aaoId; })[0] || await readAAO(contract, aaoId);
    var proposals = await readProposals(contract, aaoId);
    var blockNumber = await provider.getBlockNumber();
    return { aaos: aaos, aao: aao, proposals: proposals, blockNumber: blockNumber };
  }

  // Every proposal on every AAO, for the tree and the search.
  async function readAllProposals(contract, aaos) {
    var out = [];
    for (var i = 0; i < aaos.length; i++) {
      var list = await readProposals(contract, aaos[i].id);
      list.forEach(function (p) { out.push(p); });
    }
    return out;
  }

  // --- the proposal format (27.1) ----------------------------------------

  // A proposal's on-chain text is a JSON document. Everything a person reads
  // first is plain English; the technical part sits underneath.
  var PROPOSAL_FIELDS =
    ["title", "summary", "why", "technical", "risk", "effort", "refs", "from", "filed_at"];
  var PROPOSAL_REQUIRED = ["title", "summary", "why"];

  // Refuse a proposal nobody could read: no title, no plain-English summary, no
  // reason. The filing scripts call this before they spend a transaction.
  function validateProposalDoc(doc) {
    var errors = [];
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      return { ok: false, errors: ["a proposal must be a JSON object"] };
    }
    PROPOSAL_REQUIRED.forEach(function (field) {
      if (typeof doc[field] !== "string" || !doc[field].trim()) {
        errors.push(field + " is required and must be a non-empty string");
      }
    });
    if (doc.refs !== undefined && !Array.isArray(doc.refs)) {
      errors.push("refs must be an array when present");
    }
    ["technical", "risk", "effort", "from", "filed_at"].forEach(function (field) {
      if (doc[field] !== undefined && doc[field] !== null && typeof doc[field] !== "string") {
        errors.push(field + " must be a string when present");
      }
    });
    return { ok: errors.length === 0, errors: errors };
  }

  // Read a proposal's on-chain text. Proposals filed as free text before 27.1
  // are rendered exactly as they were written and marked legacy; nothing is
  // re-filed to make the page tidier.
  function parseProposalText(text) {
    var raw = typeof text === "string" ? text : String(text || "");
    var trimmed = raw.trim();
    if (!trimmed || trimmed.charAt(0) !== "{") {
      return { legacy: true, raw: raw, doc: null, valid: null };
    }
    var doc;
    try {
      doc = JSON.parse(trimmed);
    } catch (e) {
      return { legacy: true, raw: raw, doc: null, valid: null };
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      return { legacy: true, raw: raw, doc: null, valid: null };
    }
    // JSON carrying none of the format's fields is not a 27.1 document; show it
    // as written rather than inventing headings for it.
    var recognised = PROPOSAL_FIELDS.some(function (f) { return doc[f] !== undefined; });
    if (!recognised) return { legacy: true, raw: raw, doc: null, valid: null };

    return { legacy: false, raw: raw, doc: doc, valid: validateProposalDoc(doc) };
  }

  // The one line that stands for a proposal in a list, a tree or a notification.
  function proposalHeadline(proposal) {
    var parsed = (proposal && proposal.format) || parseProposalText(proposal && proposal.text);
    if (!parsed.legacy && parsed.doc && parsed.doc.title) return String(parsed.doc.title);
    var line = String(parsed.raw || "").split(/\r?\n/)[0].trim();
    if (!line) return "(no text)";
    return line.length > 110 ? line.slice(0, 109) + "…" : line;
  }

  function isUrl(ref) {
    return /^https?:\/\//i.test(String(ref || ""));
  }

  // --- who may be voted on -----------------------------------------------

  // A proposal id that was never filed reads back as a zero struct: empty text,
  // createdAt 0, status 0 (Active). AAOFacet.vote() has no createdAt guard, so
  // it treats that as a live proposal and records hasVoted against it -- and
  // when the id is later filled in by a real proposal, the real vote is refused
  // with "Already voted". That is how a vote was lost on id 27.
  //
  // So every vote path -- wren-vote.js, builder-vote.js, the page's buttons --
  // asks this first. It returns null when the target is safe to vote on, and a
  // sentence saying why not otherwise.
  //
  // `expect` is optional: { title, text }. Saying what you believe you are
  // voting on turns a silent id drift into a refusal instead of a wrong vote.
  function voteTargetProblem(proposalId, proposal, expect) {
    var id = num(proposalId);
    if (!proposal) return "proposal " + id + " could not be read from the chain";

    var text = proposal.text === undefined || proposal.text === null ? "" : String(proposal.text);
    if (!text.trim()) {
      return "proposal " + id + " has no text on chain: it has not been filed yet. " +
        "A vote now is recorded against the empty id and blocks the real vote when it is filed.";
    }
    if (num(proposal.createdAt) === 0) {
      return "proposal " + id + " has createdAt 0, so it was never filed. " +
        "A vote now blocks the real vote later.";
    }

    if (!expect) return null;

    var parsed = proposal.format || parseProposalText(text);
    if (expect.title) {
      var actual = (!parsed.legacy && parsed.doc && parsed.doc.title)
        ? String(parsed.doc.title)
        : proposalHeadline({ text: text, format: parsed });
      if (!looselyEqual(actual, expect.title)) {
        return "proposal " + id + ' is "' + actual + '", not "' + expect.title + '". ' +
          "Refusing to vote on a proposal that is not the one you read.";
      }
    }
    if (expect.text && !looselyEqual(text, expect.text)) {
      return "proposal " + id + "'s chain text is not the text you expected. " +
        "Refusing to vote on a proposal that changed under you.";
    }
    return null;
  }

  // Whitespace and case do not make two titles different things.
  function looselyEqual(a, b) {
    return String(a).replace(/\s+/g, " ").trim().toLowerCase() ===
      String(b).replace(/\s+/g, " ").trim().toLowerCase();
  }

  // --- Wren's reasons ----------------------------------------------------

  // scripts/wren-vote.js appends one JSON object per vote to
  // governance/wren-votes.jsonl. The page's server re-reads that file on every
  // request and serves it as a JSON array here.
  var WREN_VOTES_PATH = "/wren-votes.json";

  // Parse the .jsonl text into records, skipping blank and malformed lines.
  function parseWrenVotesJsonl(text) {
    var records = [];
    var skipped = 0;
    String(text || "").split(/\r?\n/).forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return;
      try {
        records.push(JSON.parse(trimmed));
      } catch (e) {
        skipped++;
      }
    });
    return { records: records, skipped: skipped };
  }

  function isLater(a, aIndex, b, bIndex) {
    if (a && b && a.at && b.at && a.at !== b.at) return a.at > b.at;
    return aIndex > bIndex;
  }

  // The log is append-only, so a second record for a proposal is a correction
  // and the latest one stands. "Latest" is by the record's own `at` when both
  // carry one, and by file order otherwise.
  function indexWrenVotes(records) {
    var best = {};
    (records || []).forEach(function (record, index) {
      if (!record) return;
      // A correction is Wren writing down that an earlier record was wrong. The
      // log is append-only, so that is the only way to say so -- but a
      // correction is not a vote, and showing its text as the card's reason
      // would replace Wren's argument with a note about the bookkeeping.
      if (record.correction) return;
      if (record.proposalId === undefined || record.proposalId === null) return;
      var id = num(record.proposalId);
      if (!best[id] || isLater(record, index, best[id].record, best[id].index)) {
        best[id] = { record: record, index: index };
      }
    });
    var out = {};
    Object.keys(best).forEach(function (id) { out[id] = best[id].record; });
    return out;
  }

  // Fetch the served endpoint. The caller decides what a failure means; the page
  // treats it as "no reasons available" and carries on.
  async function fetchWrenVotes(fetchImpl, baseUrl) {
    var url = (baseUrl || "") + WREN_VOTES_PATH;
    var response = await fetchImpl(url, { cache: "no-store" });
    if (!response.ok) throw new Error(url + " returned HTTP " + response.status);
    var body = await response.json();
    if (!Array.isArray(body)) throw new Error(url + " did not return a JSON array");
    return body;
  }

  // --- the tie rule ------------------------------------------------------

  function hasVoted(proposal, address) {
    return (proposal.votes || []).some(function (v) { return sameAddress(v.voter, address); });
  }

  // The contract passes a proposal on forVotes > againstVotes, so a 1-1 tie
  // rejects. The tie-break is membership, not a contract change: account 2 is a
  // third member whose vote the page only offers when both ordinary members have
  // voted and are tied. Nothing on chain enforces this -- it is the rule the page
  // holds the Director to, and the rule the tiebreak test pins down.
  function castingVoteState(proposal, options) {
    var opts = options || {};
    var directorAddress = opts.director || DIRECTOR;
    var wrenAddress = opts.wren || WREN;
    var castingAddress = opts.casting || CASTING;
    return castingStateFor(proposal, [directorAddress, wrenAddress], castingAddress);
  }

  // The same rule, told which accounts are the ordinary voters and which is the
  // casting one. On the main organisation that is Director + Wren, broken by
  // account 2; on the widget-builder it is builder + widget, broken by Wren.
  function castingStateFor(proposal, ordinary, castingAddress) {
    var names = ordinary.map(labelFor);
    if (proposal.status !== 0) {
      return { allowed: false, reason: "Proposal is " + (STATUS[proposal.status] || "closed") + "." };
    }
    if (!castingAddress) {
      return { allowed: false, reason: "This organisation has no casting vote." };
    }
    if (hasVoted(proposal, castingAddress)) {
      return { allowed: false, reason: "The casting vote has already been cast." };
    }
    var allVoted = ordinary.every(function (a) { return hasVoted(proposal, a); });
    if (!allVoted) {
      return { allowed: false, reason: "Waiting for " + names.join(" and ") + " to vote." };
    }
    if (proposal.forVotes !== proposal.againstVotes) {
      return {
        allowed: false,
        reason: "No tie to break (" + proposal.forVotes + " for, " + proposal.againstVotes + " against)."
      };
    }
    return {
      allowed: true,
      reason: "Tied " + proposal.forVotes + "-" + proposal.againstVotes + "; the casting vote decides."
    };
  }

  // The casting-vote rule for whichever organisation the proposal is on.
  function castingStateUnder(rules, proposal) {
    var r = rules || DEFAULT_RULES;
    return castingStateFor(proposal, r.voters, r.casting);
  }

  // --- automatic execution -----------------------------------------------

  // Nobody presses a button on the widget-builder: once the tally is decisive
  // the watcher, or the last voter's own script, executes. Returns what should
  // happen and why, so the caller can act and say the same sentence.
  //
  // `nowSeconds` defaults to the clock; the checks pass a fixed one.
  function autoExecuteState(rules, proposal, nowSeconds) {
    var r = rules || DEFAULT_RULES;
    if (r.autoExecute !== "automatic") {
      return { should: false, reason: "This organisation executes on the Director's vote, not on a timer." };
    }
    if (proposal.status !== 0) {
      return { should: false, reason: "Already " + (STATUS[proposal.status] || "closed") + "." };
    }

    var cast = proposal.forVotes + proposal.againstVotes;
    if (cast === 0) return { should: false, reason: "No votes yet." };

    var level = proposal.forVotes === proposal.againstVotes;
    var allVoted = r.voters.every(function (a) { return hasVoted(proposal, a); });

    if (level) {
      if (allVoted) {
        return {
          should: false,
          tied: true,
          reason: "Level at " + proposal.forVotes + "-" + proposal.againstVotes +
            " with both votes in. " + labelFor(r.casting) + " breaks it."
        };
      }
      return { should: false, reason: "Level, and not everyone has voted yet." };
    }

    if (allVoted) {
      return {
        should: true,
        by: r.executeAs,
        reason: "Decisive at " + proposal.forVotes + "-" + proposal.againstVotes +
          " with every vote in."
      };
    }

    // Not everyone voted: the window decides. Until the widget's add-on exists,
    // account 4 cannot vote at all, so a builder-only vote has to be able to
    // carry -- after the window, and only after it.
    var hours = r.windowHours;
    if (!hours) return { should: false, reason: "Waiting for the remaining votes." };
    var now = nowSeconds === undefined || nowSeconds === null
      ? Math.floor(Date.now() / 1000)
      : num(nowSeconds);
    var age = now - num(proposal.createdAt);
    var windowSeconds = hours * 3600;
    if (age < windowSeconds) {
      var left = Math.ceil((windowSeconds - age) / 3600);
      return {
        should: false,
        reason: "Decisive at " + proposal.forVotes + "-" + proposal.againstVotes +
          ", but not everyone has voted; " + left + " hour" + (left === 1 ? "" : "s") +
          " of the " + hours + "-hour window left."
      };
    }
    return {
      should: true,
      by: r.executeAs,
      reason: "Decisive at " + proposal.forVotes + "-" + proposal.againstVotes +
        " and the " + hours + "-hour window has passed."
    };
  }

  // What executeProposal would do right now, without sending anything.
  function predictedOutcome(proposal) {
    return proposal.forVotes > proposal.againstVotes;
  }

  function formatTime(unixSeconds) {
    if (!unixSeconds) return "—";
    return new Date(unixSeconds * 1000).toLocaleString();
  }

  return {
    RPC_URL: RPC_URL,
    CHAIN_ID: CHAIN_ID,
    DIAMOND: DIAMOND,
    AAO_ID: AAO_ID,
    DIRECTOR: DIRECTOR,
    WREN: WREN,
    CASTING: CASTING,
    BUILDER: BUILDER,
    WIDGET: WIDGET,
    ROLES: ROLES,
    AAO_NOTES: AAO_NOTES,
    AAO_RULES: AAO_RULES,
    DEFAULT_RULES: DEFAULT_RULES,
    rulesFor: rulesFor,
    mayVote: mayVote,
    isViewerOnly: isViewerOnly,
    voterProblem: voterProblem,
    castingStateFor: castingStateFor,
    castingStateUnder: castingStateUnder,
    autoExecuteState: autoExecuteState,
    readAAOs: readAAOs,
    readAllProposals: readAllProposals,
    AAO_ABI: AAO_ABI,
    STATUS: STATUS,
    PROPOSAL_FIELDS: PROPOSAL_FIELDS,
    PROPOSAL_REQUIRED: PROPOSAL_REQUIRED,
    validateProposalDoc: validateProposalDoc,
    parseProposalText: parseProposalText,
    proposalHeadline: proposalHeadline,
    voteTargetProblem: voteTargetProblem,
    looselyEqual: looselyEqual,
    isUrl: isUrl,
    WREN_VOTES_PATH: WREN_VOTES_PATH,
    parseWrenVotesJsonl: parseWrenVotesJsonl,
    indexWrenVotes: indexWrenVotes,
    fetchWrenVotes: fetchWrenVotes,
    getProvider: getProvider,
    getContract: getContract,
    readAAO: readAAO,
    readProposals: readProposals,
    readGovernance: readGovernance,
    castingVoteState: castingVoteState,
    predictedOutcome: predictedOutcome,
    hasVoted: hasVoted,
    labelFor: labelFor,
    roleFor: roleFor,
    shortAddress: shortAddress,
    sameAddress: sameAddress,
    formatTime: formatTime
  };
});
