// npm run phone -- the Director's two minutes, once (proposal 99).
//
// Reminders reach the phone through ntfy: a free app, one topic, no account.
// This generates the topic if there is none, keeps it in one file under the
// user profile OUTSIDE this repository, and prints the three steps.
//
// THE TOPIC NAME IS A SECRET. An ntfy topic has no password: anyone who knows
// its name can read it and post to it. So it lives in exactly two places -- the
// file under the home directory, and the PEOPLENET_NTFY_URL environment
// variable that governance/push.js reads -- and it is printed on this laptop's
// screen and nowhere else. It is not in this repository, in a message, in a log
// line, in a test or in a report, and nothing here writes it to any of those.
//
// Usage:
//   npm run phone              set it up, or show what is already set up
//   npm run phone -- --test    send one push, to prove the phone rings
//   npm run phone -- --new     replace the topic with a fresh one
//
// Printing the topic is the whole job here, so this script does not rehearse.
// It writes one file in the user's own home directory and sends nothing to the
// chain, the record or any log.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PUSH = require("../governance/push.js");

// Outside the repository, under the profile, hidden. Not in the project, not in
// git, and not somewhere a tool that sweeps the working tree will find it.
//
// PEOPLENET_PHONE_STORE points it elsewhere, for the same reason
// GOVERNANCE_LOG_DIR exists: a test that ran this script would otherwise
// generate a topic into the Director's own home directory, and a default that
// cannot hurt beats a rule every future test has to remember.
const STORE = process.env.PEOPLENET_PHONE_STORE
  ? path.resolve(process.env.PEOPLENET_PHONE_STORE)
  : path.join(os.homedir(), ".peoplenet-ntfy-url");

const HOST = "https://ntfy.sh";

// Long enough that guessing it is not a strategy. 160 bits of randomness in
// base32, which is what ntfy topic names may hold.
function newTopic() {
  const bytes = crypto.randomBytes(20);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "peoplenet-";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

// The note that goes in the file beside the URL, so the file explains itself to
// whoever opens it in six months.
function fileContents(url) {
  return [
    "# PeopleNet: the topic your reminders are pushed to (proposal 99).",
    "#",
    "# This is a secret. An ntfy topic has no password, so anyone who knows this",
    "# name can read your reminders and post to them. It is deliberately not in",
    "# the repository, and nothing commits it, logs it or puts it in a message.",
    "#",
    "# The governance watcher reads it from the environment, not from this file.",
    "# Set it for every session:",
    "#",
    "#   PowerShell, permanently for your user:",
    "#     setx PEOPLENET_NTFY_URL \"<the line below>\"",
    "#",
    "#   This session only:",
    "#     $env:PEOPLENET_NTFY_URL = \"<the line below>\"",
    "#",
    url,
    ""
  ].join("\n");
}

// The URL out of the store file: the first line that is not a comment.
function storedUrl() {
  if (!fs.existsSync(STORE)) return null;
  const lines = fs.readFileSync(STORE, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const text = line.trim();
    if (text && !text.startsWith("#")) return text;
  }
  return null;
}

function save(url) {
  fs.writeFileSync(STORE, fileContents(url), "utf8");
  // Readable by this user only, on the platforms that honour it.
  try { fs.chmodSync(STORE, 0o600); } catch (e) { /* Windows says no, and that is fine */ }
}

function steps(url) {
  const topic = url.slice(url.lastIndexOf("/") + 1);
  return [
    "",
    "Three steps, once, about two minutes:",
    "",
    "  1. On the iPhone, install ntfy from the App Store. It is free and needs no account.",
    "  2. Open it, tap +, and subscribe to this topic:",
    "",
    "       " + topic,
    "",
    "     Or open this link on the phone and tap Subscribe:",
    "",
    "       " + url,
    "",
    "  3. Back here, set the variable so the watcher can reach it, then restart",
    "     the governance server:",
    "",
    "       setx " + PUSH.ENV_NAME + " \"" + url + "\"",
    "",
    "Keep the topic name to yourself. Anyone who knows it can read your reminders.",
    ""
  ].join("\n");
}

async function test(url) {
  const result = await PUSH.send(
    { title: "PeopleNet", message: "This is the test push. Your reminders will arrive here.", tags: "bell" },
    { env: { [PUSH.ENV_NAME]: url }, attempts: 2, backoffMs: 500 }
  );
  if (result.ok) {
    console.log("Sent. The phone should have buzzed.");
    return 0;
  }
  console.error("The push did not go through: " + (result.error || "no reason reported"));
  console.error("Check the phone is subscribed and this laptop is online, then try again.");
  return 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const wantsNew = argv.includes("--new");
  const wantsTest = argv.includes("--test");

  let url = wantsNew ? null : (PUSH.topicUrl() || storedUrl());
  let created = false;

  if (!url) {
    url = HOST + "/" + newTopic();
    created = true;
  }

  save(url);

  console.log("");
  console.log(created ? "A new topic was generated for you." : "Your topic is already set up.");
  console.log("Kept in  " + STORE);
  console.log("");
  console.log("Your topic URL, shown on this screen only:");
  console.log("");
  console.log("    " + url);
  console.log(steps(url));

  if (!PUSH.topicUrl()) {
    console.log(PUSH.ENV_NAME + " is not set in this session yet, so the watcher cannot");
    console.log("push anything. Set it with the line in step 3, then restart the server.");
    console.log("");
  }

  if (wantsTest) process.exit(await test(url));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
