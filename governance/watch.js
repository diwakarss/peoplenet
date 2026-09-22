// governance/watch.js -- the trigger watcher (spec 27.12 (2)).
//
// A proposal may carry a trigger: a plain-English condition the Director reads,
// and a machine rule this file evaluates.
//
//   { "trigger": { "text": "when any of the four cache modules changes",
//                  "rule": "path-changed:tools/floating-assistant/*cache*.py" } }
//
// Five rules, and no more, because every one of them has to be explainable in
// the card's own sentence:
//
//   incident-key:<k>        an incident of that kind is in the widget's log
//   path-changed:<glob>     a file matching the glob changed since the proposal
//                           was filed
//   version:<x>             the widget reached that version
//   date:<iso>              that date has passed
//   count:<file>:<n>        a count in a report crossed that line
//
// It runs with the server, evaluates every five minutes, and when a rule fires
// it posts one status message from "watch" under the card. The page picks that
// up on its two-second poll, notifies the browser, and moves the proposal to the
// front of the one-at-a-time flow until the Director opens it.
//
// It fires once per proposal per run of the server: a trigger that has already
// posted is not posted again, because a watcher that shouts every five minutes
// is a watcher the operator turns off.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const P = require("./protocol.js");

const GOV = __dirname;
const MESSAGES = path.join(GOV, "messages.jsonl");

// Where the outside world lives. Overridable so the checks can point the whole
// evaluator at fixtures and never touch the real incidents file.
const DEFAULTS = {
  incidentsFile: path.join(os.homedir(), ".gbrain-widget-incidents.jsonl"),
  widgetRepo: path.join("C:", "Users", "diwak", "Documents", "claude-projects", "learning-assist"),
  versionFile: path.join(
    "C:", "Users", "diwak", "Documents", "claude-projects", "learning-assist",
    "tools", "floating-assistant", "version.py"
  ),
  reportDir: path.join(GOV, "reports"),
  intervalMs: 5 * 60 * 1000,
  // How often the chain is written to disk (proposal 92). The record lives in
  // one process's memory until the move to the cloud, so ten minutes is the
  // most that can be lost to a sign-out.
  snapshotMs: 10 * 60 * 1000,
  // How long a failed snapshot waits before its one retry (proposal 103). Both
  // incidents this rule exists for were a single dropped connection that the
  // next attempt would have survived, so the retry is short and there is only
  // one: a second failure five seconds later is a real fault, not a blip.
  snapshotRetryMs: 5 * 1000,
  // OFF unless the caller asks. Only the governance server takes snapshots;
  // a test that stands up a watcher on the in-process network must not write
  // the real snapshot directory, and the first run of these tests did exactly
  // that -- a 42-event picture of a throwaway chain landed beside the real
  // ones. Making it opt-in is the only version of this that does not depend on
  // every future test remembering.
  snapshot: false
};

// --- parsing -----------------------------------------------------------

// "path-changed:tools/**/*.py" -> { kind, argument }
function parseRule(rule) {
  const text = String(rule || "").trim();
  if (!text) return { kind: null, error: "empty rule" };
  const at = text.indexOf(":");
  if (at < 0) return { kind: null, error: `rule "${text}" has no kind; expected <kind>:<argument>` };
  const kind = text.slice(0, at).trim();
  const argument = text.slice(at + 1).trim();
  const known = ["incident-key", "path-changed", "version", "date", "count"];
  if (known.indexOf(kind) === -1) {
    return { kind: null, error: `rule kind "${kind}" is not one of: ${known.join(", ")}` };
  }
  if (!argument) return { kind: null, error: `rule "${text}" has no argument` };
  return { kind, argument };
}

// A proposal's trigger, from its 27.1 document. Returns null when it has none.
function triggerOf(proposal) {
  const doc = proposal && proposal.format && proposal.format.doc;
  const trigger = doc && doc.trigger;
  if (!trigger || typeof trigger !== "object") return null;
  const text = typeof trigger.text === "string" ? trigger.text.trim() : "";
  const rule = typeof trigger.rule === "string" ? trigger.rule.trim() : "";
  if (!rule) return null;
  return { text: text, rule: rule, parsed: parseRule(rule) };
}

// A glob, deliberately small: * within a segment, ** across segments, {a,b}.
//
// Scanned character by character rather than through placeholder substitutions:
// a placeholder has to survive the escaping pass, and one that does not is a
// silent mis-match rather than an error. This way every character is decided
// once, in one place.
function globToRegExp(glob) {
  const text = String(glob);
  let out = "";
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (c === "*") {
      if (text[i + 1] === "*") { out += ".*"; i += 2; }
      else { out += "[^/]*"; i += 1; }
      continue;
    }

    if (c === "?") { out += "[^/]"; i += 1; continue; }

    if (c === "{") {
      const close = text.indexOf("}", i);
      if (close > i) {
        const options = text.slice(i + 1, close).split(",").map(function (o) {
          return escapeLiteral(o.trim());
        });
        out += "(?:" + options.join("|") + ")";
        i = close + 1;
        continue;
      }
    }

    out += escapeLiteral(c);
    i += 1;
  }

  return new RegExp("^" + out + "$");
}

function escapeLiteral(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- the five rules ----------------------------------------------------

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return P.parseJsonl(fs.readFileSync(file, "utf8")).records;
}

function runGit(repo, args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", repo].concat(args), { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? "" : String(stdout));
    });
  });
}

// incident-key:<k> -- an incident of that kind is in the widget's log, filed
// after the proposal was. An incident from before the proposal is what the
// proposal is about, not news.
function checkIncidentKey(argument, proposal, options) {
  const records = readJsonl(options.incidentsFile);
  const since = filedAt(proposal);
  const hits = records.filter((r) => {
    if (!r) return false;
    const key = String(r.key || r.incidentKey || r.subject || "").toLowerCase();
    const refs = Array.isArray(r.refs) ? r.refs.join(" ").toLowerCase() : "";
    if (key.indexOf(argument.toLowerCase()) === -1 && refs.indexOf(argument.toLowerCase()) === -1) {
      return false;
    }
    if (!since) return true;
    const at = String(r.ts || r.at || "");
    return !at || at > since;
  });
  if (!hits.length) return { fired: false, because: `no "${argument}" incident since the proposal was filed` };
  return {
    fired: true,
    because: `${hits.length} "${argument}" incident${hits.length === 1 ? "" : "s"} since the proposal was filed`,
    details: hits.slice(-3).map((h) => String(h.subject || h.summary || h.key || "")).join("\n")
  };
}

// path-changed:<glob> -- a file matching the glob changed in the widget's repo
// since the proposal was filed.
async function checkPathChanged(argument, proposal, options) {
  const since = filedAt(proposal);
  if (!since) return { fired: false, because: "the proposal has no filed_at to measure from" };
  if (!fs.existsSync(path.join(options.widgetRepo, ".git"))) {
    return { fired: false, because: `no git repository at ${options.widgetRepo}` };
  }
  const out = await runGit(options.widgetRepo, ["log", "--since", since, "--name-only", "--pretty=format:"]);
  const changed = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const re = globToRegExp(argument);
  const matched = changed.filter((f) => re.test(f)).filter((v, i, a) => a.indexOf(v) === i);
  if (!matched.length) return { fired: false, because: `nothing matching ${argument} changed since ${since}` };
  return {
    fired: true,
    because: `${matched.length} file${matched.length === 1 ? "" : "s"} matching ${argument} changed since the proposal was filed`,
    details: matched.slice(0, 20).join("\n")
  };
}

// version:<x> -- the widget reached that version.
function checkVersion(argument, proposal, options) {
  if (!fs.existsSync(options.versionFile)) {
    return { fired: false, because: `no version file at ${options.versionFile}` };
  }
  const text = fs.readFileSync(options.versionFile, "utf8");
  const m = /^\s*VERSION\s*=\s*["']([^"']+)["']/m.exec(text);
  if (!m) return { fired: false, because: "no VERSION line in the version file" };
  const current = m[1];
  if (compareVersions(current, argument) < 0) {
    return { fired: false, because: `the widget is on ${current}, not yet ${argument}` };
  }
  return { fired: true, because: `the widget reached ${current}`, details: `VERSION = "${current}"` };
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// date:<iso> -- that date has passed.
function checkDate(argument, proposal, options) {
  const when = new Date(argument);
  if (isNaN(when.getTime())) return { fired: false, because: `"${argument}" is not a date` };
  const now = options.now ? new Date(options.now) : new Date();
  if (now < when) return { fired: false, because: `not until ${when.toISOString().slice(0, 10)}` };
  return { fired: true, because: `${when.toISOString().slice(0, 10)} has passed` };
}

// count:<file>:<n> -- a count in a report crossed that line. The file is read
// from the reports directory; a bare number, a {"count":n} object or a .jsonl
// of records all work, because the report is someone else's format.
function checkCount(argument, proposal, options) {
  const at = argument.lastIndexOf(":");
  if (at < 0) return { fired: false, because: `count rule needs <file>:<n>, got "${argument}"` };
  const file = argument.slice(0, at).trim();
  const threshold = Number(argument.slice(at + 1).trim());
  if (!Number.isFinite(threshold)) {
    return { fired: false, because: `"${argument.slice(at + 1)}" is not a number` };
  }
  const target = path.resolve(options.reportDir, file);
  if (!target.startsWith(path.resolve(options.reportDir))) {
    return { fired: false, because: "a count rule may not read outside the reports directory" };
  }
  // A missing directory and a missing file are different problems, and a rule
  // that can never fire should say which one it has rather than look like a
  // count that has not been reached yet.
  if (!fs.existsSync(options.reportDir)) {
    return {
      fired: false,
      invalid: true,
      because: `there is no reports directory at ${options.reportDir}, so no count rule can ever fire`
    };
  }
  if (!fs.existsSync(target)) return { fired: false, because: `no report at ${file}` };

  const text = fs.readFileSync(target, "utf8").trim();
  let count = null;
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    count = Number(text);
  } else {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "number") count = parsed;
      else if (parsed && typeof parsed.count === "number") count = parsed.count;
      else if (Array.isArray(parsed)) count = parsed.length;
    } catch (e) {
      count = P.parseJsonl(text).records.length;
    }
  }
  if (count === null) return { fired: false, because: `cannot read a count out of ${file}` };
  if (count < threshold) return { fired: false, because: `${file} is at ${count}, below ${threshold}` };
  return { fired: true, because: `${file} reached ${count}, at or above ${threshold}`, details: `count = ${count}` };
}

function filedAt(proposal) {
  const doc = proposal && proposal.format && proposal.format.doc;
  if (doc && typeof doc.filed_at === "string" && doc.filed_at) return doc.filed_at;
  if (proposal && proposal.createdAt) return new Date(proposal.createdAt * 1000).toISOString();
  return null;
}

// Evaluate one trigger. Never throws: a broken rule reports itself and the rest
// of the watch carries on.
async function evaluate(trigger, proposal, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  if (!trigger) return { fired: false, because: "no trigger" };
  const { kind, argument, error } = trigger.parsed || parseRule(trigger.rule);
  if (error) return { fired: false, because: error, invalid: true };
  try {
    if (kind === "incident-key") return checkIncidentKey(argument, proposal, opts);
    if (kind === "path-changed") return await checkPathChanged(argument, proposal, opts);
    if (kind === "version") return checkVersion(argument, proposal, opts);
    if (kind === "date") return checkDate(argument, proposal, opts);
    if (kind === "count") return checkCount(argument, proposal, opts);
    return { fired: false, because: `unknown rule kind ${kind}`, invalid: true };
  } catch (e) {
    return { fired: false, because: "the rule could not be evaluated: " + (e.message || e), invalid: true };
  }
}

// --- the watch ---------------------------------------------------------

// The message a fired trigger posts: a status from "watch", naming the proposal,
// saying in the trigger's own words what happened and in the rule's words why.
function firedMessage(proposal, trigger, result) {
  return P.normalise({
    from: "watch",
    to: "director",
    type: "status",
    subject: `Proposal ${proposal.id}: the thing you were waiting for happened`,
    summary: (trigger.text ? trigger.text + " " : "") + "It has: " + result.because + ".",
    details: [("rule: " + trigger.rule), result.details || ""].filter(Boolean).join("\n\n"),
    refs: ["proposal " + proposal.id],
    proposal: proposal.id,
    aaoId: proposal.aaoId,
    trigger: trigger.rule
    // The subject names the proposal, so the six fields already tell two of
    // these apart and the id needs nothing added to it.
  });
}

// Has this proposal's trigger already been reported? One message per proposal,
// because a watcher that shouts every five minutes gets turned off.
//
// An unclaimed notice is excluded by name: it also comes from "watch" and also
// names its proposal, and counting it would silence that proposal's trigger for
// good.
// The rule itself lives in read.js, once: the page decides what to pin with it
// and the watcher decides what to post with it, and two copies would disagree
// on exactly the proposals that matter.
// A fired reminder also comes from "watch" and also names its proposal, so
// this asks triggerReported, which counts trigger reports only. Asking
// triggerHasFired here would let a reminder delivered on Monday silence that
// proposal's real trigger for good.
function alreadyFired(messages, proposalId) {
  return Boolean(require("./read.js").triggerReported(messages, proposalId));
}

// --- a closed proposal's trigger does not fire (proposal 95) -------------
//
// runOnce fired a trigger whatever state its proposal was in. Proposal 93
// carries "closed: superseded by proposal 98", and its date trigger would have
// fired on Thursday all the same -- telling the Director that the thing he was
// waiting for had happened, on a proposal nobody is waiting on any more.
//
// Two ways a proposal is finished and both count: the chain has stopped it
// being Active, or its latest decision is a closed state. The decision is read
// through adoption.js, the same index the card reads, so the watcher and the
// page cannot disagree about what closed means.
function skipBecause(proposal, messages) {
  const A = require("./adoption.js");
  const status = proposal && proposal.status;
  if (status !== undefined && status !== null && Number(status) !== 0) return "closed";
  const adoption = A.adoptionOf(A.indexDecisions(messages || []), proposal.id);
  return A.isClosedByBuild(adoption) ? "closed" : null;
}

// --- passed, and nobody picked it up (proposal 91) ----------------------
//
// The three columns on /swarm are built from agents' decision messages, so a
// proposal no agent ever mentioned appears in none of them. Proposal 54 passed
// on 2026-09-19 and sat undelivered for two days; the Director found it
// himself. swarm.js decides which proposals those are -- one rule, tested
// without a browser -- and this tells their architect, once each.

// Who to tell, as a message key: the architect named by the organisation's rule
// set, or everyone when it names none.
function architectKeyFor(aao) {
  const R = require("./read.js");
  const rules = R.rulesFor(aao);
  return rules && rules.architect ? R.labelFor(rules.architect).toLowerCase() : "all";
}

function unclaimedMessage(row, to) {
  const hours = Math.floor(row.waitedMs / 3600000);
  return P.normalise({
    from: "watch",
    to: to,
    type: "status",
    subject: `Proposal ${row.proposalId} passed ${hours} hours ago and nobody has picked it up`,
    summary:
      `"${row.title}" passed on ${row.organisation || "its organisation"} and was ` +
      `executed ${hours} hours ago. No agent has posted a decision on it, so it is ` +
      `in no column on the dashboard and in nobody's queue. It is listed as ` +
      `unclaimed on /swarm until an agent says something about it.`,
    details: `executed at ${row.executedAt}\narchitect: ${row.architect}`,
    refs: ["proposal " + row.proposalId, "proposal 91"],
    proposal: row.proposalId,
    aaoId: row.aaoId,
    // What tells this apart from every other message the watcher writes about a
    // proposal, for both the once-only check and `alreadyFired`.
    unclaimed: true
  });
}

// Said once per proposal, for the same reason a trigger is: a line repeated
// every five minutes is a line the architect stops reading.
function alreadyToldUnclaimed(messages, proposalId) {
  return (messages || []).some(function (m) {
    return m && m.from === "watch" && m.unclaimed === true &&
      Number(m.proposal) === Number(proposalId);
  });
}

// One pass over the unclaimed list. Appends one message per proposal that has
// crossed the four-hour line and has not been reported yet.
function reportUnclaimed(proposals, aaos, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const S = require("./swarm.js");
  const messagesFile = opts.messagesFile || MESSAGES;
  const existing = readJsonl(messagesFile);
  const rows = S.unclaimed(existing, proposals, aaos, opts.nowMs);
  const told = [];

  for (const row of rows) {
    if (alreadyToldUnclaimed(existing, row.proposalId)) continue;
    const aao = (aaos || []).filter((a) => a.id === row.aaoId)[0];
    const message = unclaimedMessage(row, aao ? architectKeyFor(aao) : "all");
    fs.appendFileSync(messagesFile, P.toJsonl(message), "utf8");
    existing.push(message);
    told.push({ proposal: row.proposalId, to: message.to, waitedMs: row.waitedMs });
  }

  return { listed: rows, told: told };
}

// --- a due reminder (proposal 99) ---------------------------------------
//
// A reminder is not a proposal. Nobody votes on one, and when it falls due the
// watcher does three things and stops:
//
//   1. a push to the Director's phone, carrying the proposal number and no
//      proposal text (governance/push.js says why)
//   2. a status message from "watch" under the card, which the page shows on
//      its two-second poll
//   3. a `fired` line in reminders.jsonl, which is both the record and the
//      once-only guard: the file is append-only and the latest line wins
//
// (2) also counts as fired for proposal 95's viewFor, so a reminder set on a
// live proposal brings that proposal back into the Director's vote list.

const REMINDERS = path.join(GOV, "reminders.jsonl");

// The message a fired reminder posts. `reminder` is the id, and it is what
// tells this apart from a trigger report and from an unclaimed notice -- three
// kinds of message from one sender now, each of which some other function has
// to be able to exclude.
function reminderMessage(reminder) {
  const RM = require("./reminders.js");
  return P.normalise({
    from: "watch",
    to: "director",
    type: "status",
    subject: `Reminder due on proposal ${reminder.proposal}`,
    summary: reminder.text + " It was set for " + RM.describeDue(reminder) + ", and that day has come.",
    details: `set by ${reminder.set_by}\nreminder ${reminder.id}`,
    refs: ["proposal " + reminder.proposal, "proposal 99"],
    proposal: reminder.proposal,
    aaoId: reminder.aaoId,
    reminder: reminder.id
  });
}

// Why this reminder does not fire, or null.
//
// "A reminder on a closed proposal does not fire": a proposal that is finished
// is not something to be brought back to.
//
// With one exception, and it is the exception the migration depends on.
// Proposals 94 and 98 were reminders wearing a proposal's clothes, so landing
// this closes them -- "closed: superseded by reminder <id>". If closed alone
// were the test, the two reminders the migration exists to preserve would be
// the only two that could never fire, and nobody would find out until the
// Director's phone stayed quiet on the 28th. So a proposal closed BY this
// reminder is not closed against it.
function reminderSkipBecause(reminder, proposal, messages) {
  if (!proposal) return null;
  const A = require("./adoption.js");
  const status = proposal.status;
  const onChainClosed = status !== undefined && status !== null && Number(status) !== 0;
  const decision = A.adoptionOf(A.indexDecisions(messages || []), proposal.id);
  const decidedClosed = A.isClosedByBuild(decision);
  if (!onChainClosed && !decidedClosed) return null;

  const said = String((decision && (decision.summary || decision.text)) || "") +
    " " + String((decision && decision.subject) || "");
  if (reminder && reminder.id && said.indexOf(reminder.id) !== -1) return null;

  return "closed";
}

// Said once, and never again, for the same reason every other line here is:
// a watcher that repeats itself every five minutes is a watcher the operator
// turns off. The marker is on the message, not in this process's memory, so a
// restart does not start the repetition over.
function alreadySaid(messages, field, value) {
  return (messages || []).some(function (m) {
    return m && m.from === "watch" && m[field] === value;
  });
}

// One pass over the reminders. `proposals` is what the chain shows, so a
// reminder can be measured against the state of the proposal it names.
async function runReminders(proposals, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const RM = require("./reminders.js");
  const PUSH = opts.push || require("./push.js");
  const messagesFile = opts.messagesFile || MESSAGES;
  const remindersFile = opts.remindersFile || REMINDERS;

  const records = readJsonl(remindersFile);
  const dueNow = RM.due(records, opts.now);
  const fired = [];
  const skipped = [];
  if (!dueNow.length) return { fired, skipped };

  const messages = readJsonl(messagesFile);
  const byId = {};
  (proposals || []).forEach((p) => { byId[p.id] = p; });

  for (const reminder of dueNow) {
    const why = reminderSkipBecause(reminder, byId[reminder.proposal], messages);
    if (why) {
      skipped.push({ id: reminder.id, proposal: reminder.proposal, because: why });
      continue;
    }

    // The page line first: it is the fallback the proposal's own risk section
    // names, and it must not depend on a push service outside our control.
    const message = reminderMessage(reminder);
    fs.appendFileSync(messagesFile, P.toJsonl(message), "utf8");
    messages.push(message);

    // Then the phone.
    let push = { ok: false, skipped: true };
    try {
      push = await PUSH.send(PUSH.bodyFor(reminder), { env: opts.env, fetchImpl: opts.fetchImpl,
        attempts: opts.pushAttempts, backoffMs: opts.pushBackoffMs, sleep: opts.sleep });
    } catch (e) {
      push = { ok: false, skipped: false, error: PUSH.redact(e.message || e, opts.env) };
    }

    if (push.skipped && !alreadySaid(messages, "pushUnconfigured", true)) {
      const note = P.normalise({
        from: "watch",
        to: "director",
        type: "status",
        subject: "A reminder came due and there is no phone to reach",
        summary: PUSH.notConfiguredLine(),
        details: "",
        refs: ["proposal 99"],
        pushUnconfigured: true
      });
      fs.appendFileSync(messagesFile, P.toJsonl(note), "utf8");
      messages.push(note);
    }

    // A failed push is one incident per reminder, never one per tick. The error
    // has already been through redact(), so the topic is not in it.
    if (!push.ok && !push.skipped && !alreadySaid(messages, "pushFailed", reminder.id)) {
      const incident = P.normalise({
        from: "watch",
        to: "director",
        type: "incident",
        subject: `The push for proposal ${reminder.proposal} did not reach the phone`,
        summary:
          `A reminder on proposal ${reminder.proposal} came due and the push failed after ` +
          `${push.attempts || 0} attempt(s). The line on the page is there, so nothing is lost; ` +
          "only the phone was not reached. Said once for this reminder, not every five minutes.",
        details: push.error || "no reason reported",
        refs: ["proposal " + reminder.proposal, "proposal 99"],
        pushFailed: reminder.id
      });
      fs.appendFileSync(messagesFile, P.toJsonl(incident), "utf8");
      messages.push(incident);
    }

    // Last: the record that it happened. Written after the message, so a crash
    // between the two leaves a reminder that fires again rather than one that
    // silently never did.
    const firedLine = RM.supersede(reminder, {
      state: "fired",
      fired_at: message.ts,
      pushed: Boolean(push.ok)
    }, message.ts);
    fs.appendFileSync(remindersFile, P.toJsonl(firedLine), "utf8");

    fired.push({ id: reminder.id, proposal: reminder.proposal, pushed: Boolean(push.ok),
      pushSkipped: Boolean(push.skipped) });
  }

  return { fired, skipped };
}

// --- executing what the rules say is decided --------------------------

// Nobody presses a button on the widget-builder: once the tally is decisive
// and the rule in force says so, the watcher executes. That is what makes it
// an organisation the agents can finish something in, rather than a queue that
// only fills up.
//
// It signs by asking the node for a signer on one of its own unlocked
// accounts, exactly as the page does. No key is held here.
//
// `opts.nowSeconds` is the clock the window is measured against. The caller
// passes the latest block's timestamp, so chain time is compared with chain
// time: the votes are dated by the blocks that carried them, and a node whose
// clock has drifted from the wall must not shorten anybody's window. Without
// it the wall clock is used, which is right often enough and wrong silently,
// so `start` always supplies it.
async function executeDecided(aaos, allProposals, options) {
  const opts = options || {};
  const R = require("./read.js");
  const executed = [];
  const waiting = [];

  if (!opts.signerFor || !opts.ethers) return { executed, waiting };

  for (const aao of aaos || []) {
    const mine = (allProposals || []).filter((p) => p.aaoId === aao.id);
    const rules = R.effectiveRules(aao, mine);
    // Both self-executing regimes, and only those: "automatic" waits for every
    // voter or the window, "on-director-vote" waits for the Director's vote
    // (proposal 58). autoExecuteState is what tells them apart.
    if (rules.autoExecute !== "automatic" && rules.autoExecute !== "on-director-vote") continue;

    for (const proposal of mine) {
      const state = R.autoExecuteState(rules, proposal, opts.nowSeconds);
      if (!state.should) {
        if (state.tied) waiting.push({ id: proposal.id, reason: state.reason });
        else if (state.reason && /window/.test(state.reason)) {
          waiting.push({ id: proposal.id, reason: state.reason, holding: true });
        }
        continue;
      }

      try {
        const signer = await opts.signerFor(state.by);
        const contract = R.getContract(opts.ethers, signer, opts.diamond);
        const tx = await contract.executeProposal(proposal.id);
        const receipt = await tx.wait();

        let passed = null;
        for (const log of receipt.logs) {
          try {
            const parsed = contract.interface.parseLog(log);
            if (parsed && parsed.name === "ProposalExecuted") passed = Boolean(parsed.args.passed);
          } catch (e) { /* a log from another facet */ }
        }

        // Say so where the Director reads it, in the shape everything uses.
        const message = P.normalise({
          from: "watch",
          to: "all",
          type: "decision",
          subject: `Proposal ${proposal.id}: executed automatically`,
          summary:
            (passed ? "Built into the record: it passed " : "Closed: it was rejected ") +
            `${proposal.forVotes} to ${proposal.againstVotes}. ` + state.reason +
            (rules.interim ? " Under the interim rule, while the widget cannot vote." : ""),
          details:
            `executed by ${R.labelFor(state.by)} in block ${receipt.blockNumber}` +
            `\ntx ${receipt.hash}`,
          refs: ["proposal " + proposal.id],
          proposal: proposal.id,
          aaoId: proposal.aaoId
          // Numbered by what it says, which names the proposal, the tally and
          // the block: two executions are never one message.
        });

        fs.appendFileSync(opts.messagesFile || MESSAGES, P.toJsonl(message), "utf8");
        executed.push({ id: proposal.id, passed, block: receipt.blockNumber, reason: state.reason });
      } catch (e) {
        console.warn(`watch: could not execute proposal ${proposal.id} -- ${e.message || e}`);
      }
    }
  }

  return { executed, waiting };
}

// One pass. Returns what fired, and appends a message for each.
async function runOnce(proposals, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const messagesFile = opts.messagesFile || MESSAGES;
  const existing = readJsonl(messagesFile);
  const fired = [];
  const looked = [];

  for (const proposal of proposals || []) {
    const trigger = triggerOf(proposal);
    if (!trigger) continue;
    const finished = skipBecause(proposal, existing);
    if (finished) {
      looked.push({ id: proposal.id, fired: false, because: finished });
      continue;
    }
    if (alreadyFired(existing, proposal.id)) {
      looked.push({ id: proposal.id, fired: false, because: "already reported" });
      continue;
    }
    const result = await evaluate(trigger, proposal, opts);
    looked.push({ id: proposal.id, fired: result.fired, because: result.because, invalid: result.invalid });
    if (!result.fired) continue;

    const message = firedMessage(proposal, trigger, result);
    fs.appendFileSync(messagesFile, P.toJsonl(message), "utf8");
    existing.push(message);
    fired.push({ proposal: proposal.id, message: message, result: result });
  }

  return { fired: fired, looked: looked };
}

// Start the loop beside the server. The first pass runs after a short delay so
// the server is answering before the watcher starts reading the chain.
function start(readProposals, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const proposals = await readProposals();
      const { fired, looked } = await runOnce(proposals, opts);
      const watched = looked.length;
      if (fired.length) {
        fired.forEach((f) => console.log(`watch: proposal ${f.proposal} fired -- ${f.result.because}`));
      }
      const broken = looked.filter((l) => l.invalid);
      broken.forEach((b) => console.warn(`watch: proposal ${b.id} has a rule that will never fire -- ${b.because}`));
      if (watched && !fired.length && !broken.length) {
        console.log(`watch: ${watched} trigger(s) checked, none fired`);
      }

      // Then the reminders that have fallen due (proposal 99). Before the
      // unclaimed pass, because a reminder is a promise to a person with a date
      // on it and everything else here is housekeeping.
      try {
        const reminders = await runReminders(proposals, opts);
        reminders.fired.forEach((r) => console.log(
          `watch: reminder on proposal ${r.proposal} is due -- ` +
          (r.pushSkipped ? "no phone configured" : (r.pushed ? "pushed" : "the push failed"))
        ));
        reminders.skipped.forEach((r) => console.log(
          `watch: reminder on proposal ${r.proposal} not fired -- ${r.because}`
        ));
      } catch (e) {
        console.warn("watch: could not run the reminders -- " + (e.message || e));
      }

      // Then the proposals that passed and that nobody picked up (proposal 91).
      // It needs the organisations, to name each one's architect.
      if (opts.readAaos) {
        try {
          const aaosForUnclaimed = await opts.readAaos();
          const { listed, told } = reportUnclaimed(proposals, aaosForUnclaimed, opts);
          told.forEach((t) => console.log(
            `watch: proposal ${t.proposal} passed and is unclaimed -- told ${t.to}`
          ));
          if (listed.length && !told.length) {
            console.log(`watch: ${listed.length} proposal(s) unclaimed, all already reported`);
          }
        } catch (e) {
          console.warn("watch: could not check for unclaimed proposals -- " + (e.message || e));
        }
      }

      // Then close whatever the rules say is decided. On the widget-builder
      // nobody presses a button, so if the watcher does not do this, nothing
      // does -- which is how three proposals sat there with no way out.
      if (opts.readAaos && opts.signerFor) {
        const aaos = await opts.readAaos();
        const nowSeconds = await chainNow(opts);
        const { executed, waiting } =
          await executeDecided(aaos, proposals, Object.assign({}, opts, { nowSeconds }));
        executed.forEach((e) => console.log(
          `watch: proposal ${e.id} executed -> ${e.passed ? "passed" : "rejected"} ` +
          `(block ${e.block}) -- ${e.reason}`
        ));
        // A decision reaches the disk in seconds, not in up to ten minutes.
        if (executed.length) await snapshot(`after executing ${executed.length}`);
        waiting.forEach((w) => console.log(
          w.holding
            ? `watch: proposal ${w.id} is holding -- ${w.reason}`
            : `watch: proposal ${w.id} needs a tie broken -- ${w.reason}`
        ));
      }
    } catch (e) {
      console.warn("watch: pass failed -- " + (e.message || e));
    } finally {
      running = false;
    }
  }

  // --- snapshots (proposal 92) -------------------------------------------
  //
  // A snapshot is taken on a timer and again straight after anything is
  // executed, so a decided proposal is on disk within seconds rather than up to
  // ten minutes later. A failure is printed and posted once -- once, because a
  // broken snapshot every ten minutes would bury the message stream it is
  // trying to warn through -- and never stops the watcher: a watcher that
  // stopped because it could not write a file would take the executions with it.
  //
  // One failure is not a fault (proposal 103). Twice in twelve hours the
  // incident "The chain is not being written to disk" went up on a single
  // dropped connection and the next attempt ten minutes later succeeded, so the
  // Director read two incidents that had healed themselves before he saw them.
  // A failed snapshot now waits five seconds and tries once; only the second
  // failure is said out loud, and the first is a log line nobody is woken for.
  let snapshotWarned = false;

  function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
  }

  // One attempt. Returns what the taker said, or the error it threw, so the
  // caller decides between retrying and reporting -- an attempt that reported
  // its own failure could not be retried quietly.
  async function attemptSnapshot() {
    try {
      const taker = opts.snapshotTaker || require("../scripts/snapshot.js");
      const result = await taker.take(opts.snapshotOptions || {});
      return result && result.ok
        ? { ok: true, result: result, line: `watch: ${taker.describe(result)}` }
        : { ok: false, result: result, line: `watch: ${taker.describe(result)}`, why: result && result.why };
    } catch (e) {
      return {
        ok: false, result: null,
        line: `watch: could not snapshot the chain -- ${e.message || e}`,
        why: e.message || String(e)
      };
    }
  }

  async function snapshot(why) {
    if (!opts.snapshot) return null;

    const first = await attemptSnapshot();
    if (first.ok) {
      snapshotWarned = false;
      console.log(`${first.line}${why ? ` (${why})` : ""}`);
      return first.result;
    }

    console.warn(`${first.line} -- trying once more in ${Math.round(opts.snapshotRetryMs / 1000)}s`);
    await sleep(opts.snapshotRetryMs);

    const second = await attemptSnapshot();
    if (second.ok) {
      snapshotWarned = false;
      console.log(`${second.line}${why ? ` (${why}, on the retry)` : " (on the retry)"}`);
      return second.result;
    }

    warnOnce(second.line, second.why);
    return second.result;
  }

  function warnOnce(line, detail) {
    console.warn(line);
    if (snapshotWarned) return;
    snapshotWarned = true;
    try {
      const message = P.normalise({
        from: "watch",
        to: "all",
        type: "incident",
        subject: "The chain is not being written to disk",
        summary:
          "A snapshot failed and the retry " + Math.round(opts.snapshotRetryMs / 1000) +
          " seconds later failed too, so the record is only in the node's memory " +
          "and a sign-out would destroy it. The watcher is still running and " +
          "still executing; only the snapshot is failing. Said once, not every " +
          "ten minutes.",
        details: detail || line,
        refs: ["proposal 92", "proposal 103"]
      });
      fs.appendFileSync(opts.messagesFile || MESSAGES, P.toJsonl(message), "utf8");
    } catch (e) {
      console.warn(`watch: could not report the snapshot failure -- ${e.message || e}`);
    }
  }

  const timer = setInterval(tick, opts.intervalMs);
  const snapshotTimer = setInterval(() => { snapshot("on the timer"); }, opts.snapshotMs);
  if (snapshotTimer.unref) snapshotTimer.unref();
  if (timer.unref) timer.unref();
  setTimeout(tick, opts.firstDelayMs === undefined ? 4000 : opts.firstDelayMs).unref?.();
  return {
    tick: tick,
    snapshot: snapshot,
    stop: function () { clearInterval(timer); clearInterval(snapshotTimer); }
  };
}

// Chain time, so the execution window is measured against the same clock that
// dated the votes. Falls back to the wall clock when there is no way to ask.
async function chainNow(options) {
  const opts = options || {};
  if (typeof opts.nowSeconds === "number") return opts.nowSeconds;
  try {
    if (opts.latestBlock) {
      const block = await opts.latestBlock();
      if (block && block.timestamp) return Number(block.timestamp);
    }
  } catch (e) {
    // A node that will not answer is not a reason to stop watching.
  }
  return Math.floor(Date.now() / 1000);
}

module.exports = {
  DEFAULTS,
  parseRule,
  triggerOf,
  globToRegExp,
  evaluate,
  runOnce,
  executeDecided,
  chainNow,
  firedMessage,
  alreadyFired,
  skipBecause,
  REMINDERS,
  runReminders,
  reminderMessage,
  reminderSkipBecause,
  alreadySaid,
  reportUnclaimed,
  unclaimedMessage,
  alreadyToldUnclaimed,
  architectKeyFor,
  start,
  compareVersions
};
