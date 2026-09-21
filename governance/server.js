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

function readBody(req, done) {
  let size = 0;
  const chunks = [];
  let finished = false;
  const fail = (message, status) => {
    if (finished) return;
    finished = true;
    done(Object.assign(new Error(message), { status: status || 400 }));
  };
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) return fail("Body too large", 413);
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
    if (err) return send(res, err.status || 400, err.message);

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
    if (err) return send(res, err.status || 400, err.message);

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
    if (err) return send(res, err.status || 400, err.message);

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

    appendLog("drafts.jsonl", draft, (writeErr) => {
      if (writeErr) return send(res, 500, "Could not append to drafts.jsonl: " + writeErr.code);
      console.log(`draft ${draft.id} on AAO ${draft.aaoId}: ${firstLine(text, 70)}`);
      sendJson(res, 201, { ok: true, draft: draft });
    });
  });
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
      // The server is the only thing that writes snapshots (proposal 92): the
      // record lives in this node's memory until the move to the cloud.
      snapshot: true,
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
