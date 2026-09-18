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

  // --- sha256, in plain JavaScript ---------------------------------------
  //
  // Node has one in `crypto`; the browser has one behind an async API that a
  // synchronous id cannot wait for, and this file loads in both. Branching on
  // the environment would mean two code paths for one answer, so it carries its
  // own: sixty lines, no dependency, the same digest in both homes and the same
  // digest as Python's hashlib.
  var SHA_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  // UTF-8 bytes, the same bytes Python encodes before hashing.
  function utf8Bytes(text) {
    var str = String(text);
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
        var low = str.charCodeAt(i + 1);
        if (low >= 0xdc00 && low < 0xe000) {
          i++;
          var cp = 0x10000 + (((c & 0x3ff) << 10) | (low & 0x3ff));
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
          continue;
        }
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return out;
  }

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  function hex8(n) {
    var s = (n >>> 0).toString(16);
    return "00000000".slice(s.length) + s;
  }

  function sha256Hex(text) {
    var bytes = utf8Bytes(text);
    var bitLength = bytes.length * 8;
    bytes = bytes.slice();
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var high = Math.floor(bitLength / 0x100000000);
    bytes.push(
      (high >>> 24) & 255, (high >>> 16) & 255, (high >>> 8) & 255, high & 255,
      (bitLength >>> 24) & 255, (bitLength >>> 16) & 255, (bitLength >>> 8) & 255, bitLength & 255
    );

    var h = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    var w = new Array(64);

    for (var i = 0; i < bytes.length; i += 64) {
      var t;
      for (t = 0; t < 16; t++) {
        w[t] = ((bytes[i + t * 4] << 24) | (bytes[i + t * 4 + 1] << 16) |
                (bytes[i + t * 4 + 2] << 8) | bytes[i + t * 4 + 3]) | 0;
      }
      for (t = 16; t < 64; t++) {
        var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (((w[t - 16] + s0) | 0) + ((w[t - 7] + s1) | 0)) | 0;
      }

      var a = h[0], b = h[1], c = h[2], d = h[3];
      var e = h[4], f = h[5], g = h[6], hh = h[7];

      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (((((hh + S1) | 0) + ch) | 0) + ((SHA_K[t] + w[t]) | 0)) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }

      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }

    return h.map(hex8).join("");
  }

  // --- the message id (proposal 26) --------------------------------------
  //
  // An id is made from what the message SAYS, not from when it was written.
  //
  // This file used to number a message by its type and the clock, and
  // protocol.py numbered the same message by its type and a fingerprint of its
  // content. Both worked, and they disagreed: a message written twice -- a retry
  // after a crash, a script re-run -- was two messages here and one there. The
  // incident log decides what the builder builds next, so a doubled record can
  // count a rejection twice and invent a builder item that is not real.
  // Proposal 26 on the widget-builder settled it for the content fingerprint,
  // and this is that scheme.
  //
  // It must produce the same id as protocol.py for the same message, or the
  // whole point is lost. So:
  //
  //   * the same six fields, and only those: from, to, type, subject, summary,
  //     details. ts is deliberately out -- a retry must not get a new id --
  //     and so are refs, which a corrector may add without changing what was
  //     said;
  //   * canonicalised exactly as Python's json.dumps(sort_keys=True) writes it,
  //     down to the space after each ':' and ',', because the digest is over
  //     those bytes;
  //   * a missing field is null, as Python's dict.get gives None;
  //   * sha256, first 14 hex characters;
  //   * prefixed with the type, whitespace collapsed, or "msg" when there is
  //     none.
  //
  // `governance/check.js` holds ids computed by protocol.py and asserts this
  // reproduces them, so the two cannot drift apart unnoticed.
  //
  // --- when six fields are not the whole identity
  //
  // The six are what a message SAYS, and for the traffic both implementations
  // write -- incidents, statuses, decisions -- they are all of it. Some message
  // shapes carry more: a question on the question channel is the Director's
  // words *about a particular proposal*, and "Why?" asked on proposal 3 and on
  // proposal 5 are two questions, not one. Hashing only the six would give them
  // one id, and the answers that point at that id would point at both.
  //
  // So a writer may name further fields that are part of the identity. It is a
  // faithful extension, not a second scheme: the key list is still sorted and
  // canonicalised the same way, so protocol.py handed the same field list gives
  // the same id. The rule is that any message type MORE THAN ONE implementation
  // writes uses the six alone -- otherwise the two sides must agree on the
  // extras too, and an agreement nobody wrote down is not one.
  var ID_FIELDS = ["details", "from", "subject", "summary", "to", "type"];  // sorted, as Python sorts them
  var ID_HEX = 14;

  function collapse(v) {
    return String(v === undefined || v === null ? "" : v).replace(/\s+/g, " ").trim();
  }

  function idFieldsWith(extra) {
    if (!Array.isArray(extra) || !extra.length) return ID_FIELDS;
    var all = ID_FIELDS.slice();
    extra.forEach(function (k) {
      if (typeof k === "string" && k && all.indexOf(k) === -1) all.push(k);
    });
    return all.sort();
  }

  // Python's json.dumps(..., sort_keys=True, ensure_ascii=False) for this exact
  // shape: a flat object of known keys, written with its separators.
  function canonicalForId(message, extraFields) {
    var m = message || {};
    return "{" + idFieldsWith(extraFields).map(function (k) {
      var v = m[k];
      if (v === undefined) v = null;
      return JSON.stringify(k) + ": " + JSON.stringify(v);
    }).join(", ") + "}";
  }

  // The id for a message, from its content. Stable: the same message, written
  // any number of times, in Node or in the browser or in Python, is one id.
  function messageId(message, extraFields) {
    return (collapse(message && message.type) || "msg") + "-" +
      sha256Hex(canonicalForId(message, extraFields)).slice(0, ID_HEX);
  }

  // Kept for the few places that need a name for something that is not a
  // message and has no content to hash -- a draft, a filing record. A message's
  // id comes from messageId(), never from here.
  function newId(prefix) {
    var stamp = Date.now().toString(36);
    var noise = Math.random().toString(36).slice(2, 8);
    return (prefix || "msg") + "-" + stamp + "-" + noise;
  }

  // Fill in what the writer did not have to care about, and drop nothing they
  // did write. Validation happens after this, so a caller can hand over a bare
  // { from, type, subject, summary }.
  //
  // The id is filled LAST, after `to` and `details` have their final values,
  // because it is a fingerprint of them. protocol.py fills it in the same order
  // for the same reason.
  //
  // `defaults.to` is the correspondent to assume; `defaults.idFields` names any
  // further fields that are part of this message's identity (see above).
  function normalise(partial, defaults) {
    var d = defaults || {};
    var message = {};
    Object.keys(partial || {}).forEach(function (k) { message[k] = partial[k]; });

    if (!isNonEmptyString(message.ts)) message.ts = new Date().toISOString();
    if (!isNonEmptyString(message.to)) message.to = d.to || "all";
    if (message.details === undefined || message.details === null) message.details = "";
    if (!Array.isArray(message.refs)) message.refs = [];
    if (!isNonEmptyString(message.id)) message.id = messageId(message, d.idFields);
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
    messageId: messageId,
    canonicalForId: canonicalForId,
    ID_FIELDS: ID_FIELDS,
    sha256Hex: sha256Hex,
    newId: newId,
    label: label,
    typeLabel: typeLabel,
    parseJsonl: parseJsonl,
    toJsonl: toJsonl
  };
});
