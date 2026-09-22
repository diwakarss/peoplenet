// governance/push.js -- the one way a message reaches the Director's phone
// (proposal 99).
//
// The laptop's browser tab does not reach a man who is downstairs. ntfy does:
// he subscribes the free iPhone app to one topic, and a POST to that topic's
// URL rings the phone.
//
// THE TOPIC NAME IS A SECRET, and this file is the whole reason it can be.
// An ntfy topic has no password: anyone who knows its name can read everything
// posted to it and post to it themselves. So:
//
//   - The URL is read from PEOPLENET_NTFY_URL and from nowhere else. It is not
//     in this repository, in any log, in any message, in any test or in any
//     report. `npm run phone` puts it on this laptop's screen and in one file
//     under the user profile, outside the repository.
//   - Nothing here ever prints it. Every line this module returns goes through
//     redact(), which replaces the URL and its host with "<the push topic>" --
//     because a failed fetch names the host it could not reach, and that error
//     would otherwise be copied straight into an incident on the record.
//   - The body carries a title and a proposal number and nothing else. Anyone
//     who guesses the topic learns that proposal 98 came due, not what it says.
//
// Unset is not a failure. The push is skipped, said once, and the two other
// things a due reminder does -- the line on the page and the proposal coming
// back -- still happen.
"use strict";

const ENV_NAME = "PEOPLENET_NTFY_URL";

// What every line about the push calls it. Never the URL.
const TARGET = "<the push topic>";

// The URL, or null when it is not set. Takes an environment so a test can hand
// one in rather than changing the process's own.
function topicUrl(env) {
  const source = env || process.env;
  const value = String(source[ENV_NAME] || "").trim();
  return value || null;
}

function isConfigured(env) {
  return topicUrl(env) !== null;
}

// The line said when the variable is unset. It names the variable and the
// command, and no topic, because there is none to name.
function notConfiguredLine() {
  return (
    "The push was skipped: " + ENV_NAME + " is not set, so there is no phone to " +
    "reach. Run `npm run phone` once on the laptop and follow the three steps. " +
    "The page line and the returned proposal happened as usual."
  );
}

// Take the topic out of any text before anybody reads it. The URL itself, and
// the host on its own, because `fetch` reports "getaddrinfo ENOTFOUND <host>"
// and an incident carrying that line would publish the secret it was written to
// keep.
function redact(text, env) {
  let out = String(text === undefined || text === null ? "" : text);
  const url = topicUrl(env);
  if (!url) return out;

  const pieces = [url];
  try {
    const parsed = new URL(url);
    pieces.push(parsed.host, parsed.hostname, parsed.origin);
    const topic = parsed.pathname.replace(/^\/+|\/+$/g, "");
    if (topic) pieces.push(topic);
  } catch (e) {
    // A malformed URL redacts as a whole string and nothing more.
  }

  pieces
    .filter(Boolean)
    // Longest first, so redacting the host does not leave the path behind.
    .sort((a, b) => b.length - a.length)
    .forEach((piece) => {
      out = out.split(piece).join(TARGET);
    });

  return out;
}

// What the phone shows. A title of a few words and a line naming the proposal.
//
// No proposal text. The reminder's own words live on the page, behind the
// Director's own screen; the phone gets the number and the fact that it is due.
function bodyFor(reminder) {
  const id = reminder && reminder.proposal !== undefined ? reminder.proposal : "?";
  return {
    title: "Reminder due: proposal " + id,
    message: "Proposal " + id + " is due. Open the governance page.",
    tags: "bell"
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One push, retried with backoff. Never throws: a phone that cannot be reached
// must not stop the watcher, which is also executing proposals.
//
//   body     { title, message, tags }
//   options  { env, fetchImpl, attempts, backoffMs, sleep }
//
// Returns { ok, skipped, attempts, status, error } where `error` is already
// redacted and safe to write to the record.
async function send(body, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const url = topicUrl(env);

  if (!url) return { ok: false, skipped: true, attempts: 0, status: null, error: null };

  const doFetch = opts.fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { ok: false, skipped: false, attempts: 0, status: null, error: "no fetch available" };
  }

  const attempts = Number.isInteger(opts.attempts) && opts.attempts > 0 ? opts.attempts : 3;
  const backoffMs = Number.isFinite(opts.backoffMs) ? opts.backoffMs : 2000;
  const sleep = opts.sleep || wait;

  let lastStatus = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          Title: String(body.title || ""),
          Tags: String(body.tags || "bell"),
          "Content-Type": "text/plain; charset=utf-8"
        },
        body: String(body.message || "")
      });
      lastStatus = response && typeof response.status === "number" ? response.status : null;
      if (response && response.ok) {
        return { ok: true, skipped: false, attempts: attempt, status: lastStatus, error: null };
      }
      lastError = "the push topic answered " + lastStatus;
    } catch (e) {
      lastError = redact(e && (e.message || String(e)), env);
    }

    // Backoff doubles, and the last attempt does not wait for a retry that is
    // not coming.
    if (attempt < attempts) await sleep(backoffMs * Math.pow(2, attempt - 1));
  }

  return {
    ok: false,
    skipped: false,
    attempts: attempts,
    status: lastStatus,
    error: redact(lastError, env)
  };
}

module.exports = {
  ENV_NAME,
  TARGET,
  topicUrl,
  isConfigured,
  notConfiguredLine,
  redact,
  bodyFor,
  send
};
