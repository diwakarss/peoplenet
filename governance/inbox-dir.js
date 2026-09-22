// governance/inbox-dir.js -- where a pasted screenshot may be written.
//
// Proposal 91 asks for one thing proposal 54 did not spell out: the directory
// holding a pasted image is OUTSIDE the repository, and a directory inside it
// is refused. `.gitignore` already keeps `governance/inbox/` out of a commit,
// but an ignore rule is a line anyone can delete, and what it guards is a
// screenshot of a ticket carrying a customer's name or a credential. A default
// that cannot reach git beats a rule every future edit has to remember -- the
// same reasoning that made snapshots opt-in.
//
// The server writes the file and scripts/wren-file-draft.js deletes it, so
// both ask this one function rather than each computing a path. Node only:
// read.js loads in the browser and cannot hold this.
"use strict";

const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");

// Under the user profile. `inbox` is appended by the caller, as it always was,
// so a draft's stored `image.path` ("inbox/<draft id>.png") is unchanged and
// every record written before this still resolves.
const DEFAULT_ROOT = path.join(os.homedir(), ".peoplenet");

// Inside means stays inside: "..\\repo" resolves out, and a string prefix test
// alone would let it through.
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// The directory the `inbox` folder sits in, which variable named it, and the
// sentence to print when what was asked for could not be used.
//
// GOVERNANCE_INBOX_DIR moves the images alone; GOVERNANCE_LOG_DIR moves them
// with the logs, which is what the checks rely on. Either is honoured only
// while it points outside the repository.
function inboxRoot(env) {
  const e = env || process.env;
  const asked = e.GOVERNANCE_INBOX_DIR || e.GOVERNANCE_LOG_DIR;
  const from = e.GOVERNANCE_INBOX_DIR ? "GOVERNANCE_INBOX_DIR" : "GOVERNANCE_LOG_DIR";

  if (!asked) return { root: DEFAULT_ROOT, from: "the default", refused: null };

  const root = path.resolve(asked);
  if (isInside(REPO, root)) {
    return {
      root: DEFAULT_ROOT,
      from: "the default",
      refused: `${from} points inside the repository (${root}). A pasted screenshot ` +
        `must not be able to reach a commit, so images are kept in ${DEFAULT_ROOT} instead.`
    };
  }
  return { root: root, from: from, refused: null };
}

module.exports = { REPO, DEFAULT_ROOT, isInside, inboxRoot };
