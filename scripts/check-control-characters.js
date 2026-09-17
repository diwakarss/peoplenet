// Refuse any tracked source file carrying a raw control character.
//
// This is not hygiene. Twice, an edit made through a shell heredoc lost the
// backslashes in a regex and left literal backspace bytes (0x08) in the file:
// /\b(?:var|let|const)\s+dryRun\b/ became /<BS>(?:var|let|const)s+dryRun<BS>/,
// which still parses, still runs, and quietly matches nothing. Both times the
// broken guard let a real vote reach the chain with a meaningless reason on it,
// and one member, one vote means neither could be taken back.
//
// So: no tracked source file may contain a character in
// [\x00-\x08\x0b\x0c\x0e-\x1f]. Tab, newline and carriage return are the only
// control characters a source file has any business holding.
//
// Usage:
//   node scripts/check-control-characters.js            # every tracked source
//   node scripts/check-control-characters.js --staged   # what is about to commit
//   node scripts/check-control-characters.js a.js b.js  # named files
//
// Runs from the pre-commit hook in .githooks, and again from
// governance/check.js, so it still runs for anyone who has not installed it.
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Tab (09), newline (0A) and carriage return (0D) are allowed; nothing else.
//
// Built from code points rather than written as a literal character class. A
// literal one would itself contain the bytes it is looking for -- and an
// editor, a heredoc or a paste that mangled them would leave a checker that
// reads fine and catches nothing. That is the exact failure this file exists
// to stop, so it must not be possible here.
const ALLOWED = [0x09, 0x0a, 0x0d];
const FORBIDDEN_CODES = [];
for (let code = 0x00; code <= 0x1f; code++) {
  if (ALLOWED.indexOf(code) === -1) FORBIDDEN_CODES.push(code);
}

function forbidden() {
  return new RegExp(
    "[" + FORBIDDEN_CODES.map(function (c) {
      return "\\u" + c.toString(16).padStart(4, "0");
    }).join("") + "]",
    "g"
  );
}

const SOURCE = /\.(js|mjs|cjs|sol|json|jsonl|md|css|html|ts|yml|yaml)$/i;

// Directories whose contents are not ours to police.
const SKIP = ["node_modules", ".git", "artifacts", "cache", "typechain-types", "coverage", ".next"];

function gitFiles(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    return null;
  }
}

function listFiles(mode, named) {
  if (named.length) return named;
  if (mode === "staged") {
    return gitFiles(["diff", "--cached", "--name-only", "--diff-filter=ACM"]) || [];
  }
  const tracked = gitFiles(["ls-files"]);
  if (tracked) return tracked;

  // No git: walk the source directories instead, so the check still runs.
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.indexOf(entry.name) !== -1) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
    }
  })(process.cwd());
  return out;
}

// Where in the file, so the report names a line rather than a byte offset.
function offences(text) {
  const found = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const hits = line.match(forbidden());
    if (!hits) return;
    found.push({
      line: i + 1,
      count: hits.length,
      codes: hits.map((c) => "0x" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .filter((v, j, a) => a.indexOf(v) === j)
        .join(", "),
      excerpt: line.replace(forbidden(), "<CTRL>").trim().slice(0, 90)
    });
  });
  return found;
}

function run(options) {
  const opts = options || {};
  const named = (opts.files || []).filter((f) => !f.startsWith("--"));
  const files = listFiles(opts.mode, named).filter((f) => SOURCE.test(f));

  const bad = [];
  let scanned = 0;
  for (const file of files) {
    if (SKIP.some((s) => file.split("/").indexOf(s) !== -1)) continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      continue;   // deleted between listing and reading, or not readable as text
    }
    scanned++;
    const found = offences(text);
    if (found.length) bad.push({ file, found });
  }
  return { scanned, bad };
}

function report(result) {
  const lines = [];
  for (const { file, found } of result.bad) {
    for (const o of found) {
      lines.push(`${file}:${o.line}  ${o.count} control character(s) (${o.codes})`);
      lines.push(`    ${o.excerpt}`);
    }
  }
  return lines.join("\n");
}

module.exports = { run, report, offences, forbidden, FORBIDDEN_CODES };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const mode = argv.indexOf("--staged") !== -1 ? "staged" : "all";
  const result = run({ mode, files: argv });

  if (!result.bad.length) {
    console.log(`${result.scanned} source file(s) scanned, no control characters.`);
    process.exit(0);
  }

  console.error("Control characters in tracked source. This is how two votes were lost:");
  console.error("a heredoc ate the backslashes in a regex and left raw bytes behind, and the");
  console.error("guard it broke still parsed and still ran.\n");
  console.error(report(result));
  console.error("\nRemove them and commit again.");
  process.exit(1);
}
