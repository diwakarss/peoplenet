// Builders manage their context (proposal 96).
//
// Four parts, tested here: the ctx field and where it shows, the ledger outside
// the builder, the routine hand-over, and the context pack.
//
// Nothing here touches the live record. Every ledger is written into a
// throwaway directory made per test, and the one script that appends to the
// message stream is pointed at a scratch GOVERNANCE_LOG_DIR.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const P = require("../../governance/protocol.js");
const R = require("../../governance/read.js");
const S = require("../../governance/swarm.js");
const L = require("../../governance/ledger.js");
const C = require("../../governance/context-pack.js");
const K = require("../../governance/swarm/kolam.js");

const REPO = path.join(__dirname, "..", "..");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "peoplenet-context-"));
}

function run(file, args, env) {
  return execFileSync(process.execPath, [path.join(REPO, "scripts", file)].concat(args || []), {
    cwd: REPO, encoding: "utf8", timeout: 60000,
    env: Object.assign({}, process.env, env || {})
  });
}

describe("builders manage their context", function () {

  describe("how full an agent is, on the record", function () {
    const base = { from: "kalam", type: "status", subject: "S", summary: "A sentence for a person." };
    const withCtx = (ctx) => Object.assign({}, base, { ctx: ctx });

    it("takes a whole number from 0 to 100", function () {
      [0, 1, 59, 60, 75, 100].forEach((n) => {
        expect(P.validate(withCtx(n)).ok, String(n)).to.equal(true);
      });
    });

    it("refuses everything that is not one, and says which", function () {
      expect(P.validate(withCtx("62")).errors.join(" ")).to.contain("not a number");
      expect(P.validate(withCtx("62%")).errors.join(" ")).to.contain("not a number");
      expect(P.validate(withCtx(62.4)).errors.join(" ")).to.contain("whole number");
      expect(P.validate(withCtx(-1)).errors.join(" ")).to.contain("outside 0 to 100");
      expect(P.validate(withCtx(101)).errors.join(" ")).to.contain("outside 0 to 100");
      expect(P.validate(withCtx(NaN)).ok).to.equal(false);
    });

    it("is optional, so every message written before it stays valid", function () {
      expect(P.validate(base).ok).to.equal(true);
      expect(P.validate(Object.assign({}, base, { ctx: null })).ok).to.equal(true);
    });

    it("is checked wherever it appears, not on a status alone", function () {
      const decision = { from: "kalam", type: "decision", subject: "S", summary: "s.", ctx: 120 };
      expect(P.validate(decision).ok).to.equal(false);
    });

    it("is not part of the id, so a retry keeps its number", function () {
      expect(P.messageId(withCtx(40))).to.equal(P.messageId(withCtx(90)));
    });

    it("bands at sixty and seventy-five, in one place", function () {
      expect(P.ctxBand(0)).to.equal("quiet");
      expect(P.ctxBand(59)).to.equal("quiet");
      expect(P.ctxBand(60)).to.equal("amber");
      expect(P.ctxBand(74)).to.equal("amber");
      expect(P.ctxBand(75)).to.equal("red");
      expect(P.ctxBand(100)).to.equal("red");
      expect(P.ctxBand("nonsense")).to.equal(null);
      expect(P.CTX_AMBER).to.equal(60);
      expect(P.CTX_RED).to.equal(75);
    });
  });

  describe("what the dashboard shows", function () {
    function status(over) {
      return Object.assign({ from: "kalam", type: "status", subject: "S", summary: "s.",
        ts: "2026-09-22T02:00:00.000Z" }, over);
    }

    function kalamIn(messages) {
      return S.street(messages, Date.parse("2026-09-22T02:10:00Z"), [], [])
        .filter((a) => a.key === "kalam")[0];
    }

    it("carries the latest number each agent posted, with its band", function () {
      const agent = kalamIn([
        status({ ctx: 20, ts: "2026-09-22T01:00:00.000Z" }),
        status({ ctx: 62, ts: "2026-09-22T02:00:00.000Z" })
      ]);
      expect(agent.ctx).to.equal(62);
      expect(agent.ctxBand).to.equal("amber");
    });

    it("says nothing about an agent that has never said a number", function () {
      const agent = kalamIn([status({ now: "building 96" })]);
      expect(agent.ctx, "an agent that never said is not empty").to.equal(null);
      expect(agent.ctxBand).to.equal(null);
    });

    it("reads the number off a status that carries no three words", function () {
      const agent = kalamIn([status({ ctx: 80 })]);
      expect(agent.ctx).to.equal(80);
      expect(agent.ctxBand).to.equal("red");
      expect(agent.now).to.equal("");
    });
  });

  describe("the ring on the kolam", function () {
    const seed = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";

    it("is drawn, in its band's colour, when there is a number", function () {
      expect(K.toSVG(seed, { ctx: 30 })).to.contain('class="ctx-arc is-quiet"');
      expect(K.toSVG(seed, { ctx: 60 })).to.contain('class="ctx-arc is-amber"');
      expect(K.toSVG(seed, { ctx: 90 })).to.contain('class="ctx-arc is-red"');
    });

    // The stylesheet always carries the selectors; what must be absent is the
    // circle itself.
    it("is not drawn at all when the agent has never said one", function () {
      const svg = K.toSVG(seed, {});
      expect(svg).to.not.contain('class="ctx-arc');
      expect(svg).to.not.contain('class="ctx-track"');
    });

    it("says the number for a reader who cannot see colour", function () {
      expect(K.toSVG(seed, { ctx: 62 })).to.contain("Context 62% full.");
    });

    it("leaves the dots alone, because the dots are the tasks", function () {
      const without = K.toSVG(seed, { tasks: [] });
      const with_ = K.toSVG(seed, { tasks: [], ctx: 90 });
      expect(without.split("pulli").length).to.equal(with_.split("pulli").length);
    });
  });

  describe("the ledger outside the builder", function () {
    const report = {
      agent: "testbuilder",
      item: "proposal 99, reminders",
      decided: ["A reminder on a proposal closed by that reminder still fires."],
      tried: ["Asking triggerHasFired from the watcher."],
      open: ["94 and 98 point at 61 and 62."],
      commit: "b1a6fc5"
    };

    it("refuses a report that cannot be picked up from", function () {
      const bare = L.validate({ agent: "x" });
      expect(bare.ok).to.equal(false);
      ["item", "decided", "open", "commit"].forEach((field) => {
        expect(bare.errors.join(" "), field).to.contain(field);
      });
      // Tried is the one that may be empty: a stop where nothing was abandoned
      // is an ordinary stop.
      expect(bare.errors.join(" ")).to.not.contain("tried is required");
    });

    it("requires what is open, because that is what a hand-over loses", function () {
      const without = Object.assign({}, report, { open: [] });
      expect(L.validate(without).ok).to.equal(false);
      expect(L.validate(without).errors.join(" ")).to.contain("has not stopped cleanly");
    });

    it("writes a dated section with all five parts", function () {
      const section = L.renderSection(report, "2026-09-22T05:00:00Z");
      expect(section).to.contain("## 2026-09-22 — proposal 99, reminders");
      expect(section).to.contain("**Decided, and why.**");
      expect(section).to.contain("**Tried, and did not work.**");
      expect(section).to.contain("**Open.**");
      expect(section).to.contain("Stands on commit `b1a6fc5`.");
    });

    it("finds its own sections back, so a successor can count the stops", function () {
      const text = L.headerFor("testbuilder") +
        L.renderSection(report, "2026-09-20T00:00:00Z") +
        L.renderSection(Object.assign({}, report, { item: "proposal 96" }), "2026-09-22T00:00:00Z");
      const sections = L.sectionsIn(text);
      expect(sections).to.have.length(2);
      expect(sections[0].date).to.equal("2026-09-20");
      expect(sections[1].item).to.contain("proposal 96");
    });

    it("rehearses, and writes nothing, until it is told to send", function () {
      const dir = scratch();
      const args = ["--agent", "testbuilder", "--item", "an item", "--decided", "a reason",
        "--open", "nothing", "--commit", "abc1234", "--dir", dir];
      const out = run("ledger.js", args);
      expect(out).to.contain("Rehearsal only: nothing was sent.");
      expect(fs.existsSync(path.join(dir, "testbuilder.md")),
        "the rehearsal wrote a file").to.equal(false);

      run("ledger.js", args.concat(["--send"]));
      const text = fs.readFileSync(path.join(dir, "testbuilder.md"), "utf8");
      expect(text).to.contain("A builder's ledger.");
      expect(L.sectionsIn(text)).to.have.length(1);

      // A second stop appends; it never rewrites.
      run("ledger.js", args.concat(["--send"]));
      expect(L.sectionsIn(fs.readFileSync(path.join(dir, "testbuilder.md"), "utf8"))).to.have.length(2);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("refuses an incomplete report from the command line too", function () {
      let failed = false;
      try {
        run("ledger.js", ["--agent", "testbuilder", "--item", "an item", "--send"]);
      } catch (e) {
        failed = true;
        expect(String(e.stderr || e.message)).to.contain("open is required");
      }
      expect(failed, "an incomplete report was written").to.equal(true);
    });
  });

  describe("the generation, recorded beside the role", function () {
    // What is pinned is that the number is read off the role, not what the
    // number is today: it moves at every hand-over, and a literal here would be
    // a test edited at every rotation. Proposal 104.
    it("is on the role and not in a message that scrolls away", function () {
      const role = R.roleByKey("kalam");
      expect(role.address).to.equal(R.KALAM);
      expect(Number.isInteger(role.generation), "the number lives on the role").to.equal(true);
      expect(role.generation).to.be.at.least(1);
      expect(R.generationOf("kalam")).to.equal(role.generation);
    });

    it("is 1 for a role that has never rotated, and null for a name nobody knows", function () {
      expect(R.generationOf("wren")).to.equal(1);
      expect(R.generationOf("director")).to.equal(1);
      expect(R.generationOf("nobody")).to.equal(null);
      expect(R.roleByKey("nobody")).to.equal(null);
    });

    // The bug this test exists for: a second function called roleFor, taking a
    // key instead of an address, silently replaced the one that takes an
    // address. Everything that asked it by address started getting null.
    it("did not take the name of the roleFor that reads an address", function () {
      expect(R.labelFor(R.KALAM)).to.equal("Kalam");
      expect(R.labelFor(R.WREN)).to.equal("Wren");
    });
  });

  describe("the routine hand-over", function () {
    const report = {
      agent: "kalam", generation: 3, item: "proposals 99 and 96",
      open: ["The reminders on 61 and 62 have not fired yet."], commit: "b1a6fc5"
    };

    it("names the generation that ended in its subject", function () {
      const message = P.normalise(L.handoverMessage(report));
      expect(message.subject).to.equal("Kalam hands over at generation 3");
      expect(message.type).to.equal("decision");
      expect(message.from).to.equal("kalam");
      expect(message.handover).to.equal(true);
      expect(P.validate(message).ok).to.equal(true);
    });

    it("says what is open and where the ledger is", function () {
      const message = P.normalise(L.handoverMessage(report));
      expect(message.summary).to.contain("generation 4 takes the name");
      expect(message.summary).to.contain("have not fired yet");
      expect(message.summary).to.contain("governance/ledger/kalam.md");
      expect(message.summary).to.contain("b1a6fc5");
    });

    // Proposal 104. The fourth Kalam handed over on three commits and the
    // summary named the first as though the stop stood on it alone. The details
    // and the refs carried all three, so the record was complete and the one
    // sentence a person reads was not.
    it("names every commit the stop stands on, not the first", function () {
      const message = P.normalise(L.handoverMessage(Object.assign({}, report, {
        commit: ["a2f8a1c", "b20acb8", "c171382"]
      })));
      expect(message.summary).to.contain("stands on commits a2f8a1c, b20acb8 and c171382.");
      ["a2f8a1c", "b20acb8", "c171382"].forEach((sha) => {
        expect(message.refs, `refs lost ${sha}`).to.contain("commit " + sha);
      });
    });

    it("still reads as English with one commit, and with none", function () {
      const one = P.normalise(L.handoverMessage(report));
      expect(one.summary).to.contain("stands on commit b1a6fc5.");
      expect(one.summary).to.not.contain("commits");

      const none = P.normalise(L.handoverMessage(Object.assign({}, report, { commit: [] })));
      expect(none.summary).to.contain("stands on commit an unrecorded commit.");
    });

    it("lists two commits with no comma, and any number after that with one", function () {
      expect(L.englishList([])).to.equal("");
      expect(L.englishList("one")).to.equal("one");
      expect(L.englishList(["one", "two"])).to.equal("one and two");
      expect(L.englishList(["one", "two", "three"])).to.equal("one, two and three");
    });

    it("prints one id for the successor to acknowledge", function () {
      const message = P.normalise(L.handoverMessage(report));
      const said = L.acknowledgementFor(message, "kalam", 3);
      expect(said).to.contain("Kalam generation 4");
      expect(said).to.contain(message.id);
      expect(said).to.contain("governance/ledger/kalam.md");
    });

    it("refuses to hand over before the ledger is written", function () {
      const dir = scratch();
      let failed = false;
      try {
        run("handover.js", ["--agent", "kalam", "--item", "an item", "--open", "nothing",
          "--commit", "abc1234", "--dir", dir, "--send"]);
      } catch (e) {
        failed = true;
        expect(String(e.stderr || e.message)).to.contain("no ledger");
      }
      expect(failed, "it handed over pointing at a ledger nobody wrote").to.equal(true);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("refuses to hand over without saying what is open", function () {
      let failed = false;
      try {
        run("handover.js", ["--agent", "kalam", "--item", "an item", "--commit", "abc", "--send"]);
      } catch (e) {
        failed = true;
        expect(String(e.stderr || e.message)).to.contain("has not stopped cleanly");
      }
      expect(failed).to.equal(true);
    });

    it("rehearses into a scratch log, writing nothing to the real stream", function () {
      const dir = scratch();
      const logs = scratch();
      run("ledger.js", ["--agent", "kalam", "--item", "an item", "--decided", "a reason",
        "--open", "nothing", "--commit", "abc1234", "--dir", dir, "--send"]);

      // The number comes off the role, which moves at every hand-over, so the
      // test asks read.js what it is rather than pinning a number that was true
      // the day it was written. A test that has to be edited at every rotation
      // is a test that will be edited wrongly at one of them.
      const now = R.generationOf("kalam");
      const args = ["--agent", "kalam", "--item", "an item", "--open", "nothing",
        "--commit", "abc1234", "--dir", dir];
      const out = run("handover.js", args, { GOVERNANCE_LOG_DIR: logs });
      expect(out).to.contain("Rehearsal only: nothing was sent.");
      expect(out).to.contain(`Kalam hands over at generation ${now}`);
      expect(fs.existsSync(path.join(logs, "messages.jsonl")),
        "the rehearsal wrote to the stream").to.equal(false);

      const sent = run("handover.js", args.concat(["--send"]), { GOVERNANCE_LOG_DIR: logs });
      const written = P.parseJsonl(fs.readFileSync(path.join(logs, "messages.jsonl"), "utf8")).records;
      expect(written).to.have.length(1);
      expect(written[0].handover).to.equal(true);
      expect(written[0].generation).to.equal(now);
      expect(sent).to.contain(written[0].id);
      expect(sent).to.contain(`set generation to ${now + 1}`);

      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(logs, { recursive: true, force: true });
    });
  });

  describe("the context pack", function () {
    const prose = [
      "Change governance/read.js and governance/watch.js so viewFor returns the",
      "right view. protocol.js gains a field. Tests in",
      "test/governance/watch.test.js. Do not touch the .jsonl logs by hand, and",
      "restart the server by its pid. The ntfy topic is a secret.",
      "runReminders() is the new function."
    ].join("\n");

    it("finds the paths a proposal names, once each", function () {
      const files = C.filesNamedIn(prose);
      expect(files).to.contain("governance/read.js");
      expect(files).to.contain("governance/watch.js");
      expect(files).to.contain("test/governance/watch.test.js");
      expect(files.filter((f) => f === "governance/read.js")).to.have.length(1);
    });

    it("resolves a bare file name only when the caller says where it is", function () {
      expect(C.filesNamedIn(prose)).to.not.contain("governance/protocol.js");
      const resolved = C.filesNamedIn(prose, (name) =>
        name === "protocol.js" ? "governance/protocol.js" : null);
      expect(resolved).to.contain("governance/protocol.js");
    });

    it("finds the symbols, and not the prose that looks like one", function () {
      const symbols = C.symbolsNamedIn(prose);
      expect(symbols).to.contain("viewFor");
      expect(symbols).to.contain("runReminders");
      expect(C.symbolsNamedIn("the ntfy iPhone app")).to.deep.equal([]);
    });

    it("attaches the rules for what the item will actually touch", function () {
      const keys = C.capabilitiesFor(prose, C.filesNamedIn(prose)).map((c) => c.key);
      expect(keys).to.contain("logs");
      expect(keys).to.contain("watcher");
      expect(keys).to.contain("server");
      expect(keys).to.contain("secrets");
    });

    it("attaches nothing to an item that touches nothing", function () {
      expect(C.capabilitiesFor("A one-line change to a comment.", [])).to.deep.equal([]);
    });

    it("gives every rule somewhere to read it", function () {
      C.CAPABILITIES.forEach((capability) => {
        expect(capability.rules.length, capability.key).to.be.greaterThan(0);
        capability.rules.forEach((rule) => {
          expect(rule.rule, capability.key).to.be.a("string");
          expect(rule.source, capability.key + ": a rule with no source").to.be.a("string");
          expect(rule.source.length).to.be.greaterThan(0);
        });
      });
    });

    it("collects what was said on a proposal, oldest first", function () {
      const said = C.saidOn([
        { proposal: 99, type: "decision", ts: "2026-09-22T02:00:00Z", summary: "b" },
        { proposal: 99, type: "question", ts: "2026-09-21T02:00:00Z", summary: "a" },
        { proposal: 98, type: "decision", ts: "2026-09-21T03:00:00Z", summary: "elsewhere" },
        { refs: ["proposal 99"], type: "answer", ts: "2026-09-23T02:00:00Z", summary: "c" }
      ], 99);
      expect(said.map((m) => m.summary)).to.deep.equal(["a", "b", "c"]);
    });

    it("does not mistake proposal 9 for proposal 99 in a ref", function () {
      const said = C.saidOn([{ refs: ["proposal 9"], ts: "2026-09-22T02:00:00Z", summary: "x" }], 99);
      expect(said).to.have.length(0);
    });

    it("runs, and says where the callers came from", function () {
      const out = run("context-pack.js", ["96"]);
      expect(out).to.contain("Context pack for proposal 96");
      expect(out).to.contain("The files it names");
      expect(out).to.contain("The rules on what it will touch");
      // Whichever source it used, it says which. A pack that quietly changed
      // its source would be a pack whose gaps nobody could see.
      expect(/gbrain's code index|a grep of the repository|names no path/.test(out),
        "the pack did not say where it looked").to.equal(true);
    });
  });
});
