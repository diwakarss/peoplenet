// governance/context-pack.js -- what a builder needs for one item, and no more
// (proposal 96).
//
// A builder that starts from the repository reads everything and remembers the
// wrong half. The architect hands it a pack instead: the proposal, what was
// said on it, the files it names, and the rules attached to the capabilities it
// will use.
//
// The capabilities are the point. Every rule below is an incident -- a real one,
// with somewhere to read it -- and a builder that is about to restart the
// server or append to a log should be handed the rule for that before it does,
// not after.
//
// This module decides what goes in the pack. scripts/context-pack.js fetches
// and prints it.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GovernanceContextPack = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // A path in a proposal's prose: governance/read.js, scripts/remind.js,
  // test/governance/watch.test.js, governance/swarm/kolam.js. Deliberately
  // narrow -- a sentence mentioning "the widget" names no file, and a pack full
  // of guesses is a pack nobody trusts.
  var PATH = /\b((?:governance|scripts|test|contracts|ui)\/[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)*\.[a-z]{1,5})\b/g;

  // A file named without its directory, which is how these proposals usually
  // name one: "protocol.js", "read.js", "watch.js". The CLI resolves it against
  // the directories it knows, so a bare name that is not a file here is simply
  // dropped rather than guessed at.
  var BARE = /(?:^|[\s"'`(])([a-z][a-z0-9_-]*\.(?:js|md|css|html|jsonl|json))\b/g;

  // An identifier a proposal names as code: a camelCase name with at least two
  // lower-case letters before the capital, so "viewFor" and "runReminders"
  // match and "iPhone" does not, or any name followed by "()".
  var SYMBOL = /\b([a-z]{2,}[A-Z][A-Za-z0-9_]{1,})\b|\b([a-z][A-Za-z0-9_]{3,})\(\)/g;

  // Words that look like a symbol and are not. Short, and each one earned its
  // place by appearing in a pack where it meant nothing.
  var NOT_SYMBOLS = ["javaScript", "jsonL"];

  // What a builder can do here, and what each one costs when it goes wrong.
  // `match` is what in the proposal's text or files says the capability is in
  // play. Every rule names where to read it.
  var CAPABILITIES = [
    {
      key: "logs",
      label: "Appending to an append-only log",
      match: [/\.jsonl\b/i, /\bappend-only\b/i, /\blog\b/i, /messages\.jsonl/],
      rules: [
        {
          rule: "Never write to the live record as another party. The logs record who wrote each line and nothing can edit one.",
          because: "Two questions were posted through the live server under the Director's name, and one was answered as Wren. They are still there.",
          source: "governance/ledger/kalam.md"
        },
        {
          rule: "Test with GOVERNANCE_LOG_DIR pointing somewhere throwaway, never the real directory.",
          because: "It exists because the first builder did not have it.",
          source: "governance/server.js"
        },
        {
          rule: "A line that needs correcting is superseded by a later line, never rewritten.",
          source: "governance/PROTOCOL.md"
        }
      ]
    },
    {
      key: "chain",
      label: "Writing to the chain",
      match: [/\bvote\b/i, /\bexecute/i, /\bproposal\b.*\bfile[sd]?\b/i, /\bon chain\b/i, /submitProposal/],
      rules: [
        {
          rule: "No script that writes to the chain is ever run against live state to test it. The in-process hardhat network is where writes are tested.",
          because: "A vote was cast by accident on proposal 32 doing exactly that, and one member one vote means it could not be taken back.",
          source: "test/governance/scripts.test.js"
        },
        {
          rule: "Every write script rehearses by default and needs --send.",
          because: "Twice it was the other way round, and two real votes went out with meaningless reasons on them.",
          source: "governance/read.js, wantsSend"
        },
        {
          rule: "Executed means executed AND passed: the facet writes Rejected otherwise.",
          source: "governance/ledger/kalam.md"
        }
      ]
    },
    {
      key: "watcher",
      label: "Changing the watcher",
      match: [/watch\.js/, /\bwatcher\b/i, /\btrigger\b/i, /\breminder\b/i],
      rules: [
        {
          rule: "When you add a second kind of message from an existing sender, read everything that matches on that sender.",
          because: "The unclaimed list and a fired trigger both came from \"watch\"; one sentence meant two things, and 31 proposals would have had their real triggers silenced for good.",
          source: "governance/ledger/kalam.md"
        },
        {
          rule: "The watcher reads its proposals at the start of a tick, and block numbers are not time. Judge it by the wall clock.",
          source: "governance/ledger/kalam.md"
        },
        {
          rule: "Prefer a default that cannot hurt over a rule every future test has to remember. Snapshots are opt-in for that reason.",
          source: "governance/watch.js"
        }
      ]
    },
    {
      key: "server",
      label: "Restarting the governance server",
      match: [/server\.js/, /\bserver\b/i, /8787/, /\brestart\b/i],
      rules: [
        {
          rule: "Stop only a process id you started yourself. Never match on a name.",
          because: "Matching on a command line killed Kural's running watch three times in one afternoon.",
          source: "governance/ledger/kalam.md"
        },
        {
          rule: "The server carries the watcher, so restarting it is how new watcher code goes live. Restart it by the pid listening on its port.",
          source: "governance/ledger/kalam.md"
        }
      ]
    },
    {
      key: "secrets",
      label: "Anything with a secret in it",
      match: [/\bsecret\b/i, /\bntfy\b/i, /\btopic\b/i, /\bpush\b/i, /\bprivate key\b/i, /\.env\b/],
      rules: [
        {
          rule: "A secret never enters the repository, a message, a log line, a test or a report.",
          because: "An ntfy topic has no password, and a git history cannot be taken back.",
          source: "governance/push.js"
        },
        {
          rule: "Redact before reporting. A failed fetch names the host it could not reach.",
          source: "governance/push.js, redact"
        },
        {
          rule: "Never print or copy a private key. Accounts are named by their Hardhat index.",
          source: "governance/ledger/kalam.md"
        }
      ]
    },
    {
      key: "page",
      label: "Changing the page",
      match: [/app\.js/, /\bpage\b/i, /\bdashboard\b/i, /\/swarm\b/, /kolam/i],
      rules: [
        {
          rule: "A rule the page applies lives in read.js, so the page, the scripts and the tests refuse the same thing for the same reason.",
          source: "governance/README.md"
        },
        {
          rule: "No Chromium is installed here, so the browse skill fails. A render path can be run against a stub DOM instead; a real browser pass is still owed.",
          source: "governance/ledger/kalam.md"
        }
      ]
    },
    {
      key: "tests",
      label: "Running the tests",
      match: [/\btest\b/i, /\.test\.js/],
      rules: [
        {
          rule: "Never run a long command in the foreground. Tests go to a log through Start-Process; poll the log; stop only that pid.",
          source: "governance/ledger/kalam.md"
        },
        {
          rule: "A detached run can exit with an empty log and no error. Check the log's length before believing a silent run.",
          source: "governance/ledger/kalam.md"
        },
        {
          rule: "governance:check has one known red -- proposals 27, 29 and 30. Leave it; add none.",
          source: "governance/ledger/kalam.md"
        }
      ]
    }
  ];

  function textOf(v) {
    return String(v === undefined || v === null ? "" : v);
  }

  // Everything a proposal document says, as one string to scan.
  function proseOf(proposal) {
    var p = proposal || {};
    var doc = p.format && p.format.doc;
    if (!doc) return textOf(p.text);
    return ["title", "summary", "why", "technical", "risk", "effort"]
      .map(function (f) { return textOf(doc[f]); })
      .concat(Array.isArray(doc.refs) ? doc.refs.map(textOf) : [])
      .join("\n");
  }

  function uniq(list) {
    var seen = {};
    return (list || []).filter(function (x) {
      if (seen[x]) return false;
      seen[x] = true;
      return true;
    });
  }

  // The files a proposal names, in the order it names them. A path is taken as
  // written; a bare file name is handed to `resolve`, which the caller supplies
  // because only the caller knows what is on disk. Without one, bare names are
  // dropped: a pack that guesses is a pack nobody trusts.
  function filesNamedIn(text, resolve) {
    var out = [];
    var prose = textOf(text);
    var m;

    PATH.lastIndex = 0;
    while ((m = PATH.exec(prose)) !== null) out.push(m[1]);

    if (typeof resolve === "function") {
      BARE.lastIndex = 0;
      while ((m = BARE.exec(prose)) !== null) {
        var found = resolve(m[1]);
        if (found) out.push(found);
      }
    }

    return uniq(out);
  }

  // The symbols a proposal names, which is what the code index is asked about.
  function symbolsNamedIn(text) {
    var out = [];
    var prose = textOf(text);
    var m;
    SYMBOL.lastIndex = 0;
    while ((m = SYMBOL.exec(prose)) !== null) {
      var name = m[1] || m[2];
      if (name && NOT_SYMBOLS.indexOf(name) === -1) out.push(name);
    }
    return uniq(out);
  }

  // The capabilities this item will use, read off what it says and what it
  // names. A capability matched by nothing is left out: the pack is what to
  // read, and a pack containing every rule is the repository again.
  function capabilitiesFor(text, files) {
    var haystack = textOf(text) + "\n" + (files || []).join("\n");
    return CAPABILITIES.filter(function (capability) {
      return capability.match.some(function (re) { return re.test(haystack); });
    });
  }

  // What was said on this proposal, oldest first: the questions asked, the
  // answers given, and the decisions posted.
  function saidOn(records, proposalId) {
    return (records || []).filter(function (m) {
      if (!m) return false;
      if (Number(m.proposal) === Number(proposalId)) return true;
      return (m.refs || []).some(function (r) {
        return new RegExp("\\bproposal\\s*" + proposalId + "\\b", "i").test(textOf(r));
      });
    }).sort(function (a, b) {
      return String(a.ts || "").localeCompare(String(b.ts || ""));
    });
  }

  return {
    CAPABILITIES: CAPABILITIES,
    SEARCHED: ["governance", "scripts", "test/governance", "governance/swarm"],
    proseOf: proseOf,
    filesNamedIn: filesNamedIn,
    symbolsNamedIn: symbolsNamedIn,
    capabilitiesFor: capabilitiesFor,
    saidOn: saidOn
  };
});
