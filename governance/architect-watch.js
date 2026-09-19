// The parts of an architect's watch that have no loop in them (proposal 68).
//
// scripts/watch-jd.js is the loop; everything it decides lives here, so the
// decisions can be tested without starting a watch and without a chain:
//
//   which organisations the watch covers   topicsFor / resolve
//   where it left off                      cursorPath / readCursor / writeCursor
//   which log lines belong to it           recordIsMine
//
// The cursor lives outside the repository. It is a position, not a record: it
// changes every few seconds, it means nothing on another machine, and a watch
// that dirtied the working tree every pass would make `git status` useless to
// the agent running it.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require("./read.js");

// --- which organisations ------------------------------------------------

// An architect watches the organisation it is the architect of, and every room
// underneath it. Read off the rule sets rather than written down here, so the
// next room is covered the day its rule set names its parent -- JD-build was
// covered the moment proposal 51 named it, without this file changing.
function topicsFor(architect) {
  const rules = R.AAO_RULES;
  const own = Object.keys(rules).filter((topic) => {
    const rule = rules[topic];
    return rule.architect && R.sameAddress(rule.architect, architect) && !rule.parent;
  });
  const under = Object.keys(rules).filter((topic) => own.indexOf(rules[topic].parent) !== -1);
  return own.concat(under);
}

// Topics are what the rule sets know; ids are what the chain knows. A topic
// with no organisation on this chain is named rather than dropped: a watch
// silently covering less than it was asked to is the failure this proposal is
// about.
function resolve(topics, aaos) {
  const byTopic = {};
  (aaos || []).forEach((aao) => { byTopic[aao.topic] = aao.id; });
  const organisations = [];
  const missing = [];
  (topics || []).forEach((topic) => {
    if (byTopic[topic] === undefined) missing.push(topic);
    else organisations.push({ id: byTopic[topic], topic });
  });
  return { organisations, missing, ids: organisations.map((o) => o.id) };
}

// --- where it left off ---------------------------------------------------

function cursorPath(name) {
  const safe = String(name || "watch").toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return path.join(os.tmpdir(), "peoplenet-watch-" + safe + ".json");
}

// Returns the cursor, or null with the reason it could not be used. A watch
// that cannot read its cursor must say so and start from the head: silently
// replaying the whole chain, or silently skipping a day, are both worse than a
// line saying which one happened.
function readCursor(file) {
  if (!fs.existsSync(file)) return { cursor: null, why: "no cursor yet" };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { cursor: null, why: "cursor unreadable: " + (e.message || e) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { cursor: null, why: "cursor is not JSON: " + (e.message || e) };
  }
  if (!parsed || typeof parsed !== "object" || !Number.isInteger(parsed.block) || parsed.block < 0) {
    return { cursor: null, why: "cursor names no block" };
  }
  const offsets = {};
  Object.keys(parsed.offsets || {}).forEach((name) => {
    const at = Number(parsed.offsets[name]);
    if (Number.isFinite(at) && at >= 0) offsets[name] = at;
  });
  return { cursor: { block: parsed.block, offsets, at: parsed.at || null }, why: null };
}

// Written after every pass, whole and at once: a half-written cursor read back
// on the next start is a watch that lies about where it got to.
function writeCursor(file, cursor) {
  const body = JSON.stringify({
    block: cursor.block,
    offsets: cursor.offsets || {},
    at: new Date().toISOString()
  });
  const temporary = file + ".tmp";
  fs.writeFileSync(temporary, body, "utf8");
  fs.renameSync(temporary, file);
  return file;
}

// Where to start reading a log this pass. A file shorter than the offset was
// replaced rather than appended to, and the honest answer is to read it whole
// again and say so -- these logs are append-only, so it should never happen.
function offsetFor(cursor, name, size) {
  const at = cursor && cursor.offsets ? cursor.offsets[name] : undefined;
  if (at === undefined) return { from: size, fresh: true };
  if (at > size) return { from: 0, shrank: true };
  return { from: at };
}

// --- which records -------------------------------------------------------

// A record with no organisation on it is for everyone: the message stream
// carries plenty that belongs to no single room, and dropping those would hide
// the Director's own questions. A record naming another architect's
// organisation is not this watch's business.
function recordIsMine(record, ids) {
  if (!record) return false;
  if (record.aaoId === undefined || record.aaoId === null || record.aaoId === "") return true;
  const id = Number(record.aaoId);
  if (!Number.isFinite(id)) return true;
  return (ids || []).indexOf(id) !== -1;
}

module.exports = {
  topicsFor,
  resolve,
  cursorPath,
  readCursor,
  writeCursor,
  offsetFor,
  recordIsMine
};
