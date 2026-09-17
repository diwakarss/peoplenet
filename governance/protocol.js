// governance/protocol.js -- the one message shape all the agents use.
//
// Spec section 27.5. Every message on a file or on chain -- an incident from the
// widget, a status from the builder, a proposal, a question from the Director,
// Wren's answer, a decision, a request for a new proposal -- is the same object:
//
//   id       stable, unique
//   ts       ISO 8601, when it was written
//   from     who wrote it      (widget | builder | wren | director | ...)
//   to       who it is for     (same vocabulary, or "all")
//   type     one of TYPES
//   subject  one line, what it is about
//   summary  plain English, for a person
//   details  the technical part, free form, kept whole
//   refs     tickets, commits, incidents, spec entries
//
// A message without a subject and a summary is refused. That is the whole rule:
// if an agent cannot say in one line what this is and in plain English what it
// means, the message is not ready to be read by a person, and a person is who
// reads this.
//
// require() it from Node (the server, the scripts) or load it in a <script> tag
// next to read.js. The widget mirrors it in Python as protocol.py.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GovernanceProtocol = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var TYPES = [
    "incident",              // the widget saw something go wrong
    "status",                // work in progress, nothing needed
    "proposal",              // a change being asked for
    "question",              // the Director asking about a proposal
    "answer",                // Wren answering one
    "decision",              // an outcome: executed, rejected, picked up
    "request-new-proposal"   // this proposal is not it; file a better one
  ];

  // Known correspondents. Not enforced -- a new agent should not need a code
  // change to speak -- but used for labelling and for spotting typos.
  var PARTIES = ["director", "wren", "builder", "widget", "all"];

  var PARTY_LABELS = {
    director: "Director",
    wren: "Wren",
    builder: "Builder",
    widget: "Widget",
    all: "Everyone"
  };

  var REQUIRED = ["from", "type", "subject", "summary"];

  function isNonEmptyString(v) {
    return typeof v === "string" && v.trim().length > 0;
  }

  // Validate a message. Returns { ok, errors } -- never throws, so a server can
  // turn the errors into a 400 and a script can print them.
  function validate(message) {
    var errors = [];

    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { ok: false, errors: ["message must be a JSON object"] };
    }

    REQUIRED.forEach(function (field) {
      if (!isNonEmptyString(message[field])) {
        errors.push(field + " is required and must be a non-empty string");
      }
    });

    if (isNonEmptyString(message.type) && TYPES.indexOf(message.type) === -1) {
      errors.push('type "' + message.type + '" is not one of: ' + TYPES.join(", "));
    }

    if (message.refs !== undefined && !Array.isArray(message.refs)) {
      errors.push("refs must be an array when present");
    }

    if (message.details !== undefined && typeof message.details !== "string") {
      errors.push("details must be a string when present");
    }

    if (message.id !== undefined && !isNonEmptyString(message.id)) {
      errors.push("id must be a non-empty string when present");
    }

    if (message.ts !== undefined && !isNonEmptyString(message.ts)) {
      errors.push("ts must be an ISO 8601 string when present");
    }

    return { ok: errors.length === 0, errors: errors };
  }

  // Throwing form, for scripts that would rather die than file a bad message.
  function assertValid(message, context) {
    var result = validate(message);
    if (!result.ok) {
      throw new Error(
        (context ? context + ": " : "") + "invalid message\n  - " + result.errors.join("\n  - ")
      );
    }
    return message;
  }

  function newId(prefix) {
    var stamp = Date.now().toString(36);
    var noise = Math.random().toString(36).slice(2, 8);
    return (prefix || "msg") + "-" + stamp + "-" + noise;
  }

  // Fill in what the writer did not have to care about, and drop nothing they
  // did write. Validation happens after this, so a caller can hand over a bare
  // { from, type, subject, summary }.
  function normalise(partial, defaults) {
    var d = defaults || {};
    var message = {};
    Object.keys(partial || {}).forEach(function (k) { message[k] = partial[k]; });

    if (!isNonEmptyString(message.id)) message.id = newId(d.idPrefix || message.type || "msg");
    if (!isNonEmptyString(message.ts)) message.ts = new Date().toISOString();
    if (!isNonEmptyString(message.to)) message.to = d.to || "all";
    if (message.details === undefined || message.details === null) message.details = "";
    if (!Array.isArray(message.refs)) message.refs = [];
    return message;
  }

  function label(party) {
    if (!isNonEmptyString(party)) return "unknown";
    var key = party.toLowerCase();
    return PARTY_LABELS[key] || party;
  }

  // Human wording for a type, for the timeline and the notifications.
  function typeLabel(type) {
    if (type === "request-new-proposal") return "New proposal requested";
    if (!isNonEmptyString(type)) return "Message";
    return type.charAt(0).toUpperCase() + type.slice(1);
  }

  // --- jsonl helpers, shared by the server and the scripts ---------------

  function parseJsonl(text) {
    var records = [];
    var skipped = 0;
    String(text || "").split(/\r?\n/).forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return;
      try { records.push(JSON.parse(trimmed)); } catch (e) { skipped++; }
    });
    return { records: records, skipped: skipped };
  }

  function toJsonl(record) {
    return JSON.stringify(record) + "\n";
  }

  return {
    TYPES: TYPES,
    PARTIES: PARTIES,
    REQUIRED: REQUIRED,
    validate: validate,
    assertValid: assertValid,
    normalise: normalise,
    newId: newId,
    label: label,
    typeLabel: typeLabel,
    parseJsonl: parseJsonl,
    toJsonl: toJsonl
  };
});
