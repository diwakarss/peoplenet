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
  intervalMs: 5 * 60 * 1000
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
  }, { idPrefix: "watch" });
}

// Has this proposal's trigger already been reported? One message per proposal,
// because a watcher that shouts every five minutes gets turned off.
function alreadyFired(messages, proposalId) {
  return (messages || []).some(function (m) {
    return m && m.from === "watch" && Number(m.proposal) === Number(proposalId);
  });
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
    } catch (e) {
      console.warn("watch: pass failed -- " + (e.message || e));
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, opts.intervalMs);
  if (timer.unref) timer.unref();
  setTimeout(tick, opts.firstDelayMs === undefined ? 4000 : opts.firstDelayMs).unref?.();
  return { tick: tick, stop: function () { clearInterval(timer); } };
}

module.exports = {
  DEFAULTS,
  parseRule,
  triggerOf,
  globToRegExp,
  evaluate,
  runOnce,
  firedMessage,
  alreadyFired,
  start,
  compareVersions
};
