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
//   GET  /wren-votes.json   Wren's votes with the reason for each
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

// One place that says which log lives where.
const LOGS = {
  "/wren-votes.json": "wren-votes.jsonl",
  "/questions.json": "questions.jsonl",
  "/answers.json": "answers.jsonl",
  "/messages.json": "messages.jsonl"
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
  return path.join(ROOT, file);
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

    const message = P.normalise({
      // 27.5, the protocol envelope
      from: "director",
      to: body.to || "wren",
      type: type,
      subject: subject,
      summary: text,
      details: typeof body.details === "string" ? body.details : "",
      refs: Array.isArray(body.refs) ? body.refs : [],
      ts: now,
      // 27.2, the question channel's own fields
      proposal: proposal,
      aaoId: body.aaoId === undefined ? R.AAO_ID : Number(body.aaoId),
      text: text,
      at: now
    }, { idPrefix: type === "request-new-proposal" ? "req" : "q" });

    const check = P.validate(message);
    if (!check.ok) return sendJson(res, 400, { ok: false, errors: check.errors });

    appendLog("questions.jsonl", message, (writeErr) => {
      if (writeErr) return send(res, 500, "Could not append to questions.jsonl: " + writeErr.code);
      console.log(`question ${message.id} on proposal ${proposal}: ${firstLine(text, 70)}`);
      sendJson(res, 201, { ok: true, question: message });
    });
  });
}

// POST /messages -- any agent posts a protocol message (27.5): the widget an
// incident, the builder a status, anyone a decision. Validated by the same
// protocol.js the page and the scripts use; a message without a subject and a
// summary is refused with the reasons, not silently dropped.
function postMessage(req, res) {
  readBody(req, (err, body) => {
    if (err) return send(res, err.status || 400, err.message);

    const message = P.normalise(body, { idPrefix: body && body.type ? body.type : "msg" });
    const check = P.validate(message);
    if (!check.ok) return sendJson(res, 400, { ok: false, errors: check.errors });

    appendLog("messages.jsonl", message, (writeErr) => {
      if (writeErr) return send(res, 500, "Could not append to messages.jsonl: " + writeErr.code);
      console.log(`message ${message.id} ${message.from} -> ${message.to} [${message.type}] ${firstLine(message.subject, 70)}`);
      sendJson(res, 201, { ok: true, message: message });
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
  console.log(`  GET  ${base}${TRANSLATIONS_ROUTE}`.padEnd(48) + "translations.json  read-only");
  console.log("");
  console.log("Ctrl-C to stop.");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Set GOVERNANCE_PORT to pick another.`);
    process.exit(1);
  }
  throw err;
});
