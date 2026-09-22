// Where snapshots live and which one is good (proposal 92).
//
// scripts/snapshot.js takes them and governance/watch.js calls it; everything
// either of them decides is here, so it can be tested without a chain and
// without writing anywhere real.
//
// The directory is deliberately NOT the OS temp directory. A snapshot is the
// only copy of the record while the chain lives in one process's memory on one
// laptop, and the temp directory is a place the operating system empties.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Keep this many. At one every ten minutes that is about a day and a half of
// history, which is long enough to go back past a bad afternoon.
const KEEP = 200;
const PREFIX = "peoplenet-";
const SUFFIX = ".json";

function directory() {
  if (process.env.PEOPLENET_SNAPSHOT_DIR) {
    return path.resolve(process.env.PEOPLENET_SNAPSHOT_DIR);
  }
  return path.join(os.homedir(), "peoplenet-snapshots");
}

// Sortable by name, so the newest is the last one alphabetically and no clock
// has to be trusted twice.
function nameFor(at) {
  const when = (at instanceof Date ? at : new Date(at || Date.now()))
    .toISOString().replace(/[:.]/g, "-");
  return PREFIX + when + SUFFIX;
}

function isSnapshotName(name) {
  return name.indexOf(PREFIX) === 0 && name.slice(-SUFFIX.length) === SUFFIX;
}

// Oldest first.
function list(dir) {
  const where = dir || directory();
  if (!fs.existsSync(where)) return [];
  return fs.readdirSync(where).filter(isSnapshotName).sort()
    .map((name) => path.join(where, name));
}

function newest(dir) {
  const all = list(dir);
  return all.length ? all[all.length - 1] : null;
}

// What a snapshot is worth comparing on. A file that cannot be read or parsed
// is worth nothing, which is not the same as a file that is small.
function summarise(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || !Array.isArray(data.events) || !data.state) return null;
    return {
      events: data.events.length,
      aaos: Number(data.state.aaoCount) || 0,
      proposals: Array.isArray(data.state.proposals) ? data.state.proposals.length : 0,
      block: Number(data.blockNumber) || 0
    };
  } catch (e) {
    return null;
  }
}

// The newest snapshot that can actually be read. A corrupt newest one must not
// become the thing every later export is measured against.
function newestGood(dir) {
  const all = list(dir);
  for (let i = all.length - 1; i >= 0; i--) {
    const seen = summarise(all[i]);
    if (seen) return { file: all[i], summary: seen };
  }
  return null;
}

// Whether a fresh export may replace the newest good snapshot, in one plain
// line, or null.
//
// The record only ever grows: events are appended and proposals are filed, and
// neither is ever removed. An export with fewer of either is not a newer
// picture of the record, it is a picture of something else -- a chain that was
// redeployed empty, a half-finished read, the wrong node -- and writing it over
// a good snapshot would destroy the only copy of the real one.
function replacementProblem(fresh, previous) {
  if (!fresh) return "the export could not be read";
  if (!previous) return null;
  if (fresh.events < previous.events) {
    return `the export has ${fresh.events} events and the newest snapshot has ` +
      `${previous.events}. The record only grows, so this is not the same chain ` +
      `or not a whole read. Keeping the snapshot.`;
  }
  if (fresh.proposals < previous.proposals) {
    return `the export has ${fresh.proposals} proposals and the newest snapshot ` +
      `has ${previous.proposals}. The record only grows, so this is not the same ` +
      `chain or not a whole read. Keeping the snapshot.`;
  }
  return null;
}

// Written whole through a temporary file and a rename: a reader that arrives
// mid-write must see the old file or the new one, never half of either.
function writeAtomic(file, text) {
  const temporary = file + ".part";
  fs.writeFileSync(temporary, text, "utf8");
  fs.renameSync(temporary, file);
  return file;
}

// Oldest first, so what goes is always the least useful thing there.
function prune(dir, keep) {
  const limit = keep === undefined ? KEEP : keep;
  const all = list(dir);
  const extra = all.length - limit;
  const removed = [];
  for (let i = 0; i < extra; i++) {
    try { fs.unlinkSync(all[i]); removed.push(all[i]); } catch (e) { /* already gone */ }
  }
  return removed;
}

module.exports = {
  KEEP,
  directory,
  nameFor,
  isSnapshotName,
  list,
  newest,
  newestGood,
  summarise,
  replacementProblem,
  writeAtomic,
  prune
};
