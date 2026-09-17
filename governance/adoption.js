// governance/adoption.js -- where a proposal has got to, read from Wren's words.
//
// Spec 27.9 and 27.12. A proposal the Director executes becomes a build item
// within the hour, and the page should say so without anyone having to ask. So
// Wren posts one plain-English decision message as it moves, and the state is
// read out of the sentence rather than out of a field nobody would keep true:
//
//   queued                  on the standing channel, in the order the votes came
//   building                the builder has started
//   built                   the code exists, named by its commit
//   in the widget           live after the restart
//   waiting                 out of the main queue until something changes
//   back in the queue       a waiting proposal brought back
//   closed: solved by ...   another item solved it on the way
//
// The words are the record. This file only says which words mean which state,
// in one place, so the page, the scripts and the checks all agree.
//
// require() it from Node or load it in a <script> tag; the page uses
// window.GovernanceAdoption.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GovernanceAdoption = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Order matters: the first match wins, so the specific phrases come before
  // the loose ones. "closed: solved by the build" must not read as "built".
  var STATES = [
    {
      key: "closed",
      label: "Closed by a build",
      chip: "closed",
      match: /^\s*closed\s*:\s*solved by\b/i,
      hint: 'starts "closed: solved by <item>"'
    },
    {
      key: "waiting",
      label: "Waiting",
      chip: "waiting",
      match: /^\s*waiting\s*:/i,
      hint: 'starts "waiting: <why it can wait>"'
    },
    {
      key: "back",
      label: "Back in the queue",
      chip: "queued",
      match: /^\s*back in the queue\b/i,
      hint: 'starts "back in the queue"'
    },
    {
      key: "in-widget",
      label: "In the widget",
      chip: "in-widget",
      match: /\bin the widget\b/i,
      hint: 'contains "in the widget"'
    },
    {
      key: "built",
      label: "Built",
      chip: "built",
      match: /\bbuilt\b/i,
      hint: 'contains "built", normally "built in commit <x>"'
    },
    {
      key: "building",
      label: "Building",
      chip: "building",
      match: /\bbuilding\b|\bbuilder has started\b|\bstarted building\b/i,
      hint: 'contains "building"'
    },
    {
      key: "queued",
      label: "Queued",
      chip: "queued",
      match: /\bqueued\b|\bon the standing channel\b/i,
      hint: 'contains "queued"'
    }
  ];

  var UNKNOWN = { key: "unknown", label: "Decided", chip: "queued", match: null, hint: "" };

  function textOf(v) {
    return String(v === undefined || v === null ? "" : v);
  }

  // Which state a decision message reports. The subject is checked too, so a
  // message whose summary buries the phrase still reads correctly.
  function stateOf(message) {
    if (!message) return UNKNOWN;
    var summary = textOf(message.summary || message.text);
    var subject = textOf(message.subject);
    for (var i = 0; i < STATES.length; i++) {
      if (STATES[i].match.test(summary)) return STATES[i];
    }
    for (var j = 0; j < STATES.length; j++) {
      if (STATES[j].match.test(subject)) return STATES[j];
    }
    return UNKNOWN;
  }

  // Which proposal a message is about. The 27.5 shape carries it in refs
  // ("proposal 17"); messages the page writes also set a proposal field.
  function proposalOf(message) {
    if (!message) return null;
    if (message.proposal !== undefined && message.proposal !== null && message.proposal !== "") {
      var direct = Number(message.proposal);
      if (Number.isInteger(direct)) return direct;
    }
    var refs = Array.isArray(message.refs) ? message.refs : [];
    for (var i = 0; i < refs.length; i++) {
      var m = /^\s*proposal\s+(\d+)\s*$/i.exec(textOf(refs[i]));
      if (m) return Number(m[1]);
    }
    return null;
  }

  function isLater(a, aIndex, b, bIndex) {
    var at = textOf(a && a.ts);
    var bt = textOf(b && b.ts);
    if (at && bt && at !== bt) return at > bt;
    return aIndex > bIndex;
  }

  // The latest decision per proposal. The log is append-only, so a later
  // decision supersedes an earlier one -- that is how a waiting proposal comes
  // back and how "queued" becomes "built".
  function indexDecisions(messages) {
    var best = {};
    (messages || []).forEach(function (m, index) {
      if (!m || m.type !== "decision") return;
      var id = proposalOf(m);
      if (id === null) return;
      if (!best[id] || isLater(m, index, best[id].message, best[id].index)) {
        best[id] = { message: m, index: index };
      }
    });
    var out = {};
    Object.keys(best).forEach(function (id) { out[id] = best[id].message; });
    return out;
  }

  // Every decision about one proposal, oldest first: the history under the chip.
  function historyFor(messages, proposalId) {
    return (messages || [])
      .filter(function (m) { return m && m.type === "decision" && proposalOf(m) === Number(proposalId); })
      .slice()
      .sort(function (a, b) { return textOf(a.ts) < textOf(b.ts) ? -1 : 1; });
  }

  // What a card should show: the state, the words, and the message it came from.
  function adoptionOf(byProposal, proposalId) {
    var message = byProposal ? byProposal[proposalId] : null;
    if (!message) return null;
    return { state: stateOf(message), message: message, text: textOf(message.summary || message.text) };
  }

  function isWaiting(adoption) {
    return Boolean(adoption && adoption.state.key === "waiting");
  }

  function isClosedByBuild(adoption) {
    return Boolean(adoption && adoption.state.key === "closed");
  }

  // "closed: solved by the shared mtime_cache helper." -> the item that solved it.
  function solvedBy(adoption) {
    if (!isClosedByBuild(adoption)) return null;
    var m = /closed\s*:\s*solved by\s+(.+)$/i.exec(adoption.text);
    if (!m) return null;
    return m[1].trim().replace(/[.\s]+$/, "");
  }

  // "waiting: kept open on the Director's request..." -> the reason, without the
  // word "waiting".
  function waitingReason(adoption) {
    if (!isWaiting(adoption)) return null;
    var m = /^\s*waiting\s*:\s*(.+)$/i.exec(adoption.text);
    return m ? m[1].trim() : adoption.text;
  }

  return {
    STATES: STATES,
    UNKNOWN: UNKNOWN,
    stateOf: stateOf,
    proposalOf: proposalOf,
    indexDecisions: indexDecisions,
    historyFor: historyFor,
    adoptionOf: adoptionOf,
    isWaiting: isWaiting,
    isClosedByBuild: isClosedByBuild,
    solvedBy: solvedBy,
    waitingReason: waitingReason
  };
});
