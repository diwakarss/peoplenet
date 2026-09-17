// A static file server for governance/, and nothing else.
//
//   npm run governance   ->   http://127.0.0.1:8787
//
// Node's own http and fs only; no dependency beyond what the repo already has.
// It binds to the loopback address on purpose -- this page drives a local chain
// with unlocked accounts and has no business being reachable from the network.
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const ROOT = __dirname;
const HOST = process.env.GOVERNANCE_HOST || "127.0.0.1";
const PORT = Number(process.env.GOVERNANCE_PORT || 8787);

const TYPES = {
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
  res.writeHead(status, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    // The page reads a live chain; never let a stale copy hide a new block.
    "Cache-Control": "no-store"
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "Method not allowed");
  }

  const pathname = decodeURIComponent(url.parse(req.url).pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(ROOT, relative);

  // Refuse anything that climbs out of governance/.
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    return send(res, 403, "Forbidden");
  }

  fs.readFile(target, (err, data) => {
    if (err) return send(res, 404, "Not found: " + relative);
    send(res, 200, data, TYPES[path.extname(target).toLowerCase()] || "application/octet-stream");
  });
});

server.listen(PORT, HOST, () => {
  console.log(`governance page: http://${HOST}:${PORT}`);
  console.log(`serving          ${ROOT}`);
  console.log(`chain            http://127.0.0.1:8545 (chain id 31337)`);
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
