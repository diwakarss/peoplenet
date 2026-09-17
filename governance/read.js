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

  var ROLES = [
    { key: "director", label: "Director", address: DIRECTOR, ordinary: true },
    { key: "wren", label: "Wren", address: WREN, ordinary: true },
    { key: "casting", label: "Casting vote", address: CASTING, ordinary: false }
  ];

  // Minimal human-readable ABI: exactly the AAOFacet surface the page touches.
  var AAO_ABI = [
    "function getAAO(uint256 aaoId) view returns (tuple(string topic, uint256 duration, address owner, bool active, bool isMacro, address[] members, uint256 macroAAOId))",
    "function getProposal(uint256 proposalId) view returns (tuple(uint256 id, uint256 aaoId, address proposer, string text, uint256 forVotes, uint256 againstVotes, uint8 status, uint256 createdAt))",
    "function getMembers(uint256 aaoId) view returns (address[])",
    "function getMembersCount(uint256 aaoId) view returns (uint256)",
    "function isMember(uint256 aaoId, address member) view returns (bool)",
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

  // One shot for the page: the AAO, its proposals, and the block they were read at.
  async function readGovernance(ethers, provider, options) {
    var opts = options || {};
    var contract = getContract(ethers, provider, opts.diamond);
    var aaoId = opts.aaoId === undefined ? AAO_ID : opts.aaoId;
    var aao = await readAAO(contract, aaoId);
    var proposals = await readProposals(contract, aaoId);
    var blockNumber = await provider.getBlockNumber();
    return { aao: aao, proposals: proposals, blockNumber: blockNumber };
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
      if (!record || record.proposalId === undefined || record.proposalId === null) return;
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

    if (proposal.status !== 0) {
      return { allowed: false, reason: "Proposal is " + (STATUS[proposal.status] || "closed") + "." };
    }
    if (hasVoted(proposal, castingAddress)) {
      return { allowed: false, reason: "The casting vote has already been cast." };
    }
    if (!(hasVoted(proposal, directorAddress) && hasVoted(proposal, wrenAddress))) {
      return { allowed: false, reason: "Waiting for both the Director and Wren to vote." };
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
    ROLES: ROLES,
    AAO_ABI: AAO_ABI,
    STATUS: STATUS,
    PROPOSAL_FIELDS: PROPOSAL_FIELDS,
    PROPOSAL_REQUIRED: PROPOSAL_REQUIRED,
    validateProposalDoc: validateProposalDoc,
    parseProposalText: parseProposalText,
    proposalHeadline: proposalHeadline,
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
