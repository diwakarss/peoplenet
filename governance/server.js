// The governance server: static files for governance/, plus the small set of
// append-only logs the page reads and writes.
//
//   npm run governance   ->   http://127.0.0.1:8787
//
// Node's own http and fs only; no dependency beyond what the repo already has.
// It binds to the loopback address on purpose -- this page drives a local chain
// with unlocked accounts and has no business being reachable from the network.
//
// Endpoints (spec section 27.2, 27.5):
//   GET  /wren-votes.json    Wren's votes with the reason for each
//   GET  /builder-votes.json the builder's, the same shape
//   GET  /widget-votes.json  the widget's; [] until its first vote lands
//   GET  /questions.json    the Director's questions, oldest first
//   GET  /answers.json      Wren's answers
//   POST /questions         file a question (or a request-new-proposal)
//
// Every log is re-read from disk on each request and served no-store: the
// scripts append to these files while the page is open, and a cached copy would
// quietly show the operator a stale thread.
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");
const R = require("./read.js");
const P = require("./protocol.js");

const ROOT = __dirname;
const HOST = process.env.GOVERNANCE_HOST || "127.0.0.1";
const PORT = Number(process.env.GOVERNANCE_PORT || 8787);

// Where the append-only logs live. The default is this directory, unchanged;
// GOVERNANCE_LOG_DIR points it somewhere else so a test has somewhere safe to
// write.
//
// It exists because I did not have one. Testing proposal 90 I posted two
// questions through the live server, which records every question as from the
// Director, and answered one as Wren -- three lines in the real record under
// two other parties' names, in files nothing can edit. This file's own tests
// open with the rule that nothing is tested against live state; the logs are
// live state exactly as the chain is.
const LOG_DIR = process.env.GOVERNANCE_LOG_DIR
  ? path.resolve(process.env.GOVERNANCE_LOG_DIR)
  : ROOT;

// One place that says which log lives where.
const LOGS = {
  "/wren-votes.json": "wren-votes.jsonl",
  "/builder-votes.json": "builder-votes.jsonl",
  "/widget-votes.json": "widget-votes.jsonl",
  "/kural-votes.json": "kural-votes.jsonl",
  "/kalam-votes.json": "kalam-votes.jsonl",
  "/questions.json": "questions.jsonl",
  "/answers.json": "answers.jsonl",
  "/messages.json": "messages.jsonl",
  "/drafts.json": "drafts.jsonl"
};

// Wren's plain-English translations of the legacy proposals (27.10). Served
// read-only and re-read per request, like the logs: Wren edits the file while
// the page is open and the Director should see the new wording at once. The
// page never writes it -- the chain text is what it is, and a translation that
// could be changed from a browser would not be a record.
const TRANSLATIONS_ROUTE = "/translations.json";

const MAX_BODY = 64 * 1024; // a question is a sentence, not a payload

// --- BEGIN proposal 54: an image beside the draft ------------------------
//
// The Director pastes a screenshot into the filing fold and it arrives here as
// base64 inside the ordinary JSON body -- no multipart, no new dependency.
//
// PRIVACY. A screenshot of a ticket can carry a customer's name, an email
// address or a credential. So the file stays on this machine and nowhere else:
// it is written under the log directory, it is NEVER served back (see the deny
// in serveStatic), it is never committed (governance/inbox/ is in .gitignore),
// it never goes on the chain, and it is never embedded in drafts.jsonl -- the
// record holds a pointer and a hash, not the picture. It exists for the one
// architect who completes the draft, and wren-file-draft.js deletes it the
// moment the proposal is filed. Whoever writes that proposal's text must not
// transcribe names, emails or secrets out of the image.
const INBOX_DIR = path.join(LOG_DIR, "inbox");
const INBOX_SEGMENT = "inbox";

// 5 MB of picture, the same number read.js gives the page, so the two cannot
// drift apart. The draft route's body ceiling is the base64 of that plus the
// text around it; every other route keeps the 64 KB above, because a question
// really is a sentence.
const MAX_IMAGE_BYTES = R.IMAGE_LIMIT_BYTES;
const MAX_DRAFT_BODY = 8 * 1024 * 1024;

// What a body over that ceiling is told. It is refused while it is still
// arriving, so this is all that can be said about it -- an image only a little
// over 5 MB still fits the body and gets the exact size back instead.
const TOO_LARGE_LINE = "That is too large to send. An image must be a PNG or a JPEG under 5 MB.";

// An image older than this has outlived the filing it was pasted for.
const IMAGE_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;

// What the bytes actually are. The browser's `type` is the client's claim and
// is never believed: a .exe renamed to .png announces itself as an image just
// as loudly.
const IMAGE_KINDS = [
  { type: "image/png", ext: "png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "image/jpeg", ext: "jpg", magic: [0xff, 0xd8, 0xff] }
];

function sniffImage(buffer) {
  for (const kind of IMAGE_KINDS) {
    if (buffer.length < kind.magic.length) continue;
    if (kind.magic.every((byte, i) => buffer[i] === byte)) return kind;
  }
  return null;
}

// Decode and vet what the page sent. Returns { buffer, kind } or { error }.
function readImageField(field) {
  const raw = typeof field === "string"
    ? field
    : (field && typeof field.base64 === "string" ? field.base64 : null);
  if (raw === null) return { error: "the image must be sent as base64 text" };

  // A data: URL is what the browser hands out, so accept it and keep only the
  // payload.
  const base64 = raw.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!base64) return { error: "the image is empty" };

  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) return { error: "the image is empty" };
  if (buffer.length > MAX_IMAGE_BYTES) {
    return {
      error: `That image is ${R.describeBytes(buffer.length)}. The limit is ` +
        `${R.describeBytes(MAX_IMAGE_BYTES)}, so it was not attached.`
    };
  }

  // The bytes decide, not the client's `type`.
  const kind = sniffImage(buffer);
  if (!kind) return { error: "That is not a PNG or a JPEG, so it was not attached." };
  return { buffer: buffer, kind: kind };
}

// Write it under the log directory, named after the id the SERVER made. The
// client's own file name is dropped on the floor and never stored: it is
// attacker-controlled text, and nothing here needs it.
function storeImage(draftId, image, done) {
  const relative = INBOX_SEGMENT + "/" + draftId + "." + image.kind.ext;
  fs.mkdir(INBOX_DIR, { recursive: true }, (mkErr) => {
    if (mkErr) return done(mkErr);
    fs.writeFile(path.join(LOG_DIR, relative), image.buffer, (writeErr) => {
      if (writeErr) return done(writeErr);
      done(null, {
        path: relative,
        sha256: crypto.createHash("sha256").update(image.buffer).digest("hex"),
        bytes: image.buffer.length,
        type: image.kind.type
      });
    });
  });
}

// Housekeeping (proposal 54): at start and then hourly, anything in the inbox
// older than a day goes. An image is a note to the architect who files the
// draft, not an archive, and the longer one sits on disk the more it is simply
// a screenshot of a ticket nobody is looking at any more.
function sweepInbox(done) {
  const finish = done || function () {};
  fs.readdir(INBOX_DIR, (err, names) => {
    if (err) {
      // No inbox yet is the normal state, not a fault.
      if (err.code !== "ENOENT") console.warn("inbox sweep: " + (err.code || err.message));
      console.log("inbox: 0 image(s) older than 24 hours removed");
      return finish(null, 0);
    }
    const cutoff = Date.now() - IMAGE_TTL_MS;
    let pending = names.length;
    let removed = 0;
    if (!pending) {
      console.log("inbox: 0 image(s) older than 24 hours removed");
      return finish(null, 0);
    }
    const step = () => {
      if (--pending > 0) return;
      console.log(`inbox: ${removed} image(s) older than 24 hours removed`);
      finish(null, removed);
    };
    names.forEach((name) => {
      const file = path.join(INBOX_DIR, name);
      fs.stat(file, (statErr, stat) => {
        if (statErr || !stat.isFile() || stat.mtimeMs >= cutoff) return step();
        fs.unlink(file, (unlinkErr) => {
          if (!unlinkErr) removed++;
          step();
        });
      });
    });
  });
}
// --- END proposal 54 -----------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/plain; charset=utf-8"
};

function send(res, status, body, type) {
  const payload = Buffer.isBuffer(body) ? body : String(body);
  res.writeHead(status, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), MIME[".json"]);
}

// --- logs --------------------------------------------------------------

function logPath(file) {
  return path.join(LOG_DIR, file);
}

// Read one .jsonl log. A file that does not exist yet is an empty log, not an
// error: nobody has asked anything yet.
function readLog(file, done) {
  fs.readFile(logPath(file), "utf8", (err, text) => {
    if (err) {
      if (err.code === "ENOENT") return done(null, []);
      return done(err);
    }
    const { records, skipped } = P.parseJsonl(text);
    if (skipped) console.warn(`${file}: skipped ${skipped} malformed line(s)`);
    done(null, records);
  });
}

function serveLog(res, file) {
  readLog(file, (err, records) => {
    if (err) return send(res, 500, `Cannot read ${file}: ${err.code || err.message}`);
    sendJson(res, 200, records);
  });
}

// Append one record. Append-only on purpose: nothing here ever edits or deletes
// a line, so the file is the record and git can hold it.
function appendLog(file, record, done) {
  fs.appendFile(logPath(file), P.toJsonl(record), "utf8", done);
}

// `max` is the ceiling for this one route; it defaults to MAX_BODY, which is
// what every route but /drafts uses. (proposal 54)
function readBody(req, done, max, tooLarge) {
  const ceiling = max || MAX_BODY;
  let size = 0;
  let chunks = [];
  let finished = false;
  const fail = (message, status, overLimit) => {
    if (finished) return;
    finished = true;
    // Let go of what was buffered before answering, and keep letting go of
    // whatever else arrives. The point of counting as the bytes come in is
    // that an oversized POST never becomes an oversized allocation: past this
    // line the route holds nothing at all, however much more is sent. What
    // does not happen here is cutting the socket -- a connection killed before
    // the refusal has been read hands the sender a network error instead of
    // the sentence explaining what was wrong, and this route's whole job is to
    // say why in plain words. refuseBody closes the connection after the
    // refusal instead.
    chunks = [];
    req.resume();
    done(Object.assign(new Error(message), { status: status || 400, overLimit: !!overLimit }));
  };
  req.on("data", (chunk) => {
    if (finished) return;
    size += chunk.length;
    if (size > ceiling) return fail(tooLarge || "Body too large", 413, true);
    chunks.push(chunk);
  });
  req.on("error", () => fail("Could not read the request body"));
  req.on("end", () => {
    if (finished) return;
    finished = true;
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (e) {
      done(Object.assign(new Error("Body is not valid JSON"), { status: 400 }));
    }
  });
}

// A body refused for its size is answered and the connection then ends
// (proposal 54). The refusal is written straight away, while the rest of the
// body is still on its way and being thrown away unread, and `Connection:
// close` means this socket is finished once that refusal has been delivered.
// The sender gets the sentence, and gets it early; the server is holding none
// of what it sent.
function refuseBody(req, res, err) {
  if (err.overLimit && !res.headersSent) res.setHeader("Connection", "close");
  send(res, err.status || 400, err.message);
}

// --- POST /questions ---------------------------------------------------

// The Director asks something about a proposal, or asks for a new proposal
// altogether. Either way it is one protocol message (27.5) that also carries the
// 27.2 question fields, so the file is readable both as a thread and as the
// agent traffic it is.
// The organisations by id, so a question reaches the right architect
// (proposal 90). Cached briefly: a topic almost never changes, and a chain
// round trip in front of the Director's typing would be felt.
let topicCache = { at: 0, byId: {} };
const TOPIC_TTL = 60 * 1000;

async function topicOf(aaoId) {
  const now = Date.now();
  if (now - topicCache.at > TOPIC_TTL) {
    try {
      const ethers = require("ethers");
      const contract = R.getContract(ethers, R.getProvider(ethers));
      const byId = {};
      (await R.readAAOs(contract)).forEach((aao) => { byId[aao.id] = aao.topic; });
      topicCache = { at: now, byId };
    } catch (e) {
      // The chain is unreachable. Keep whatever was cached and let the caller
      // fall back to the old default: a question that cannot be asked at all is
      // worse than one addressed the way every question was addressed before.
      console.warn("question routing: could not read the organisations -- " + (e.message || e));
    }
  }
  return topicCache.byId[aaoId];
}

function postQuestion(req, res) {
  readBody(req, (err, body) => {
    if (err) return refuseBody(req, res, err);

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return sendJson(res, 400, { ok: false, errors: ["text is required"] });

    const type = body.type === "request-new-proposal" ? "request-new-proposal" : "question";
    const proposal = body.proposal === undefined || body.proposal === null
      ? null
      : Number(body.proposal);
    if (proposal !== null && !Number.isInteger(proposal)) {
      return sendJson(res, 400, { ok: false, errors: ["proposal must be a proposal id"] });
    }

    const now = new Date().toISOString();
    const subject = type === "request-new-proposal"
      ? `A new proposal is wanted for #${proposal}`
      : firstLine(text);
    const aaoId = body.aaoId === undefined ? R.AAO_ID : Number(body.aaoId);

    // Addressed to the architect of the organisation it was asked on. An
    // explicit `to` in the body still wins: that is a caller deliberately
    // naming someone, not the default this proposal replaced.
    topicOf(aaoId).then((topic) => {
    const message = P.normalise({
      // 27.5, the protocol envelope
      from: "director",
      to: body.to || R.questionRouting(R.rulesFor({ topic: topic || "" })).to,
      type: type,
      subject: subject,
      summary: text,
      details: typeof body.details === "string" ? body.details : "",
      refs: Array.isArray(body.refs) ? body.refs : [],
      ts: now,
      // 27.2, the question channel's own fields
      proposal: proposal,
      aaoId: aaoId,
      // The organisation's own name, so wren-answer.js can route this question
      // without reading the chain (proposal 90). Absent on every question
      // written before it, which is why that script still has a fallback.
      topic: topic || undefined,
      text: text,
      at: now
      // The same words asked on two different proposals are two different
      // questions, so the proposal is part of this message's identity and not
      // only of its body. Without this they would share one id, and every
      // answer pointing at it would point at both.
    }, { idFields: ["proposal", "aaoId"] });

    const check = P.validate(message);
    if (!check.ok) return sendJson(res, 400, { ok: false, errors: check.errors });

    appendLog("questions.jsonl", message, (writeErr) => {
      if (writeErr) return send(res, 500, "Could not append to questions.jsonl: " + writeErr.code);
      console.log(`question ${message.id} on proposal ${proposal}, to ${message.to}: ${firstLine(text, 70)}`);
      sendJson(res, 201, { ok: true, question: message });
    });
    }).catch((e) => send(res, 500, "Could not address the question: " + (e.message || e)));
  });
}

// POST /messages -- any agent posts a protocol message (27.5): the widget an
// incident, the builder a status, anyone a decision. Validated by the same
// protocol.js the page and the scripts use; a message without a subject and a
// summary is refused with the reasons, not silently dropped.
function postMessage(req, res) {
  readBody(req, (err, body) => {
    if (err) return refuseBody(req, res, err);

    // Any agent's message, in the shape everyone writes, so it is numbered by
    // the six fields alone -- the same message posted twice is one message.
    const message = P.normalise(body);
    const check = P.validate(message);
    if (!check.ok) return sendJson(res, 400, { ok: false, errors: check.errors });

    appendLog("messages.jsonl", message, (writeErr) => {
      if (writeErr) return send(res, 500, "Could not append to messages.jsonl: " + writeErr.code);
      console.log(`message ${message.id} ${message.from} -> ${message.to} [${message.type}] ${firstLine(message.subject, 70)}`);
      sendJson(res, 201, { ok: true, message: message });
    });
  });
}

// POST /drafts -- the Director files a proposal with one free-text field
// (27.12). No title, no why, no format: the page must not stand between having
// the thought and writing it down. Wren completes it into the 27.1 shape with
// scripts/wren-file-draft.js and puts it on the chain, keeping these words as
// the summary's first sentence.
function postDraft(req, res) {
  readBody(req, (err, body) => {
    if (err) return refuseBody(req, res, err);

    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return sendJson(res, 400, { ok: false, errors: ["text is required"] });

    const draft = {
      id: P.newId("draft"),
      text: text,
      from: "director",
      at: new Date().toISOString(),
      aaoId: body.aaoId === undefined ? R.AAO_ID : Number(body.aaoId),
      state: "awaiting-wren"
    };
    if (!Number.isInteger(draft.aaoId)) {
      return sendJson(res, 400, { ok: false, errors: ["aaoId must be an organisation id"] });
    }

    const done = () => {
      appendLog("drafts.jsonl", draft, (writeErr) => {
        if (writeErr) return send(res, 500, "Could not append to drafts.jsonl: " + writeErr.code);
        console.log(
          `draft ${draft.id} on AAO ${draft.aaoId}: ${firstLine(text, 70)}` +
          (draft.image ? `  [+${draft.image.type} ${draft.image.bytes} bytes]` : "")
        );
        sendJson(res, 201, { ok: true, draft: draft });
      });
    };

    // --- BEGIN proposal 54: one pasted image, beside the words -----------
    // No image is the ordinary case and goes through unchanged.
    if (body.image === undefined || body.image === null || body.image === "") return done();

    const image = readImageField(body.image);
    if (image.error) return sendJson(res, 400, { ok: false, errors: [image.error] });

    // Written first, so a draft is never recorded pointing at a file that is
    // not there. The record gets the pointer and the hash; the bytes stay on
    // disk and never enter drafts.jsonl.
    storeImage(draft.id, image, (storeErr, pointer) => {
      if (storeErr) {
        return send(res, 500, "Could not store the image: " + (storeErr.code || storeErr.message));
      }
      draft.image = pointer;
      done();
    });
    // --- END proposal 54 -------------------------------------------------
  }, MAX_DRAFT_BODY, TOO_LARGE_LINE);
}

function firstLine(text, max) {
  const line = String(text).split(/\r?\n/)[0].trim();
  const limit = max || 100;
  return line.length > limit ? line.slice(0, limit - 1) + "…" : line;
}

// --- routing -----------------------------------------------------------

function serveTranslations(res) {
  fs.readFile(path.join(ROOT, "translations.json"), "utf8", (err, text) => {
    // No file is not an error: the legacy proposals simply show their raw text.
    if (err) return sendJson(res, 200, {});
    try {
      const parsed = JSON.parse(text);
      sendJson(res, 200, parsed && typeof parsed === "object" ? parsed : {});
    } catch (e) {
      console.warn("translations.json is not valid JSON: " + e.message);
      sendJson(res, 200, {});
    }
  });
}

function serveStatic(res, pathname) {
  // --- BEGIN proposal 54: the inbox is not on the web ------------------
  // A pasted screenshot can hold a customer's name or a credential. No route
  // hands one back, so the deny is here, before any path juggling: it is asked
  // of the requested path as it arrives (already percent-decoded by the
  // caller) and again of the resolved file, so neither /inbox/x.png nor
  // /%69nbox/x.png nor /swarm/../inbox/x.png reaches the disk.
  const inboxRoot = path.resolve(INBOX_DIR);
  const asked = path.resolve(ROOT, pathname.replace(/^\/+/, ""));
  if (/^\/+inbox(\/|$)/i.test(pathname) ||
      asked === inboxRoot || asked.startsWith(inboxRoot + path.sep)) {
    return send(res, 403, "Forbidden");
  }
  // --- END proposal 54 --------------------------------------------------

  // A directory is the page inside it, not a listing: /swarm and
  // /swarm/samples/ are both somewhere to look, and there is no listing here to
  // fall back on. Resolved before the path is made relative, so the guard below
  // still sees the whole path.
  if (/\/$/.test(pathname)) pathname += "index.html";
  else if (!path.extname(pathname)) pathname += "/index.html";
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(ROOT, relative);

  // Refuse anything that climbs out of governance/.
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    return send(res, 403, "Forbidden");
  }

  fs.readFile(target, (err, data) => {
    if (err) return send(res, 404, "Not found: " + relative);
    send(res, 200, data, MIME[path.extname(target).toLowerCase()] || "application/octet-stream");
  });
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(url.parse(req.url).pathname);

  if (req.method === "POST") {
    if (pathname === "/questions") return postQuestion(req, res);
    if (pathname === "/messages") return postMessage(req, res);
    if (pathname === "/drafts") return postDraft(req, res);
    return send(res, 404, "No such endpoint: POST " + pathname);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "Method not allowed");
  }

  if (LOGS[pathname]) return serveLog(res, LOGS[pathname]);
  if (pathname === TRANSLATIONS_ROUTE) return serveTranslations(res);

  return serveStatic(res, pathname);
});

server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`;
  console.log(`governance page  ${base}`);
  console.log(`serving          ${ROOT}`);
  console.log(`chain            ${R.RPC_URL} (chain id ${R.CHAIN_ID})`);
  console.log("");
  console.log("logs, re-read on every request:");
  Object.keys(LOGS).forEach((route) => {
    console.log(`  GET  ${base}${route}`.padEnd(48) + LOGS[route]);
  });
  console.log(`  POST ${base}/questions`.padEnd(48) + "questions.jsonl  <- the Director asks");
  console.log(`  POST ${base}/messages`.padEnd(48) + "messages.jsonl   <- any agent, 27.5 shape");
  console.log(`  POST ${base}/drafts`.padEnd(48) + "drafts.jsonl     <- one field, Wren completes it");
  console.log(`  GET  ${base}${TRANSLATIONS_ROUTE}`.padEnd(48) + "translations.json  read-only");
  console.log("");
  if (LOG_DIR !== ROOT) console.log(`logs            ${LOG_DIR}  (GOVERNANCE_LOG_DIR)`);

  // --- BEGIN proposal 54: sweep the inbox ------------------------------
  // Once now, then hourly. unref'd so this timer is never the reason the
  // process is still alive.
  sweepInbox();
  const sweeper = setInterval(sweepInbox, SWEEP_EVERY_MS);
  if (typeof sweeper.unref === "function") sweeper.unref();
  // --- END proposal 54 --------------------------------------------------

  console.log("Ctrl-C to stop.");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Set GOVERNANCE_PORT to pick another.`);
    process.exit(1);
  }
  throw err;
});

// --- the trigger watcher (27.12) ---------------------------------------

// The watcher runs with the server, so "npm run governance" starts both. It
// reads the chain for proposals that carry a trigger and evaluates the rules
// every five minutes; when one fires it appends a status message, which the
// page picks up on its two-second poll.
//
// Set GOVERNANCE_NO_WATCH=1 to serve the page without it.
if (!process.env.GOVERNANCE_NO_WATCH) {
  try {
    const ethers = require("ethers");
    const watch = require("./watch.js");

    const provider = R.getProvider(ethers);
    const contract = R.getContract(ethers, provider);

    const readProposals = async () => {
      const aaos = await R.readAAOs(contract);
      return R.readAllProposals(contract, aaos);
    };

    watch.start(readProposals, {
      ethers: ethers,
      readAaos: () => R.readAAOs(contract),
      // Signs through the node's own unlocked accounts, as the page does.
      // No key is held here either.
      signerFor: (address) => provider.getSigner(address),
      // Chain time for the execution window, so the votes' block timestamps and
      // the clock they are measured against come from the same place.
      latestBlock: () => provider.getBlock("latest")
    });
    console.log(
      "watching         triggers and decided proposals, every " +
      `${watch.DEFAULTS.intervalMs / 60000} minutes`
    );
  } catch (e) {
    // A watcher that cannot start must not take the page down with it.
    console.warn("watch: not started -- " + (e.message || e));
  }
}
