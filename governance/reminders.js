// governance/reminders.js -- a reminder is not a proposal (proposal 99).
//
// Kural made reminders 93, 94 and 98 into proposals because a proposal with a
// date trigger was the only tool there was. That shape asks the Director to
// vote on his own reminder, which is one more item in the list the reminder was
// meant to shorten. So a reminder is its own small record:
//
//   { "id": "remind-mu...", "proposal": 98, "aaoId": 2,
//     "due": "2026-09-28T03:30:00Z", "text": "The Mac and the four chat exports",
//     "set_by": "kural", "state": "set", "at": "2026-09-21T..." }
//
// governance/reminders.jsonl is append-only like every other log here: nothing
// edits a line. A later line for the same id supersedes the earlier one, so
// moving a reminder is a new line with a new `due` and cancelling one is a new
// line with `state: "cancelled"`. The file is the record.
//
// This module owns the shape, the four states, the superseding rule and the
// question of whether a reminder is due. The script writes them, the watcher
// fires them, the server serves them, and none of the three carries its own
// idea of what any of that means.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GovernanceReminders = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // set        it will fire when it falls due
  // fired      it has fired; the watcher writes this line
  // cancelled  it will not fire
  // moved      superseded by a line with a new due date
  var STATES = ["set", "fired", "cancelled", "moved"];

  // The states a reminder can still fire from. Only one, and it is named here
  // rather than tested as `state === "set"` in three files.
  function isLive(reminder) {
    return Boolean(reminder) && reminder.state === "set";
  }

  function isIsoDate(value) {
    if (typeof value !== "string" || !value.trim()) return false;
    var when = new Date(value);
    return !isNaN(when.getTime());
  }

  // Every reason this record cannot be written, as plain lines. Never throws.
  function validate(reminder) {
    var errors = [];
    var r = reminder || {};

    if (typeof r.id !== "string" || !r.id.trim()) errors.push("id is required");
    if (!Number.isInteger(Number(r.proposal)) || Number(r.proposal) < 0) {
      errors.push("proposal must be a proposal id");
    }
    if (!Number.isInteger(Number(r.aaoId)) || Number(r.aaoId) < 0) {
      errors.push("aaoId must be an organisation id");
    }
    if (!isIsoDate(r.due)) errors.push("due must be an ISO 8601 date");
    if (typeof r.text !== "string" || !r.text.trim()) {
      errors.push("text is required: say in plain English what this is about");
    }
    if (typeof r.set_by !== "string" || !r.set_by.trim()) errors.push("set_by is required");
    if (STATES.indexOf(r.state) === -1) {
      errors.push('state must be one of: ' + STATES.join(", "));
    }

    return { ok: errors.length === 0, errors: errors };
  }

  function assertValid(reminder, context) {
    var result = validate(reminder);
    if (!result.ok) {
      throw new Error(
        (context ? context + ": " : "") + "invalid reminder\n  - " + result.errors.join("\n  - ")
      );
    }
    return reminder;
  }

  // The current line for every id: the last one in the file wins, because the
  // file is append-only and order is the record. `at` is not trusted for this
  // -- two lines written in the same millisecond would then be unordered, and
  // a clock that went backwards would undo a cancellation.
  function latest(records) {
    var byId = {};
    (records || []).forEach(function (r) {
      if (!r || typeof r.id !== "string" || !r.id) return;
      byId[r.id] = r;
    });
    return byId;
  }

  // The current state of every reminder, oldest first.
  function current(records) {
    var byId = latest(records);
    return Object.keys(byId).map(function (id) { return byId[id]; });
  }

  // Every line ever written for one id, oldest first: what it was set to, where
  // it was moved, when it fired.
  function historyFor(records, id) {
    return (records || []).filter(function (r) {
      return r && r.id === id;
    });
  }

  // The live reminders on one proposal.
  function forProposal(records, proposalId) {
    return current(records).filter(function (r) {
      return Number(r.proposal) === Number(proposalId);
    });
  }

  // Is this reminder due? `now` is an ISO string or a Date; the wall clock
  // otherwise. A cancelled, moved or already-fired reminder is never due.
  function isDue(reminder, now) {
    if (!isLive(reminder)) return false;
    if (!isIsoDate(reminder.due)) return false;
    var at = now ? new Date(now) : new Date();
    if (isNaN(at.getTime())) return false;
    return at.getTime() >= new Date(reminder.due).getTime();
  }

  // Every live reminder that has fallen due, oldest due date first, so a backlog
  // is delivered in the order it was asked for.
  function due(records, now) {
    return current(records)
      .filter(function (r) { return isDue(r, now); })
      .sort(function (a, b) { return new Date(a.due) - new Date(b.due); });
  }

  // A new line superseding an existing reminder: the whole record, not a patch,
  // so one line read on its own is the whole truth about that reminder.
  function supersede(reminder, changes, at) {
    return Object.assign({}, reminder, changes || {}, {
      at: at || new Date().toISOString(),
      // Kept so the history reads as a chain rather than as unrelated lines.
      supersedes: reminder && reminder.at ? reminder.at : null
    });
  }

  // How a person reads a due date. "2026-09-28" and nothing more: the time of
  // day on a reminder is an implementation detail of the trigger it replaced.
  function describeDue(reminder) {
    if (!reminder || !isIsoDate(reminder.due)) return "no date";
    return new Date(reminder.due).toISOString().slice(0, 10);
  }

  return {
    STATES: STATES,
    isLive: isLive,
    isIsoDate: isIsoDate,
    validate: validate,
    assertValid: assertValid,
    latest: latest,
    current: current,
    historyFor: historyFor,
    forProposal: forProposal,
    isDue: isDue,
    due: due,
    supersede: supersede,
    describeDue: describeDue
  };
});
