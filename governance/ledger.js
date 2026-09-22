// governance/ledger.js -- the builder's memory, kept outside the builder
// (proposal 96).
//
// An agent is one long session with a fixed memory. When it fills, the session
// ends and a successor of the same name and the same account takes over. What
// the session knew goes with it unless it was written down, and an hour of a
// fresh builder rereading everything is the cheapest version of that loss.
//
// So: one file per agent, governance/ledger/<agent>.md, and a dated section
// appended at every stop. Five things, and the fifth is the one that turns the
// other four into work a successor can pick up:
//
//   item      what was being done
//   decided   what was decided, and why
//   tried     what was tried that did not work, so it is not tried again
//   open      what is still open
//   commit    the commit the ledger stands on
//
// Append-only in practice and in intent. Nothing here edits a section: a
// correction is a later section, exactly as a correction to a message is a
// later message. The file is markdown because a person reads it first.
//
// This module owns the shape. scripts/ledger.js is the command that writes it.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GovernanceLedger = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // The five parts, in the order they are written and in the order a successor
  // reads them. `tried` is the one that may be empty: a stop where nothing was
  // tried and abandoned is an ordinary stop.
  var PARTS = [
    { key: "item", label: "The item", required: true,
      hint: "what was being done" },
    { key: "decided", label: "Decided, and why", required: true,
      hint: "what was decided and the reason, not the decision alone" },
    { key: "tried", label: "Tried, and did not work", required: false,
      hint: "so the next builder does not spend the afternoon on it again" },
    { key: "open", label: "Open", required: true,
      hint: "what is still open; a builder that cannot say has not stopped cleanly" },
    { key: "commit", label: "Stands on", required: true,
      hint: "the commit this ledger stands on" }
  ];

  function textOf(v) {
    return String(v === undefined || v === null ? "" : v).trim();
  }

  // A field may be given once or as a list of lines. One shape here, so the
  // command can take a repeatable flag and the renderer does not care.
  function linesOf(value) {
    if (Array.isArray(value)) {
      return value.map(textOf).filter(Boolean);
    }
    var text = textOf(value);
    return text ? [text] : [];
  }

  // Every reason this report cannot be written, as plain lines. Never throws.
  //
  // "Open" is required for the reason proposal 96 gives: a hand-over loses what
  // was never written down, and a builder that cannot state what is open has
  // not stopped cleanly. "Nothing is open" is an answer; silence is not.
  function validate(report) {
    var errors = [];
    var r = report || {};
    if (!textOf(r.agent)) errors.push("agent is required: whose ledger is this?");
    PARTS.forEach(function (part) {
      if (part.required && !linesOf(r[part.key]).length) {
        errors.push(part.key + " is required -- " + part.hint);
      }
    });
    if (r.generation !== undefined && r.generation !== null) {
      if (!Number.isInteger(Number(r.generation)) || Number(r.generation) < 1) {
        errors.push("generation must be a whole number from 1");
      }
    }
    return { ok: errors.length === 0, errors: errors };
  }

  function assertValid(report, context) {
    var result = validate(report);
    if (!result.ok) {
      throw new Error(
        (context ? context + ": " : "") + "incomplete report\n  - " + result.errors.join("\n  - ")
      );
    }
    return report;
  }

  function label(agent) {
    var name = textOf(agent);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : "";
  }

  function today(now) {
    var at = now ? new Date(now) : new Date();
    if (isNaN(at.getTime())) at = new Date();
    return at.toISOString().slice(0, 10);
  }

  // The file's opening, written once when the ledger does not exist yet. It
  // says what the file is for, because a successor opening it cold is the whole
  // audience.
  function headerFor(agent) {
    return [
      "# " + label(agent),
      "",
      "A builder's ledger. Written so a successor can take the work from here",
      "without asking anyone what happened.",
      "",
      "Appended at every stop by `scripts/ledger.js`, never edited. A correction",
      "is a later section, as a correction to a message is a later message.",
      ""
    ].join("\n");
  }

  // One dated section. Nothing is emitted for a part that is empty and not
  // required: a heading with nothing under it reads as a question nobody
  // answered.
  function renderSection(report, now) {
    var heading = "## " + today(now) + " — " + linesOf(report.item)[0] +
      (report.generation ? " (generation " + report.generation + ")" : "");
    var out = ["", heading, ""];

    PARTS.forEach(function (part) {
      if (part.key === "item") return;
      var lines = linesOf(report[part.key]);
      if (!lines.length) return;
      if (part.key === "commit") {
        out.push("Stands on commit `" + lines.join("`, `") + "`.");
        out.push("");
        return;
      }
      out.push("**" + part.label + ".**");
      out.push("");
      lines.forEach(function (line) { out.push("- " + line); });
      out.push("");
    });

    return out.join("\n");
  }

  // The dated sections already in a ledger, newest last. Used by --list and by
  // the rehearsal, which says where the new section would land.
  function sectionsIn(text) {
    var out = [];
    String(text === undefined || text === null ? "" : text)
      .split(/\r?\n/)
      .forEach(function (line) {
        var m = /^##\s+(\d{4}-\d{2}-\d{2})\s+—\s+(.+)$/.exec(line);
        if (m) out.push({ date: m[1], item: m[2] });
      });
    return out;
  }

  // --- the hand-over ------------------------------------------------------
  //
  // Rotation is ordinary, not a failure. A hand-over is one record on the
  // stream saying which generation ended, what it leaves open and what the
  // successor must read; the successor's first message names that record by id.
  //
  // The id is the point. "I read the ledger" is a claim; "I acknowledge
  // decision-<id>" is a claim about one particular record that either exists or
  // does not, and the architect can check it in one look.

  function handoverSubject(agent, generation) {
    return label(agent) + " hands over at generation " + generation;
  }

  // "a", "a and b", "a, b and c" (proposal 104).
  //
  // The summary used to name linesOf(r.commit)[0] alone. The fourth Kalam's
  // hand-over passed three commits and the line a person reads named one of
  // them, as though the stop stood on a third of the work it stood on. The
  // details field and the refs carried all three, which is why nobody would
  // have noticed: the record was complete and the sentence was not.
  function englishList(items) {
    var list = linesOf(items);
    if (!list.length) return "";
    if (list.length === 1) return list[0];
    return list.slice(0, -1).join(", ") + " and " + list[list.length - 1];
  }

  // The message, as a partial: the caller runs it through protocol.normalise so
  // this file stays loadable in a browser with no protocol.js beside it.
  function handoverMessage(report) {
    var r = report || {};
    var generation = Number(r.generation) || 1;
    var open = linesOf(r.open);
    return {
      from: textOf(r.agent).toLowerCase(),
      to: textOf(r.to) || "all",
      type: "decision",
      subject: handoverSubject(r.agent, generation),
      summary:
        label(r.agent) + " generation " + generation + " stops here and generation " +
        (generation + 1) + " takes the name, the account and the role. " +
        (open.length
          ? "Open: " + open.join(" ") + " "
          : "Nothing is left open. ") +
        "The ledger is governance/ledger/" + textOf(r.agent).toLowerCase() +
        ".md and it stands on commit" + (linesOf(r.commit).length > 1 ? "s " : " ") +
        (englishList(r.commit) || "an unrecorded commit") + ".",
      details: [
        "ledger: governance/ledger/" + textOf(r.agent).toLowerCase() + ".md",
        "commit: " + (linesOf(r.commit).join(", ") || "none recorded"),
        "item: " + (linesOf(r.item)[0] || "none named")
      ].join("\n"),
      refs: ["proposal 96", "governance/ledger/" + textOf(r.agent).toLowerCase() + ".md"]
        .concat(linesOf(r.commit).map(function (c) { return "commit " + c; })),
      handover: true,
      agent: textOf(r.agent).toLowerCase(),
      generation: generation
    };
  }

  // What the successor has to say, printed for a person to paste into the
  // induction. Naming the record by id is the whole mechanism: it cannot be
  // said by an agent that never read it.
  // --- the stop that owes a record ----------------------------------------
  //
  // Proposal 104. The third Kalam wrote its ledger, posted a status saying it
  // was stopping, and never ran scripts/handover.js. Its successor had nothing
  // to acknowledge by id, which is the one thing proposal 96 added the tool for.
  // A tool that exists is not a tool that runs, so the check asks.
  //
  // The order this requires is the order the stop happens in: say you are
  // stopping, then write the record. A hand-over posted before the last
  // stopping status is a hand-over from an earlier stop.

  var STOPPING = /\bstopping\b|\bstops here\b|\bhand(?:s|ing) over\b/;

  // A status that says the agent is stopping, in its three words or its
  // subject. Only a status: a decision that says "hands over" is the record
  // itself, not the announcement of one.
  function saysStopping(message) {
    if (!message || message.type !== "status") return false;
    return STOPPING.test((textOf(message.now) + " " + textOf(message.subject)).toLowerCase());
  }

  function isHandover(message) {
    return !!(message && message.handover === true && textOf(message.from));
  }

  // Every agent whose last stopping status has no hand-over record after it.
  // `agents` narrows it to the names that have a ledger; empty means all.
  //
  // File order decides, not the clock, as it does for a reminder: the log is
  // append-only, so the line that came later is the later fact, and a clock
  // written by the sender is the sender's.
  function stopsWithoutHandover(messages, agents) {
    var list = Array.isArray(messages) ? messages : [];
    var only = linesOf(agents).map(function (a) { return a.toLowerCase(); });
    var stopped = {};
    var handed = {};

    list.forEach(function (m, at) {
      var from = textOf(m && m.from).toLowerCase();
      if (!from) return;
      if (only.length && only.indexOf(from) === -1) return;
      if (saysStopping(m)) stopped[from] = { at: at, message: m };
      else if (isHandover(m)) handed[from] = { at: at, message: m };
    });

    return Object.keys(stopped).sort().filter(function (from) {
      return !handed[from] || handed[from].at < stopped[from].at;
    }).map(function (from) {
      var last = handed[from];
      return {
        agent: from,
        status: stopped[from].message,
        handover: last ? last.message : null,
        why: label(from) + " posted " + (stopped[from].message.id || "a status") +
          " saying it was stopping, and " +
          (last
            ? "its newest hand-over record, " + last.message.id + ", was written before that."
            : "has never written a hand-over record.") +
          " Its successor has no id to acknowledge. Run: node scripts/handover.js --agent " +
          from + " --item \"...\" --open \"...\" --commit <sha> --send"
      };
    });
  }

  function acknowledgementFor(message, agent, generation) {
    var next = Number(generation) + 1;
    return [
      "The successor is " + label(agent) + " generation " + next + ".",
      "",
      "Its first message on the stream must acknowledge this record by id:",
      "",
      "    " + (message && message.id ? message.id : "(no id yet -- this was a rehearsal)"),
      "",
      "It reads, in this order, before anything else:",
      "",
      "  1. governance/ledger/" + String(agent).toLowerCase() + ".md, all of it",
      "  2. governance/README.md and governance/PROTOCOL.md",
      "  3. the proposal it is given, on chain",
      "",
      "Then it posts one status carrying `ctx`, so the dashboard knows how full",
      "it is from its first minute.",
      ""
    ].join("\n");
  }

  return {
    PARTS: PARTS,
    linesOf: linesOf,
    englishList: englishList,
    handoverSubject: handoverSubject,
    handoverMessage: handoverMessage,
    saysStopping: saysStopping,
    isHandover: isHandover,
    stopsWithoutHandover: stopsWithoutHandover,
    acknowledgementFor: acknowledgementFor,
    validate: validate,
    assertValid: assertValid,
    label: label,
    today: today,
    headerFor: headerFor,
    renderSection: renderSection,
    sectionsIn: sectionsIn
  };
});
