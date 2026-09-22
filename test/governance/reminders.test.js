// A reminder is not a proposal (proposal 99).
//
// Nothing here touches the live record. The reminders log and the message log
// are both written to a throwaway directory made per test, and the push goes to
// a stub HTTP server this file starts on an ephemeral loopback port and closes
// itself -- never to the real ntfy, and never to a topic read from this
// machine's environment.
//
// THE TOPIC IS NOT IN THIS FILE. Every test that needs one invents one, and the
// last test in this file asserts that no file in the repository carries a real
// topic name.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const P = require("../../governance/protocol.js");
const R = require("../../governance/read.js");
const RM = require("../../governance/reminders.js");
const PUSH = require("../../governance/push.js");
const W = require("../../governance/watch.js");

const REPO = path.join(__dirname, "..", "..");

// A topic invented here, so nothing in this file is the real one.
const FAKE_TOPIC = "peoplenet-testonlytopicnamenotreal";

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "peoplenet-reminders-"));
}

function reminder(over) {
  return Object.assign({
    id: "remind-test-1",
    proposal: 98,
    aaoId: 2,
    due: "2026-09-28T03:30:00Z",
    text: "The Mac and the four chat exports.",
    set_by: "kural",
    state: "set",
    at: "2026-09-21T05:00:00.000Z"
  }, over || {});
}

function proposal(over) {
  return Object.assign({ id: 98, aaoId: 2, status: 0, format: { doc: {} } }, over || {});
}

describe("a reminder is not a proposal", function () {

  describe("the record and its four states", function () {
    it("refuses a reminder that is missing any part of itself", function () {
      const bare = RM.validate({});
      expect(bare.ok).to.equal(false);
      ["id", "proposal", "aaoId", "due", "text", "set_by", "state"].forEach((field) => {
        expect(bare.errors.join(" "), `nothing said about ${field}`).to.contain(field);
      });
    });

    it("refuses a due date that is not a date, and a state nobody named", function () {
      expect(RM.validate(reminder({ due: "next Thursday" })).ok).to.equal(false);
      expect(RM.validate(reminder({ state: "pending" })).ok).to.equal(false);
      expect(RM.validate(reminder()).ok).to.equal(true);
    });

    it("takes the last line for an id, because the file is append-only", function () {
      const log = [
        reminder({ due: "2026-09-28T03:30:00Z", state: "set" }),
        reminder({ due: "2026-10-05T03:30:00Z", state: "set" })
      ];
      const now = RM.latest(log)["remind-test-1"];
      expect(now.due).to.equal("2026-10-05T03:30:00Z");
      expect(RM.current(log)).to.have.length(1);
      expect(RM.historyFor(log, "remind-test-1")).to.have.length(2);
    });

    it("orders by the file and not by the clock, so a clock that went backwards cannot undo a cancellation", function () {
      const log = [
        reminder({ state: "set", at: "2026-09-21T05:00:00.000Z" }),
        reminder({ state: "cancelled", at: "2026-09-20T05:00:00.000Z" })
      ];
      expect(RM.latest(log)["remind-test-1"].state).to.equal("cancelled");
    });
  });

  describe("when a reminder is due", function () {
    it("is due on its date and not before", function () {
      const r = reminder();
      expect(RM.isDue(r, "2026-09-27T23:59:00Z")).to.equal(false);
      expect(RM.isDue(r, "2026-09-28T03:30:00Z")).to.equal(true);
      expect(RM.isDue(r, "2026-10-01T00:00:00Z")).to.equal(true);
    });

    it("is never due once it is fired, cancelled or moved", function () {
      ["fired", "cancelled", "moved"].forEach((state) => {
        expect(RM.isDue(reminder({ state: state }), "2026-10-01T00:00:00Z"), state).to.equal(false);
      });
    });

    it("delivers a backlog oldest first", function () {
      const log = [
        reminder({ id: "a", due: "2026-10-05T03:30:00Z" }),
        reminder({ id: "b", due: "2026-09-28T03:30:00Z" })
      ];
      expect(RM.due(log, "2026-10-06T00:00:00Z").map((r) => r.id)).to.deep.equal(["b", "a"]);
    });
  });

  describe("who may set one", function () {
    it("is the organisation's architect, and nobody else", function () {
      const jd = R.rulesFor({ topic: "JD" });
      expect(R.reminderProblem(jd, "kural", { topic: "JD" })).to.equal(null);
      expect(R.reminderProblem(jd, "kalam", { topic: "JD" })).to.contain("Kural");
      expect(R.reminderProblem(jd, "director", { topic: "JD" })).to.contain("Kural");
    });

    it("is the same rule on every organisation that names an architect", function () {
      expect(R.reminderProblem(R.rulesFor({ topic: "trilogy widget" }), "wren")).to.equal(null);
      expect(R.reminderProblem(R.rulesFor({ topic: "trilogy widget" }), "kural")).to.contain("Wren");
      expect(R.reminderProblem(R.rulesFor({ topic: "JD-build" }), "kural")).to.equal(null);
    });

    it("leaves an organisation that names no architect exactly as it was", function () {
      expect(R.reminderProblem(R.DEFAULT_RULES, "anyone")).to.equal(null);
    });
  });

  // The trap the second generation's ledger names: when a sender gains a second
  // kind of message, go and read everything that matches on the sender. "watch"
  // now writes three, and two functions asking the same question of them would
  // disagree on exactly the proposals that matter.
  describe("three kinds of message from one sender", function () {
    const trigger = { from: "watch", proposal: 61, type: "status", subject: "s", summary: "s" };
    const unclaimed = { from: "watch", proposal: 61, unclaimed: true, type: "status", subject: "s", summary: "s" };
    const fired = { from: "watch", proposal: 61, reminder: "remind-x", type: "status", subject: "s", summary: "s" };

    it("counts a fired reminder as something the Director was waiting for", function () {
      expect(R.triggerHasFired([fired], 61)).to.not.equal(null);
      expect(R.triggerHasFired([unclaimed], 61)).to.equal(null);
      expect(R.triggerHasFired([trigger], 61)).to.not.equal(null);
    });

    it("does not let a fired reminder silence that proposal's real trigger", function () {
      expect(R.triggerReported([fired], 61), "a reminder was read as a trigger report").to.equal(null);
      expect(R.triggerReported([unclaimed], 61)).to.equal(null);
      expect(R.triggerReported([trigger], 61)).to.not.equal(null);
      expect(W.alreadyFired([fired], 61)).to.equal(false);
      expect(W.alreadyFired([trigger], 61)).to.equal(true);
    });

    it("brings a waiting proposal back into the vote list when its reminder fires", function () {
      const p = proposal({ id: 61, status: 0 });
      const waiting = R.viewFor(p, null, {}, { has: true, fired: false });
      const back = R.viewFor(p, null, {}, { has: true, fired: true });
      expect(waiting).to.equal("waiting");
      expect(back).to.equal("vote");
    });
  });

  describe("a reminder on a closed proposal", function () {
    const closedDecision = {
      from: "kalam", type: "decision", proposal: 98, aaoId: 2,
      subject: "Proposal 98: closed",
      summary: "closed: superseded by proposal 100."
    };

    it("does not fire", function () {
      const why = W.reminderSkipBecause(reminder(), proposal(), [closedDecision]);
      expect(why).to.equal("closed");
    });

    it("does not fire when the chain has stopped it being Active either", function () {
      expect(W.reminderSkipBecause(reminder(), proposal({ status: 1 }), [])).to.equal("closed");
    });

    // The migration depends on this one. 94 and 98 are closed BY the reminders
    // that replaced them; if closed alone were the test, the only two reminders
    // the migration exists to preserve would be the only two that could never
    // fire, and nobody would find out until the phone stayed quiet.
    it("fires when the proposal was closed by this very reminder", function () {
      const superseded = {
        from: "kalam", type: "decision", proposal: 98, aaoId: 2,
        subject: "Proposal 98: closed",
        summary: "closed: superseded by reminder remind-test-1."
      };
      expect(W.reminderSkipBecause(reminder(), proposal(), [superseded])).to.equal(null);
    });

    it("fires on a proposal the chain has never heard of", function () {
      expect(W.reminderSkipBecause(reminder(), null, [])).to.equal(null);
    });
  });

  describe("the push, against a stub that is never ntfy", function () {
    let server, url, received;

    beforeEach(function (done) {
      received = [];
      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          received.push({ url: req.url, title: req.headers.title, body: body });
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
        });
      });
      // Port 0: the operating system picks one nobody is using, so this cannot
      // collide with the governance server or with anything else on the laptop.
      server.listen(0, "127.0.0.1", () => {
        url = `http://127.0.0.1:${server.address().port}/${FAKE_TOPIC}`;
        done();
      });
    });

    afterEach(function (done) { server.close(() => done()); });

    it("is skipped, and said so, when the variable is unset", async function () {
      const result = await PUSH.send({ title: "t", message: "m" }, { env: {} });
      expect(result.skipped).to.equal(true);
      expect(result.ok).to.equal(false);
      expect(PUSH.notConfiguredLine()).to.contain(PUSH.ENV_NAME);
      expect(PUSH.notConfiguredLine()).to.contain("npm run phone");
    });

    it("carries the proposal number and no proposal text", async function () {
      const body = PUSH.bodyFor(reminder({ text: "The Mac and the four chat exports." }));
      expect(body.title).to.contain("98");
      expect(JSON.stringify(body)).to.not.contain("Mac");
      await PUSH.send(body, { env: { [PUSH.ENV_NAME]: url } });
      expect(received).to.have.length(1);
      expect(received[0].body).to.contain("98");
      expect(received[0].body).to.not.contain("Mac");
    });

    it("retries with backoff and gives up after the last attempt", async function () {
      const waits = [];
      let calls = 0;
      const result = await PUSH.send({ title: "t", message: "m" }, {
        env: { [PUSH.ENV_NAME]: url },
        fetchImpl: async () => { calls++; throw new Error("connect ECONNREFUSED " + FAKE_TOPIC); },
        attempts: 3,
        backoffMs: 10,
        sleep: async (ms) => { waits.push(ms); }
      });
      expect(calls).to.equal(3);
      expect(waits).to.deep.equal([10, 20]);
      expect(result.ok).to.equal(false);
      expect(result.attempts).to.equal(3);
    });

    it("never lets the topic out, not even through the error it reports", async function () {
      const env = { [PUSH.ENV_NAME]: url };
      const result = await PUSH.send({ title: "t", message: "m" }, {
        env: env,
        fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND " + url); },
        attempts: 1
      });
      expect(result.error).to.not.contain(FAKE_TOPIC);
      expect(result.error).to.not.contain("127.0.0.1");
      expect(result.error).to.contain(PUSH.TARGET);
      expect(PUSH.redact("posted to " + url, env)).to.not.contain(FAKE_TOPIC);
      expect(PUSH.redact("the topic " + FAKE_TOPIC + " is down", env)).to.not.contain(FAKE_TOPIC);
    });

    it("reports a server that answers badly without naming it", async function () {
      const result = await PUSH.send({ title: "t", message: "m" }, {
        env: { [PUSH.ENV_NAME]: url },
        fetchImpl: async () => ({ ok: false, status: 404 }),
        attempts: 1
      });
      expect(result.ok).to.equal(false);
      expect(result.error).to.contain("404");
      expect(result.error).to.not.contain(FAKE_TOPIC);
    });
  });

  describe("the watcher firing a due reminder", function () {
    let dir, messagesFile, remindersFile, server, url, received;

    beforeEach(function (done) {
      dir = scratch();
      messagesFile = path.join(dir, "messages.jsonl");
      remindersFile = path.join(dir, "reminders.jsonl");
      received = [];
      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => { received.push(body); res.writeHead(200); res.end("ok"); });
      });
      server.listen(0, "127.0.0.1", () => {
        url = `http://127.0.0.1:${server.address().port}/${FAKE_TOPIC}`;
        done();
      });
    });

    afterEach(function (done) {
      fs.rmSync(dir, { recursive: true, force: true });
      server.close(() => done());
    });

    function options(over) {
      return Object.assign({
        messagesFile, remindersFile,
        env: { [PUSH.ENV_NAME]: url },
        now: "2026-09-29T00:00:00Z",
        pushAttempts: 1
      }, over || {});
    }

    function put(records) {
      fs.writeFileSync(remindersFile, records.map((r) => P.toJsonl(r)).join(""), "utf8");
    }

    function messages() {
      if (!fs.existsSync(messagesFile)) return [];
      return P.parseJsonl(fs.readFileSync(messagesFile, "utf8")).records;
    }

    function reminders() {
      if (!fs.existsSync(remindersFile)) return [];
      return P.parseJsonl(fs.readFileSync(remindersFile, "utf8")).records;
    }

    it("does the three things, and the record says it did", async function () {
      put([reminder()]);
      const result = await W.runReminders([proposal()], options());

      expect(result.fired).to.have.length(1);
      expect(result.fired[0].pushed, "the push did not go through").to.equal(true);

      // 1. the phone
      expect(received).to.have.length(1);
      expect(received[0]).to.contain("98");

      // 2. the line on the page
      const posted = messages().filter((m) => m.from === "watch" && m.reminder === "remind-test-1");
      expect(posted).to.have.length(1);
      expect(posted[0].type).to.equal("status");
      expect(posted[0].proposal).to.equal(98);
      expect(posted[0].summary).to.contain("The Mac");

      // 3. the proposal comes back into the vote list
      expect(R.triggerHasFired(messages(), 98)).to.not.equal(null);

      // and the reminder is fired, in the file
      expect(RM.latest(reminders())["remind-test-1"].state).to.equal("fired");
    });

    it("fires once, however many times the watcher runs", async function () {
      put([reminder()]);
      await W.runReminders([proposal()], options());
      const after = await W.runReminders([proposal()], options());
      expect(after.fired).to.have.length(0);
      expect(messages().filter((m) => m.reminder === "remind-test-1")).to.have.length(1);
      expect(received).to.have.length(1);
    });

    it("does not fire before the day comes", async function () {
      put([reminder()]);
      const result = await W.runReminders([proposal()], options({ now: "2026-09-27T00:00:00Z" }));
      expect(result.fired).to.have.length(0);
      expect(messages()).to.have.length(0);
    });

    it("does not fire on a closed proposal, and leaves it set", async function () {
      put([reminder()]);
      fs.writeFileSync(messagesFile, P.toJsonl(P.normalise({
        from: "kural", type: "decision", proposal: 98, aaoId: 2,
        subject: "Proposal 98: closed", summary: "closed: solved by the migration."
      })), "utf8");
      const result = await W.runReminders([proposal()], options());
      expect(result.fired).to.have.length(0);
      expect(result.skipped[0].because).to.equal("closed");
      expect(RM.latest(reminders())["remind-test-1"].state).to.equal("set");
    });

    it("still posts the line and still fires when there is no phone configured", async function () {
      put([reminder()]);
      const result = await W.runReminders([proposal()], options({ env: {} }));
      expect(result.fired).to.have.length(1);
      expect(result.fired[0].pushSkipped).to.equal(true);
      expect(received).to.have.length(0);
      const said = messages().filter((m) => m.pushUnconfigured === true);
      expect(said, "nobody was told the push was skipped").to.have.length(1);
      expect(said[0].summary).to.contain(PUSH.ENV_NAME);
      expect(RM.latest(reminders())["remind-test-1"].state).to.equal("fired");
    });

    it("says the push was skipped once and never again", async function () {
      put([reminder({ id: "a", proposal: 98 }), reminder({ id: "b", proposal: 98 })]);
      await W.runReminders([proposal()], options({ env: {} }));
      expect(messages().filter((m) => m.pushUnconfigured === true)).to.have.length(1);
    });

    it("reports a failed push once, as an incident, without the topic in it", async function () {
      put([reminder()]);
      const result = await W.runReminders([proposal()], options({
        fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND " + FAKE_TOPIC); }
      }));
      expect(result.fired[0].pushed).to.equal(false);
      const incidents = messages().filter((m) => m.type === "incident" && m.pushFailed === "remind-test-1");
      expect(incidents).to.have.length(1);
      expect(JSON.stringify(incidents[0])).to.not.contain(FAKE_TOPIC);
      // The line on the page still went out: that is the fallback.
      expect(messages().filter((m) => m.reminder === "remind-test-1")).to.have.length(1);
    });

    it("skips a cancelled reminder entirely", async function () {
      put([reminder(), reminder({ state: "cancelled" })]);
      const result = await W.runReminders([proposal()], options());
      expect(result.fired).to.have.length(0);
      expect(messages()).to.have.length(0);
    });
  });

  // The secret rule, checked rather than remembered. A topic that ever reached
  // a tracked file would be public the moment the repository is pushed, and no
  // rotation can take back what a git history holds.
  describe("the topic is nowhere in the repository", function () {
    const DIRS = ["governance", "scripts", "test/governance"];

    it("no source file carries a topic name", function () {
      const offenders = [];
      DIRS.forEach((dir) => {
        const full = path.join(REPO, dir);
        if (!fs.existsSync(full)) return;
        fs.readdirSync(full)
          .filter((f) => f.endsWith(".js") || f.endsWith(".md") || f.endsWith(".json"))
          .forEach((f) => {
            const text = fs.readFileSync(path.join(full, f), "utf8");
            // ntfy.sh followed by a path is a topic. The bare host is not.
            if (/ntfy\.sh\/[A-Za-z0-9_-]+/.test(text)) offenders.push(path.join(dir, f));
          });
      });
      expect(offenders, "a topic name is in the repository: " + offenders.join(", ")).to.deep.equal([]);
    });

    it("push.js reads the topic from the environment and from nothing else", function () {
      const source = fs.readFileSync(path.join(REPO, "governance", "push.js"), "utf8");
      expect(source).to.contain(PUSH.ENV_NAME);
      expect(source, "push.js reads a file for the topic").to.not.match(/readFileSync/);
      expect(PUSH.topicUrl({})).to.equal(null);
      expect(PUSH.topicUrl({ [PUSH.ENV_NAME]: "  " })).to.equal(null);
      expect(PUSH.topicUrl({ [PUSH.ENV_NAME]: "https://example.invalid/x" }))
        .to.equal("https://example.invalid/x");
    });

    it("phone.js keeps it outside the repository, under the user profile", function () {
      const source = fs.readFileSync(path.join(REPO, "scripts", "phone.js"), "utf8");
      expect(source).to.contain("os.homedir()");
      expect(source, "the store is inside the repo").to.not.match(/path\.join\(__dirname, "\.\."/);
    });
  });
});
