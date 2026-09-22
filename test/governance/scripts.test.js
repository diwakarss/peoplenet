// The write scripts, tested against a chain that is thrown away afterwards.
//
// The rule this file exists for: no script that writes to the chain is ever run
// against live state to test it. A vote was cast by accident on proposal 32
// doing exactly that, and one member, one vote means it could not be taken
// back. So the scripts' decisions are tested here, on the in-process hardhat
// network, where every proposal in this file is one this file filed.
//
// What is tested is the decision, not the plumbing: given this chain and these
// arguments, would the script send the transaction, and if not, why not. The
// scripts read that decision out of governance/read.js, so this tests the
// function they call rather than a copy of it.
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const { getSelectors, FacetCutAction } = require("../helpers/diamond");
const R = require("../../governance/read.js");
const A = require("../../governance/adoption.js");

describe("the write scripts refuse before they send", function () {
  let aao;
  let director, wren, casting, builder, widget, outsider;
  let mainId, subId;

  async function submit(aaoId, signer, text) {
    const tx = await aao.connect(signer).submitProposal(aaoId, text);
    const receipt = await tx.wait();
    const log = receipt.logs
      .map((l) => { try { return aao.interface.parseLog(l); } catch (e) { return null; } })
      .find((x) => x && x.name === "ProposalSubmitted");
    return Number(log.args.proposalId);
  }

  // What the page and the scripts both read back for a proposal.
  async function readOne(aaoId, id) {
    return (await R.readProposals(aao, aaoId)).filter((p) => p.id === id)[0];
  }

  before(async function () {
    const signers = await ethers.getSigners();
    [director, wren, casting, builder, widget] = signers;
    outsider = signers[5];

    const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
    const diamondCutFacet = await DiamondCutFacet.deploy();
    const Diamond = await ethers.getContractFactory("DiamondController");
    const diamond = await Diamond.deploy(director.address, await diamondCutFacet.getAddress());
    const AAOFacet = await ethers.getContractFactory("AAOFacet");
    const aaoFacet = await AAOFacet.deploy();

    const diamondAddress = await diamond.getAddress();
    const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddress);
    await diamondCut.diamondCut(
      [{
        facetAddress: await aaoFacet.getAddress(),
        action: FacetCutAction.Add,
        functionSelectors: getSelectors(aaoFacet)
      }],
      ethers.ZeroAddress,
      "0x"
    );
    aao = await ethers.getContractAt("AAOFacet", diamondAddress);

    // The two organisations, with the memberships the rule sets assume.
    let tx = await aao.connect(director).createAAO("trilogy widget", 3600);
    let receipt = await tx.wait();
    mainId = Number(receipt.logs
      .map((l) => { try { return aao.interface.parseLog(l); } catch (e) { return null; } })
      .find((x) => x && x.name === "AAOCreated").args.aaoId);
    await aao.connect(wren).joinAAO(mainId);
    await aao.connect(casting).joinAAO(mainId);

    tx = await aao.connect(director).createAAO("widget-builder", 3600);
    receipt = await tx.wait();
    subId = Number(receipt.logs
      .map((l) => { try { return aao.interface.parseLog(l); } catch (e) { return null; } })
      .find((x) => x && x.name === "AAOCreated").args.aaoId);
    await aao.connect(wren).joinAAO(subId);
    await aao.connect(builder).joinAAO(subId);
    await aao.connect(widget).joinAAO(subId);
  });

  describe("the vote guard, which every vote path calls", function () {
    it("refuses an id that was never filed", async function () {
      const ghost = await aao.getProposal(4242);
      const problem = R.voteTargetProblem(4242, ghost);
      expect(problem).to.be.a("string");
      expect(problem).to.contain("not been filed");
    });

    it("lets a filed proposal through", async function () {
      const id = await submit(mainId, director, "A filed proposal.");
      const filed = await aao.getProposal(id);
      expect(R.voteTargetProblem(id, filed)).to.equal(null);
    });

    it("refuses when the proposal is not the one the caller read", async function () {
      const id = await submit(mainId, director, JSON.stringify({
        title: "The real one", summary: "s", why: "w"
      }));
      const filed = await aao.getProposal(id);
      expect(R.voteTargetProblem(id, filed, { title: "Something else" })).to.contain("Refusing");
      expect(R.voteTargetProblem(id, filed, { title: "  the REAL one " })).to.equal(null);
      expect(R.voteTargetProblem(id, filed, { text: "different" })).to.contain("changed under you");
    });

    it("means a refused vote never reaches the chain, so the id stays clean", async function () {
      // The contract guard is the backstop; this is the script-side half.
      await expect(aao.connect(wren).vote(4242, true))
        .to.be.revertedWith("AAOFacet: Proposal does not exist");
      const id = await submit(mainId, director, "Filed after the refused vote.");
      await aao.connect(wren).vote(id, true);
      expect(Number((await aao.getProposal(id)).forVotes)).to.equal(1);
    });
  });

  describe("wren-vote's standing, by organisation", function () {
    it("lets Wren vote as an ordinary member on the main organisation", async function () {
      const rules = R.rulesFor({ topic: "trilogy widget" });
      expect(R.voterProblem(rules, R.WREN)).to.equal(null);
      expect(rules.voters.some((a) => R.sameAddress(a, R.WREN))).to.equal(true);
    });

    it("refuses Wren's vote on the sub-AAO until the tally is level", async function () {
      const rules = R.rulesFor({ topic: "widget-builder" });
      const id = await submit(subId, builder, JSON.stringify({
        title: "A sub-AAO proposal", summary: "s", why: "w"
      }));

      // Nobody has voted.
      let p = await readOne(subId, id);
      expect(R.castingStateUnder(rules, p).allowed).to.equal(false);
      expect(R.castingStateUnder(rules, p).reason).to.contain("Waiting for");

      // The builder has, the widget has not.
      await aao.connect(builder).vote(id, true);
      p = await readOne(subId, id);
      expect(R.castingStateUnder(rules, p).allowed).to.equal(false);

      // Both in, but not level.
      await aao.connect(widget).vote(id, true);
      p = await readOne(subId, id);
      expect(R.castingStateUnder(rules, p).allowed).to.equal(false);
      expect(R.castingStateUnder(rules, p).reason).to.contain("No tie to break");
    });

    it("allows it once both have voted and the tally is level", async function () {
      const rules = R.rulesFor({ topic: "widget-builder" });
      const id = await submit(subId, builder, JSON.stringify({
        title: "A tied sub-AAO proposal", summary: "s", why: "w"
      }));
      await aao.connect(builder).vote(id, true);
      await aao.connect(widget).vote(id, false);

      const p = await readOne(subId, id);
      const state = R.castingStateUnder(rules, p);
      expect(state.allowed).to.equal(true);
      expect(state.reason).to.contain("casting vote decides");

      // And once cast, it is not offered again.
      await aao.connect(wren).vote(id, true);
      expect(R.castingStateUnder(rules, await readOne(subId, id)).allowed).to.equal(false);
    });

    it("refuses the Director on the sub-AAO, where they only watch", async function () {
      const rules = R.rulesFor({ topic: "widget-builder" });
      const problem = R.voterProblem(rules, R.DIRECTOR);
      expect(problem).to.be.a("string");
      expect(problem).to.contain("watches");
    });
  });

  // The widget cannot vote: its add-on does not exist, so nothing on the
  // widget-builder ever reached "both voted" and three proposals sat there
  // with no exit but a 24-hour timer. The interim rule makes Wren the second
  // ordinary voter until account 4 casts its first vote, and the chain itself
  // says when that is -- there is no flag to unset.
  describe("the widget-builder before and after the widget can vote", function () {
    let interimId;
    let quietId;   // a widget-builder the widget has never voted on

    before(async function () {
      // The block above has the widget voting, which is precisely what ends
      // the interim regime. So this one gets its own organisation, where
      // account 4 is a member and has never cast anything.
      const tx = await aao.connect(director).createAAO("widget-builder", 3600);
      const receipt = await tx.wait();
      quietId = Number(receipt.logs
        .map((l) => { try { return aao.interface.parseLog(l); } catch (e) { return null; } })
        .find((x) => x && x.name === "AAOCreated").args.aaoId);
      await aao.connect(wren).joinAAO(quietId);
      await aao.connect(builder).joinAAO(quietId);
      await aao.connect(widget).joinAAO(quietId);
    });

    async function subProposals() {
      return R.readProposals(aao, quietId);
    }

    it("is under the interim rule while account 4 has never voted", async function () {
      const rules = R.effectiveRules({ topic: "widget-builder" }, await subProposals());
      expect(rules.interim, "the interim rule should be in force").to.equal(true);
      expect(rules.voters.map(R.labelFor)).to.deep.equal(["Builder", "Wren"]);
      expect(rules.casting, "nobody breaks a tie between two voters").to.equal(null);
      expect(rules.windowHours).to.equal(1);
      expect(rules.plain[0]).to.contain("Interim");
    });

    it("lets Wren vote as an ordinary member, not only to break a tie", async function () {
      const rules = R.effectiveRules({ topic: "widget-builder" }, await subProposals());
      expect(R.voterProblem(rules, R.WREN)).to.equal(null);
      expect(rules.voters.some((a) => R.sameAddress(a, R.WREN))).to.equal(true);
      // And the Director is still only watching.
      expect(R.voterProblem(rules, R.DIRECTOR)).to.contain("watches");
    });

    it("executes as soon as the builder and Wren agree", async function () {
      interimId = await submit(quietId, builder, JSON.stringify({
        title: "Something for the interim rule to finish",
        summary: "Filed so the two voters that exist can actually close it.",
        why: "A proposal nobody can close is not governance."
      }));

      await aao.connect(builder).vote(interimId, true);
      let p = (await subProposals()).filter((x) => x.id === interimId)[0];
      let rules = R.effectiveRules({ topic: "widget-builder" }, await subProposals());

      // One vote, inside the hour: it waits.
      let state = R.autoExecuteState(rules, p, Number(p.createdAt) + 60);
      expect(state.should, state.reason).to.equal(false);
      expect(state.reason).to.contain("1-hour window");

      // Wren votes: both voters are in and the tally is decisive.
      await aao.connect(wren).vote(interimId, true);
      p = (await subProposals()).filter((x) => x.id === interimId)[0];
      rules = R.effectiveRules({ topic: "widget-builder" }, await subProposals());
      state = R.autoExecuteState(rules, p, Number(p.createdAt) + 60);
      expect(state.should, state.reason).to.equal(true);
      expect(R.sameAddress(state.by, R.WREN)).to.equal(true);

      // And it really closes.
      await expect(aao.connect(wren).executeProposal(interimId))
        .to.emit(aao, "ProposalExecuted")
        .withArgs(quietId, interimId, true);
    });

    it("lets a lone vote carry after the hour, not the day", async function () {
      const id = await submit(quietId, builder, JSON.stringify({
        title: "A lone vote under the interim rule",
        summary: "Only the builder votes on this one.",
        why: "The window has to be short enough to be a rule and not a wall."
      }));
      await aao.connect(builder).vote(id, true);

      const p = (await subProposals()).filter((x) => x.id === id)[0];
      const rules = R.effectiveRules({ topic: "widget-builder" }, await subProposals());
      const at = Number(p.createdAt);

      // The window runs from the first vote, not from filing. Measuring it from
      // filing meant a proposal older than the window executed the instant one
      // vote arrived -- which is how 26, 29 and 30 closed six minutes after the
      // builder voted, before the Director had seen them.
      const votedAt = p.votes[0].at;
      expect(votedAt, "the vote should carry a timestamp").to.be.greaterThan(0);
      expect(R.autoExecuteState(rules, p, votedAt + 30 * 60).should, "half an hour").to.equal(false);
      expect(R.autoExecuteState(rules, p, votedAt + 61 * 60).should, "an hour and a minute").to.equal(true);

      // And filing long ago must not shorten it.
      const aged = Object.assign({}, p, { createdAt: at - 90 * 24 * 3600 });
      expect(R.autoExecuteState(rules, aged, votedAt + 30 * 60).should,
        "an old proposal must still get its window").to.equal(false);
    });

    it("returns to the standing rule the moment the widget votes", async function () {
      const id = await submit(quietId, builder, JSON.stringify({
        title: "The one the widget votes on",
        summary: "Its first vote ends the interim rule for everything here.",
        why: "The chain should say when a temporary rule stops, not a person."
      }));

      // Before: interim.
      expect(R.effectiveRules({ topic: "widget-builder" }, await subProposals()).interim)
        .to.equal(true);

      await aao.connect(widget).vote(id, true);

      // After: the written rule, with no flag touched anywhere.
      const rules = R.effectiveRules({ topic: "widget-builder" }, await subProposals());
      expect(rules.interim, "the interim rule should have ended").to.not.equal(true);
      expect(rules.voters.map(R.labelFor)).to.deep.equal(["Builder", "Widget"]);
      expect(R.sameAddress(rules.casting, R.WREN)).to.equal(true);
      expect(rules.windowHours).to.equal(24);

      // And Wren is the tie-breaker again, not an ordinary voter. The widget
      // voted; the builder has not, so the casting vote waits for both -- which
      // is exactly the difference from the interim rule.
      const p = (await subProposals()).filter((x) => x.id === id)[0];
      const casting = R.castingStateUnder(rules, p);
      expect(casting.allowed, casting.reason).to.equal(false);
      expect(casting.reason).to.contain("Waiting for Builder and Widget");

      // Once the builder is in too it is a tally, not a tie.
      await aao.connect(builder).vote(id, true);
      const both = (await subProposals()).filter((x) => x.id === id)[0];
      const after = R.castingStateUnder(rules, both);
      expect(after.allowed, after.reason).to.equal(false);
      expect(after.reason).to.contain("No tie to break");
    });

    it("leaves the main organisation alone throughout", async function () {
      const main = R.effectiveRules({ topic: "trilogy widget" }, await R.readProposals(aao, mainId));
      expect(main.interim).to.not.equal(true);
      expect(main.voters.map(R.labelFor)).to.deep.equal(["Director", "Wren"]);
      expect(R.sameAddress(main.casting, R.CASTING)).to.equal(true);
      expect(main.autoExecute).to.equal("on-director-vote");
    });
  });

  describe("the page's buttons apply the same rule as the scripts", function () {
    it("uses one casting-vote function for both organisations", async function () {
      // The page calls castingStateUnder through rulesForProposal; the scripts
      // call it directly. Same function, so the same answer -- this asserts the
      // two rule sets disagree in the way they are meant to and nowhere else.
      const main = R.rulesFor({ topic: "trilogy widget" });
      const sub = R.rulesFor({ topic: "widget-builder" });
      expect(R.sameAddress(main.casting, R.CASTING)).to.equal(true);
      expect(R.sameAddress(sub.casting, R.WREN)).to.equal(true);
      expect(main.voters.map(R.labelFor)).to.deep.equal(["Director", "Wren"]);
      expect(sub.voters.map(R.labelFor)).to.deep.equal(["Builder", "Widget"]);
    });

    it("refuses a vote from an account with no standing at all", async function () {
      const rules = R.rulesFor({ topic: "trilogy widget" });
      expect(R.voterProblem(rules, outsider.address)).to.be.a("string");
      const id = await submit(mainId, director, "Not for outsiders.");
      await expect(aao.connect(outsider).vote(id, true))
        .to.be.revertedWith("AAOFacet: Not a member");
    });
  });

  // A vote's reason is the half another agent can answer, but nothing in the
  // record said what the voter was LOOKING at when they wrote it. The builder
  // found its own vote on proposal 26 unanchored that way and asked for this.
  describe("what a vote was cast against (proposal 29)", function () {
    it("reads refs off a record the way the card renders them", function () {
      expect(R.voteRefs({ refs: ["commit 1f8076d", "proposal 26"] }))
        .to.deep.equal(["commit 1f8076d", "proposal 26"]);
      expect(R.voteRefs({ refs: ["  spec 27.1  ", "", "  "] }), "blanks go, the rest is trimmed")
        .to.deep.equal(["spec 27.1"]);
      expect(R.voteRefs({ refs: ["proposal 26", "proposal 26"] }), "twice is once")
        .to.deep.equal(["proposal 26"]);
    });

    it("treats a record with no refs as a record with no refs, not an error", function () {
      // Every record written before proposal 29 is in this state. The logs are
      // append-only, so they stay that way and the card has to cope.
      expect(R.voteRefs({ reason: "an old record" })).to.deep.equal([]);
      expect(R.voteRefs({ refs: null })).to.deep.equal([]);
      expect(R.voteRefs({ refs: "not an array" })).to.deep.equal([]);
      expect(R.voteRefs(undefined)).to.deep.equal([]);
    });

    it("parses a repeatable --ref and carries it onto the record", function () {
      // Every vote script shares one parser since proposal 30, so this is read
      // once -- which is the whole argument for the shared module.
      const V = require("../../governance/vote.js");
      const parse = (argv) => V.parseArgs(["node", "vote.js"].concat(argv), { defaultAaoId: 1 });

      expect(parse(["3", "for", "a", "reason"]).refs).to.deep.equal([]);
      expect(parse(["3", "for", "why", "--ref", "commit abc"]).refs).to.deep.equal(["commit abc"]);
      expect(parse(["3", "for", "why", "--ref", "commit abc", "--ref", "proposal 26"]).refs)
        .to.deep.equal(["commit abc", "proposal 26"]);

      // And the flag never eats the reason: the reason stays one free-text run.
      const parsed = parse(["3", "for", "the", "cache", "key", "is", "it", "--ref", "spec 27.1"]);
      expect(parsed.reason).to.equal("the cache key is it");
      expect(parsed.refs).to.deep.equal(["spec 27.1"]);
      expect(parsed.rawId).to.equal("3");
      expect(parsed.rawSupport).to.equal("for");
    });

    it("writes the refs onto the record and shows them in the rehearsal", function () {
      const source = fs.readFileSync(
        path.join(__dirname, "..", "..", "governance", "vote.js"), "utf8");
      expect(source, "does not parse --ref").to.contain('"--ref"');
      expect(source, "does not clean the refs through read.js").to.contain("R.voteRefs(");
      expect(source, "does not put refs on the record").to.match(/\n\s*refs: args\.refs,/);
      expect(source, "the rehearsal does not say what it would point at")
        .to.contain("would point at");
    });

    it("serves the builder's log the same way it serves Wren's", function () {
      // The builder's reasons were being written to a file nothing served and
      // nothing showed, which is half of why its vote on 26 was unanchored.
      const server = fs.readFileSync(
        path.join(__dirname, "..", "..", "governance", "server.js"), "utf8");
      expect(server).to.contain('"/builder-votes.json": "builder-votes.jsonl"');
      expect(R.BUILDER_VOTES_PATH).to.equal("/builder-votes.json");
      expect(R.fetchBuilderVotes).to.be.a("function");
    });
  });

  // One vote script, told which account it is (proposal 30). builder-vote.js was
  // wren-vote.js with two names changed, so the guard against voting on an
  // unfiled id had to be written twice and --dry-run had to be remembered twice.
  describe("one vote script for every agent that votes (proposal 30)", function () {
    const V = require("../../governance/vote.js");
    const VOTERS = [
      { file: "wren-vote.js", account: 1, label: "Wren",
        log: "wren-votes.jsonl", defaultAaoId: 0 },
      { file: "builder-vote.js", account: 3, label: "Builder",
        log: "builder-votes.jsonl", defaultAaoId: 1 },
      { file: "widget-vote.js", account: 4, label: "Widget",
        log: "widget-votes.jsonl", defaultAaoId: 1 },
      { file: "kural-vote.js", account: 5, label: "Kural",
        log: "kural-votes.jsonl", defaultAaoId: 2 },
      { file: "kalam-vote.js", account: 6, label: "Kalam",
        log: "kalam-votes.jsonl", defaultAaoId: 3 }
    ];

    function sourceOf(file) {
      return fs.readFileSync(path.join(__dirname, "..", "..", "scripts", file), "utf8");
    }

    VOTERS.forEach((voter) => {
      it(`${voter.file} is a wrapper: who it is, and nothing else`, function () {
        const source = sourceOf(voter.file);

        // It delegates rather than repeating.
        expect(source, `${voter.file} does not use the shared script`)
          .to.contain('require("../governance/vote.js").run(');
        expect(source, `${voter.file} says who it is`).to.contain(`account: ${voter.account}`);
        expect(source, `${voter.file} names its log`).to.contain(`"${voter.log}"`);
        expect(source, `${voter.file} names its default organisation`)
          .to.contain(`defaultAaoId: ${voter.defaultAaoId}`);

        // And it does none of the work itself. These are the things that used to
        // be copied, and a copy reappearing here is the regression.
        for (const copied of ["getContractAt", "voteTargetProblem", "appendFileSync", "tallyAfter"]) {
          expect(source.includes(copied), `${voter.file} has its own ${copied} again`)
            .to.equal(false);
        }

        // Code, not comment: a wrapper this size is the proposal's whole point.
        const code = source.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("//"));
        expect(code.length, `${voter.file} is ${code.length} lines of code, not a wrapper`)
          .to.be.lessThan(25);
      });
    });

    it("gives every voter the same default: rehearse, and send only on --send", function () {
      for (const voter of VOTERS) {
        const rehearsing = V.parseArgs(["node", voter.file, "3", "for", "why"], voter);
        const sending = V.parseArgs(["node", voter.file, "3", "for", "why", "--send"], voter);
        const both = V.parseArgs(["node", voter.file, "3", "for", "why", "--send", "--dry-run"], voter);
        expect(rehearsing.dryRun, `${voter.file} sends by default`).to.equal(true);
        expect(sending.dryRun, `${voter.file} ignores --send`).to.equal(false);
        expect(both.dryRun, `${voter.file} lets --send beat --dry-run`).to.equal(true);
      }
    });

    it("gives every voter the same default organisation it was told", function () {
      for (const voter of VOTERS) {
        expect(V.parseArgs(["node", voter.file, "3", "for", "why"], voter).aaoId).to.equal(voter.defaultAaoId);
        expect(V.parseArgs(["node", voter.file, "--aao", "7", "3", "for", "why"], voter).aaoId)
          .to.equal(7);
      }
    });

    it("writes each voter's record to that voter's own log", function () {
      for (const voter of VOTERS) {
        const file = V.logPathFor({ logFile: voter.log });
        expect(path.basename(file)).to.equal(voter.log);
        expect(path.basename(path.dirname(file))).to.equal("governance");
      }
      // One log each: a shared script must not pool them. Counted off the
      // list, so adding a voter does not need this number edited too.
      const logs = VOTERS.map((v) => v.log);
      expect(new Set(logs).size).to.equal(VOTERS.length);
    });

    it("prints each script's own name and its own standing in its usage", function () {
      for (const voter of VOTERS) {
        const lines = V.usageLines({
          command: voter.file, defaultAaoId: voter.defaultAaoId,
          standingNotes: [`--aao ${voter.defaultAaoId}   the default for this one`]
        }).join("\n");
        expect(lines).to.contain(`node scripts/${voter.file}`);
        expect(lines).to.contain(`(default ${voter.defaultAaoId})`);
        expect(lines, "the usage must say sending is not the default")
          .to.contain("Rehearsing is the default");
      }
    });

    it("lets the widget vote at all, which is what ends the interim rule",
      async function () {
        // Before proposal 30 there was no widget-vote.js, and the rule that
        // waits for the widget's first vote had nothing that could cast one.
        expect(fs.existsSync(path.join(__dirname, "..", "..", "scripts", "widget-vote.js")))
          .to.equal(true);

        // And the rule in force really does turn on that vote, through the same
        // read.js the script checks its standing against.
        const before = R.effectiveRules({ topic: "widget-builder" }, []);
        const after = R.effectiveRules({ topic: "widget-builder" },
          [{ votes: [{ voter: R.WIDGET }] }]);
        expect(before.interim).to.equal(true);
        expect(after.interim).to.not.equal(true);
        expect(R.voterProblem(before, R.WIDGET), "the widget must be able to cast it")
          .to.equal(null);
      });
  });

  // An organisation created on the chain with no rule set written for it here.
  // The page has to show it like the others on the day it appears, not after a
  // code change. JD was the example until it got its own rule set on 2026-09-18;
  // the fixture now uses a topic nothing will ever write a rule for.
  describe("an organisation nobody has written a rule for", function () {
    let otherId;

    before(async function () {
      const tx = await aao.connect(director).createAAO("unruled-fixture", 3600);
      const receipt = await tx.wait();
      otherId = Number(receipt.logs
        .map((l) => { try { return aao.interface.parseLog(l); } catch (e) { return null; } })
        .find((x) => x && x.name === "AAOCreated").args.aaoId);
      await aao.connect(wren).joinAAO(otherId);
      await aao.connect(casting).joinAAO(otherId);
      await aao.connect(outsider).joinAAO(otherId);
    });

    async function rulesHere() {
      const contract = aao;
      const all = await R.readAAOs(contract);
      const mine = all.filter((a) => a.id === otherId)[0];
      return R.effectiveRules(mine, await R.readProposals(contract, otherId));
    }

    it("takes its voters from its members, so everyone on it can vote", async function () {
      const rules = await rulesHere();
      // Empty voters would have the page tell the organisation's own creator
      // they are "not one of its voters ()" -- wrong, and unreadable with it.
      expect(rules.voters.length, "an organisation with members has voters").to.equal(4);
      expect(R.voterProblem(rules, R.DIRECTOR)).to.equal(null);
      expect(R.voterProblem(rules, R.WREN)).to.equal(null);
      expect(R.voterProblem(rules, R.CASTING)).to.equal(null);
      expect(R.voterProblem(rules, outsider.address),
        "a member with no role label still votes").to.equal(null);
    });

    it("keeps an account that is not on it out", async function () {
      const rules = await rulesHere();
      expect(R.voterProblem(rules, R.BUILDER)).to.be.a("string");
      await expect(aao.connect(builder).vote(4242, true)).to.be.reverted;
    });

    it("says what its rule is, in plain English, without one being written",
      async function () {
        const rules = await rulesHere();
        expect(rules.plain[0]).to.contain("Every member has one vote");
        rules.plain.forEach((line) => expect(line.trim()).to.not.equal(""));
        // No regime chip: it has only one rule, so there is nothing to tell apart.
        expect(rules.regime).to.equal(null);
      });

    it("offers no casting vote, because nobody has named one", async function () {
      const id = await submit(otherId, director, JSON.stringify({
        title: "A proposal on the new organisation", summary: "s", why: "w"
      }));
      await aao.connect(director).vote(id, true);
      await aao.connect(wren).vote(id, false);

      const rules = await rulesHere();
      const p = (await R.readProposals(aao, otherId)).filter((x) => x.id === id)[0];
      const casting = R.castingStateUnder(rules, p);
      expect(casting.allowed).to.equal(false);
      expect(casting.reason).to.contain("no casting vote");

      // Which is the contract's own behaviour: a level tally rejects.
      await expect(aao.connect(director).executeProposal(id))
        .to.emit(aao, "ProposalExecuted").withArgs(otherId, id, false);
    });

    it("executes on nobody's timer: the watcher leaves it alone", async function () {
      const rules = await rulesHere();
      expect(rules.autoExecute).to.equal("none");
      const state = R.autoExecuteState(rules, {
        status: 0, forVotes: 2, againstVotes: 0, createdAt: 0,
        votes: [{ voter: R.DIRECTOR, support: true, at: 1 }]
      }, 10 ** 9);
      expect(state.should, state.reason).to.equal(false);
    });

    it("leaves the two organisations that do have rules exactly as they were",
      async function () {
        const main = R.rulesFor({ topic: "trilogy widget" });
        const sub = R.rulesFor({ topic: "widget-builder" });
        expect(main.voters.map(R.labelFor)).to.deep.equal(["Director", "Wren"]);
        expect(sub.voters.map(R.labelFor)).to.deep.equal(["Builder", "Widget"]);
        // And a named rule set is not overwritten by its members.
        const all = await R.readAAOs(aao);
        const subAao = all.filter((a) => a.id === subId)[0];
        const effective = R.effectiveRules(subAao, await R.readProposals(aao, subId));
        expect(effective.voters.length, "the sub-AAO has 4 members but 2 voters").to.equal(2);
      });

    // The interim rule was keyed on "sub", and JD-build is a sub-organisation
    // too, so it was handed the widget-builder's rule from the day it existed
    // -- and could never escape, because the widget is not a member there and
    // so can never cast the vote that lifts it.
    it("keeps the interim rule on the organisation it was written for", function () {
      const sub = R.effectiveRules({ topic: "widget-builder", members: [] }, []);
      expect(sub.interim, "the widget has still never voted there").to.equal(true);
      expect(sub.voters.map(R.labelFor)).to.deep.equal(["Builder", "Wren"]);

      const build = R.effectiveRules({ topic: "JD-build", members: [] }, []);
      expect(build.interim, "no widget here, so nothing to stand in for").to.not.equal(true);
      expect(build.voters.map(R.labelFor)).to.deep.equal(["Kalam"]);
      expect(R.labelFor(build.casting)).to.equal("Kural");
      expect(R.labelFor(build.executeAs)).to.equal("Kural");
      expect(build.windowHours).to.equal(24);
    });

    // Proposal 52: an organisation that builds for another says so in its rule
    // set, and the page reads the tree off that one fact.
    it("names the organisation each builder's room builds for", function () {
      expect(R.parentOf({ topic: "widget-builder" })).to.equal("trilogy widget");
      expect(R.parentOf({ topic: "JD-build" })).to.equal("JD");
      expect(R.parentOf({ topic: "trilogy widget" })).to.equal(null);
      expect(R.parentOf({ topic: "JD" })).to.equal(null);
      // An organisation nobody has written a rule for builds for nobody.
      expect(R.parentOf({ topic: "no rule written" })).to.equal(null);
    });

    // Proposal 57. executeProposal passes on forVotes > againstVotes, so on a
    // proposal nobody has voted on it rejects -- and the button that did it
    // said only "Execute". A rejected proposal cannot be reopened.
    describe("Execute on a proposal nobody has voted on", function () {
      const at = (f, a, status) => ({ forVotes: f, againstVotes: a, status: status === undefined ? 0 : status });

      it("is not offered at 0-0, and says why in plain English", function () {
        const answer = R.executeOffered(R.rulesFor({ topic: "trilogy widget" }), at(0, 0));
        expect(answer.offered).to.equal(false);
        expect(answer.reason).to.contain("Nobody has voted");
        expect(answer.reason, "and it names the move that does mean no").to.contain("vote against");
      });

      it("is offered once there is a vote to act on, for or against", function () {
        expect(R.executeOffered(null, at(1, 0)).offered).to.equal(true);
        expect(R.executeOffered(null, at(0, 1)).offered).to.equal(true);
        expect(R.executeOffered(null, at(1, 1)).offered, "a tie is the casting vote's, not unoffered").to.equal(true);
      });

      it("is not offered on a proposal that is already closed", function () {
        expect(R.executeOffered(null, at(2, 0, 1)).offered).to.equal(false);
        expect(R.executeOffered(null, at(2, 0, 1)).reason).to.contain("Already");
      });

      it("is the rule execute-decided.js reads, so the script and the page agree",
        function () {
          const source = fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "execute-decided.js"), "utf8");
          expect(source, "the script must not carry its own copy of the rule").to.contain("R.executeOffered");
        });
    });
  });

  describe("what a dry run prints", function () {
    it("says the standing check and the exact transaction, and sends nothing", async function () {
      const plan = R.describePlan({
        standing: ["AAO 0: Wren is an ordinary voter.", "Proposal 3 exists and is Active."],
        from: R.WREN,
        call: "vote(3, true)",
        effect: "for -> tally would become 2-0",
        logFile: "governance/wren-votes.jsonl"
      });
      expect(plan).to.contain("Rehearsal only: nothing was sent.");
      expect(plan).to.contain("Add --send to do it for real");
      expect(plan).to.contain("Standing check");
      expect(plan).to.contain("Transaction that would be sent");
      expect(plan).to.contain("vote(3, true)");
      expect(plan).to.contain("Wren");
      expect(plan).to.contain("governance/wren-votes.jsonl");
    });
  });

  // The flag has to be wired, not merely present. Both halves of --dry-run went
  // missing in an edit once and the script sent a real vote while claiming to
  // rehearse, so this reads the source: the flag is declared, returned, and
  // checked before the send, in every script that writes.
  describe("--dry-run is actually wired, in every write script", function () {
    const scripts = [
      // Since proposal 30 the three vote scripts share one module, so the flag
      // is wired once and this reads it there. That is the point of the shared
      // module: one place to get this right, and one place to get it wrong.
      { dir: "governance", file: "vote.js", send: "connect(signer).vote(" },
      { dir: "scripts", file: "wren-decide.js", send: "appendFileSync(MESSAGES" },
      { dir: "scripts", file: "wren-file-draft.js", send: "connect(signer).submitProposal(" },
      { dir: "scripts", file: "propose.js", send: "connect(signer).submitProposal(" },
      // Proposal 99. It writes a file rather than a transaction, exactly as
      // wren-decide.js does, and rehearses for the same reason: the reminders
      // log is append-only, so a line written by mistake stays written.
      { dir: "scripts", file: "remind.js", send: "appendFileSync(file" }
    ];

    scripts.forEach(({ dir, file, send }) => {
      it(`${file} declares the flag, returns it, and checks it before it writes`, function () {
        const source = fs.readFileSync(
          path.join(__dirname, "..", "..", dir, file), "utf8");

        expect(source, "takes --dry-run").to.contain("--dry-run");

        // Declared, so it is not an accidental global.
        expect(
          /\b(?:var|let|const)\s+dryRun\b/.test(source) || /\bdryRun\s*:/.test(source),
          `${file} never declares dryRun`
        ).to.equal(true);

        // Checked, and checked before the write.
        const check = source.search(/if\s*\(\s*(?:args\.)?dryRun\s*\)/);
        expect(check, `${file} never checks dryRun`).to.be.greaterThan(-1);

        const writeAt = source.indexOf(send);
        expect(writeAt, `${file}: could not find its write (${send})`).to.be.greaterThan(-1);
        expect(check, `${file} checks dryRun after it writes`).to.be.lessThan(writeAt);

        // And the check returns rather than falling through.
        const after = source.slice(check, check + 900);
        expect(/\breturn\b/.test(after), `${file}'s dry run does not return`).to.equal(true);
      });
    });
  });

  // The safe path must be the one you get by doing nothing. It used to be the
  // one you had to remember, and twice it was not remembered: two real votes
  // went out with meaningless reasons on them, and neither could be taken back.
  describe("rehearsing is the default; sending takes --send", function () {
    // The three vote scripts decide through governance/vote.js since proposal
    // 30, so that is where their half of this is read.
    const WRITERS = [
      "../governance/vote.js", "wren-decide.js", "wren-file-draft.js",
      "propose.js", "submit-widget-proposals.js", "builder-propose.js",
      "execute-decided.js", "cut-aao-facet.js", "remind.js"
    ];

    it("wantsSend says no unless --send is there, and --dry-run always wins", function () {
      expect(R.wantsSend(["node", "s.js", "3", "for", "a reason"])).to.equal(false);
      expect(R.wantsSend(["node", "s.js", "--send"])).to.equal(true);
      expect(R.wantsSend(["node", "s.js", "--dry-run"])).to.equal(false);
      expect(R.wantsSend(["node", "s.js", "--send", "--dry-run"])).to.equal(false);
      expect(R.wantsSend([])).to.equal(false);
      expect(R.wantsSend(undefined)).to.equal(false);
    });

    WRITERS.forEach((file) => {
      it(`${file} rehearses unless it is told to send`, function () {
        const source = fs.readFileSync(
          path.join(__dirname, "..", "..", "scripts", file), "utf8");

        // It decides through the shared function, so one rule governs all of
        // them and a script cannot quietly opt itself out.
        expect(
          source.includes("R.wantsSend(") || source.includes("wantsSend(process.argv)"),
          `${file} does not ask wantsSend`
        ).to.equal(true);

        // And it never decides by looking for --dry-run alone, which would
        // make sending the default again.
        const decidesOnDryRunOnly =
          /=\s*process\.argv\.includes\("--dry-run"\)/.test(source) ||
          /dryRun\s*=\s*false\s*;/.test(source);
        expect(decidesOnDryRunOnly, `${file} still defaults to sending`).to.equal(false);
      });
    });
  });

  // Reading the source is not running it. The --send refactor left
  // wren-decide.js calling an R that no longer existed, and every source-
  // reading test still passed, because "R.wantsSend(" was right there in the
  // text. So this spawns each script for real and requires it to survive.
  //
  // It runs against the in-process hardhat network, never the live node: these
  // are writes, and the only reason it is safe to run them is that they
  // rehearse. If a script ever stopped rehearsing by default, this would send.
  // That is why the assertion is not only "exit 0" but "the chain did not move".
  describe("every write script runs its rehearsal end to end", function () {
    const { execFileSync } = require("child_process");
    const REPO = path.join(__dirname, "..", "..");

    let rpcUrl;
    let filedId;

    before(async function () {
      // The scripts talk to a chain over JSON-RPC, so they need one they can
      // reach. hardhat exposes the in-process node when the test run has it.
      rpcUrl = (hre.network.config && hre.network.config.url) || null;
      filedId = await submit(mainId, director, JSON.stringify({
        title: "A proposal for the rehearsals to aim at",
        summary: "Filed by the test so the scripts have something real to describe.",
        why: "A rehearsal against nothing proves nothing."
      }));
    });

    function run(file, args, env) {
      return execFileSync(
        process.execPath,
        [path.join(REPO, "scripts", file)].concat(args || []),
        {
          cwd: REPO,
          encoding: "utf8",
          timeout: 60000,
          env: Object.assign({}, process.env, env || {})
        }
      );
    }

    // The scripts that need no chain at all: they write files.
    const OFFLINE = [
      {
        file: "wren-decide.js",
        args: ["7", "queued behind the KBA work."],
        expect: /Rehearsal only: nothing was sent/
        },
      {
        file: "wren-answer.js",
        args: ["--list"],
        expect: /question|No questions/i
      },
      {
        file: "remind.js",
        args: ["list"],
        expect: /reminder|No reminders/i
      }
    ];

    OFFLINE.forEach(({ file, args, expect: pattern }) => {
      it(`${file} runs`, function () {
        const out = run(file, args);
        expect(out, `${file} said nothing`).to.be.a("string");
        expect(pattern.test(out), `${file} output was:\n${out}`).to.equal(true);
      });
    });

    it("wren-decide.js rehearses and writes nothing", function () {
      const log = path.join(REPO, "governance", "messages.jsonl");
      const before = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
      const out = run("wren-decide.js", ["7", "built in commit abcdef."]);
      const after = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
      expect(out).to.contain("Rehearsal only: nothing was sent.");
      expect(out).to.contain("Add --send to do it for real");
      expect(after, "wren-decide wrote to the log while rehearsing").to.equal(before);
    });

    // Proposal 99. --topic keeps it off the chain, so this proves the refusal
    // and the rehearsal without needing a node at all.
    it("remind.js rehearses a reminder and writes nothing", function () {
      const log = path.join(REPO, "governance", "reminders.jsonl");
      const before = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
      const out = run("remind.js", [
        "set", "61", "--due", "2026-12-01T00:00:00Z",
        "--text", "A rehearsed reminder that is never written.",
        "--topic", "JD", "--from", "kural"
      ]);
      const after = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
      expect(out).to.contain("Rehearsal only: nothing was sent.");
      expect(after, "remind.js wrote to the log while rehearsing").to.equal(before);
    });

    it("remind.js refuses anyone but the organisation's architect", function () {
      let failed = false;
      try {
        run("remind.js", [
          "set", "61", "--due", "2026-12-01T00:00:00Z", "--text", "Not mine to set.",
          "--topic", "JD", "--from", "kalam", "--send"
        ]);
      } catch (e) {
        failed = true;
        expect(String(e.stderr || e.message)).to.contain("Kural");
      }
      expect(failed, "remind.js let a builder set a reminder on JD").to.equal(true);
    });

    it("wren-file-draft.js runs and lists without writing", function () {
      const log = path.join(REPO, "governance", "drafts.jsonl");
      const before = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
      const out = run("wren-file-draft.js", ["--list"]);
      const after = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
      expect(out).to.be.a("string");
      expect(after, "wren-file-draft wrote while listing").to.equal(before);
    });

    it("propose.js rehearses against no chain at all", function () {
      const out = run("propose.js", [
        "--title", "A rehearsed proposal",
        "--summary", "This one is never filed; the run only says what it would do.",
        "--why", "Because a rehearsal has to be able to run without a chain."
      ]);
      expect(out).to.contain("A rehearsed proposal");
      expect(out).to.contain("nothing filed");
    });

    it("propose.js refuses an incomplete proposal, rehearsal or not", function () {
      let failed = false;
      try {
        run("propose.js", ["--title", "No why on this one", "--summary", "s"]);
      } catch (e) {
        failed = true;
        expect(String(e.stderr || e.message)).to.contain("why is required");
      }
      expect(failed, "propose.js filed something with no why").to.equal(true);
    });

    // The chain-reading ones need an RPC url. When the test run has no node to
    // point them at, they are skipped rather than silently passing.
    const ONCHAIN = [
      { file: "wren-vote.js", args: () => [String(filedId), "for", "a rehearsed reason"] },
      { file: "builder-vote.js", args: () => ["--aao", "0", String(filedId), "for", "a rehearsed reason"] },
      // Added by proposal 30: the widget's script, which cost five lines.
      { file: "widget-vote.js", args: () => ["--aao", "1", String(filedId), "for", "a rehearsed reason"] },
      { file: "execute-decided.js", args: () => [], env: () => ({ IDS: String(filedId) }) }
    ];

    ONCHAIN.forEach(({ file, args, env }) => {
      it(`${file} rehearses without sending`, function () {
        // Its own throwaway chain, so a refusal is the expected outcome.
        let out;
        try {
          out = run(file, args(), Object.assign({ HARDHAT_NETWORK: "hardhat" }, env ? env() : {}));
        } catch (e) {
          // A refusal is a valid outcome and still proves the script runs;
          // a crash is not.
          const text = String(e.stderr || e.stdout || e.message);
          expect(text, `${file} crashed rather than refused`).to.not.match(/is not defined|Cannot read|SyntaxError/);
          return;
        }
        expect(out, `${file} output was:\n${out}`).to.not.match(/\btx 0x/);
      });
    });
  });

  // The regression that got past the source-reading tests: the --send refactor
  // left wren-decide.js calling an R that no longer existed. Every script in
  // the repo is now run with no arguments, which takes it through require,
  // parse and its own usage path. A module-level mistake cannot survive that.
  describe("every script loads", function () {
    const { execFileSync } = require("child_process");
    const REPO = path.join(__dirname, "..", "..");

    const ALL = [
      "wren-vote.js", "builder-vote.js", "widget-vote.js", "wren-decide.js", "wren-answer.js",
      "wren-file-draft.js", "propose.js", "submit-widget-proposals.js",
      "builder-propose.js", "execute-decided.js", "cut-aao-facet.js",
      "snapshot-chain-state.js", "verify-after-cut.js",
      "check-control-characters.js", "setup-governance-members.js",
      "create-widget-builder-aao.js", "remind.js", "phone.js"
    ];

    // phone.js writes the file that holds the Director's topic, so this run is
    // pointed at a throwaway path. A test that generated a topic into his home
    // directory would be a test that changed his setup.
    const phoneStore = path.join(
      fs.mkdtempSync(path.join(require("os").tmpdir(), "peoplenet-phone-")), "url");

    ALL.forEach((file) => {
      it(`${file} gets past its own require and argument parsing`, function () {
        let output = "";
        try {
          output = execFileSync(process.execPath, [path.join(REPO, "scripts", file)], {
            cwd: REPO,
            encoding: "utf8",
            timeout: 60000,
            env: Object.assign({}, process.env, {
              HARDHAT_NETWORK: "hardhat",
              PEOPLENET_PHONE_STORE: phoneStore,
              // And it must not pick up a real topic from this machine either.
              PEOPLENET_NTFY_URL: ""
            })
          });
        } catch (e) {
          // Exiting non-zero is fine -- most of these want arguments. Dying
          // while loading is not.
          output = String(e.stdout || "") + String(e.stderr || "");
        }
        expect(output, `${file} failed to load:\n${output}`).to.not.match(
          /ReferenceError|is not defined|SyntaxError|Cannot find module/
        );
      });
    });
  });

  // --- proposal 59 -------------------------------------------------------

  describe("what an agent is doing now, in three words", function () {
    const P = require("../../governance/protocol.js");
    const base = { from: "kalam", type: "status", subject: "S", summary: "A sentence for a person." };
    const withNow = (now) => Object.assign({}, base, { now: now });

    it("takes three words or fewer", function () {
      expect(P.validate(withNow("building the dashboard")).ok).to.equal(true);
      expect(P.validate(withNow("resting")).ok).to.equal(true);
      expect(P.validate(withNow("two words")).ok).to.equal(true);
    });

    it("refuses a fourth word, and says how many it counted", function () {
      const result = P.validate(withNow("building the swarm dashboard"));
      expect(result.ok).to.equal(false);
      expect(result.errors.join(" ")).to.contain("3 words or fewer");
      expect(result.errors.join(" "), "the count is what makes it actionable").to.contain("is 4");
    });

    it("refuses a now that is not a string, or is only whitespace", function () {
      expect(P.validate(withNow(7)).ok).to.equal(false);
      expect(P.validate(withNow("   ")).ok).to.equal(false);
    });

    it("leaves every message written before it valid", function () {
      expect(P.validate(base).ok, "absent is fine").to.equal(true);
      expect(P.validate(Object.assign({}, base, { now: null })).ok, "null is absent").to.equal(true);
    });

    it("stays out of the message id, so a retry keeps its number", function () {
      expect(P.messageId(base)).to.equal(P.messageId(withNow("building the dashboard")));
      expect(P.ID_FIELDS).to.not.contain("now");
    });

    it("is checked wherever it appears, not only on a status message", function () {
      const decision = Object.assign({}, base, { type: "decision", now: "one two three four" });
      expect(P.validate(decision).ok).to.equal(false);
    });

    it("survives normalise, which must not drop a field the writer set", function () {
      expect(P.normalise(withNow("reading the chain")).now).to.equal("reading the chain");
    });
  });

  describe("blocked, a state of its own", function () {
    const decide = (summary) => A.adoptionOf(
      A.indexDecisions([{ type: "decision", refs: ["proposal 9"], summary: summary }]), 9);

    it("reads a block and parses who it waits on and for what", function () {
      const a = decide("blocked: waiting on the Director for the Hetzner API token");
      expect(a.state.key).to.equal("blocked");
      expect(A.isBlocked(a)).to.equal(true);
      expect(A.blockedOn(a).who).to.equal("the Director");
      expect(A.blockedOn(a).what).to.equal("the Hetzner API token");
    });

    it("is not 'waiting': one is a choice to defer, the other is somebody else's move",
      function () {
        expect(decide("blocked: waiting on Wren for the facet cut").state.key).to.equal("blocked");
        expect(decide("waiting: not until the Postman work lands").state.key).to.equal("waiting");
        expect(A.blockedOn(decide("waiting: not yet"))).to.equal(null);
      });

    it("fills what it can when the phrase is only half there", function () {
      expect(A.blockedOn(decide("blocked: waiting on Wren")).who).to.equal("Wren");
      expect(A.blockedOn(decide("blocked: waiting on Wren")).what).to.equal("");
      expect(A.blockedOn(decide("blocked: the node is down")).what).to.equal("the node is down");
    });

    it("is superseded by a later building or built, with no extra rule", function () {
      const log = [
        { type: "decision", ts: "2026-01-01T00:00:00Z", refs: ["proposal 9"],
          summary: "blocked: waiting on the Director for the token" },
        { type: "decision", ts: "2026-01-02T00:00:00Z", refs: ["proposal 9"],
          summary: "building the thing now that the token is in." }
      ];
      const latest = A.indexDecisions(log);
      expect(A.stateOf(latest[9]).key).to.equal("building");
      expect(A.isBlocked(A.adoptionOf(latest, 9))).to.equal(false);
      // And the block is still in the history, which is what append-only means.
      expect(A.historyFor(log, 9).map((m) => A.stateOf(m).key)).to.deep.equal(["blocked", "building"]);
    });

    it("does not read a passing mention of a block as the state", function () {
      expect(decide("Built in commit abc; the blocked path is gone.").state.key).to.equal("built");
    });
  });

  describe("what the swarm dashboard shows", function () {
    const S = require("../../governance/swarm.js");
    const AAOS = [
      { id: 0, topic: "trilogy widget" }, { id: 1, topic: "widget-builder" },
      { id: 2, topic: "JD" }, { id: 3, topic: "JD-build" }
    ];
    const titled = (id, aaoId, status, title) =>
      ({ id, aaoId, status, createdAt: 1758000000, text: JSON.stringify({ title }) });

    const PROPOSALS = [
      titled(50, 2, 0, "Chain to the cloud"),
      titled(55, 1, 1, "A syntax check for the markup"),
      titled(58, 2, 1, "The watcher executes"),
      titled(59, 2, 1, "A swarm dashboard"),
      titled(60, 2, 0, "Blocked on the Director: the Hetzner API token"),
      titled(61, 2, 0, "Blocked on the Director: the Mac and the four chat exports"),
      titled(99, 2, 1, "Blocked on the Director: already cleared by his vote")
    ];
    const MESSAGES = [
      { type: "decision", ts: "2026-09-19T01:00:00Z", refs: ["proposal 50"],
        summary: "blocked: waiting on the Director for the Hetzner API token" },
      { type: "decision", ts: "2026-09-19T02:00:00Z", refs: ["proposal 59"],
        summary: "building: the swarm dashboard" },
      { type: "decision", ts: "2026-09-19T03:00:00Z", refs: ["proposal 58"],
        summary: "Built in commit 1ee02d5." },
      { type: "decision", ts: "2026-09-19T04:00:00Z", refs: ["proposal 55"],
        summary: "blocked: waiting on Wren for the facet cut" },
      { from: "kalam", type: "status", ts: "2026-09-19T08:00:00Z", now: "building the dashboard",
        subject: "s", summary: "p" },
      { from: "kural", type: "status", ts: "2026-09-19T02:00:00Z", now: "reviewing 59",
        subject: "s", summary: "p" }
    ];
    const NOW = Date.parse("2026-09-19T08:30:00Z");
    const data = () => S.dashboard(MESSAGES, PROPOSALS, AAOS, NOW);

    it("sorts the Director's own blocks to the top of the Blocked column", function () {
      const blocked = data().blocked;
      const directors = blocked.filter((r) => r.directors).map((r) => r.proposalId);
      const others = blocked.filter((r) => !r.directors).map((r) => r.proposalId);
      expect(directors).to.deep.equal([50, 60, 61]);
      expect(others).to.deep.equal([55]);
      expect(blocked.map((r) => r.proposalId), "his first, in id order")
        .to.deep.equal([50, 60, 61, 55]);
    });

    it("says who each block waits on and for what", function () {
      const byId = {};
      data().blocked.forEach((r) => { byId[r.proposalId] = r; });
      expect(byId[50].who).to.equal("the Director");
      expect(byId[50].what).to.equal("the Hetzner API token");
      expect(byId[55].who).to.equal("Wren");
      expect(byId[55].what).to.equal("the facet cut");
      expect(byId[61].what).to.equal("the Mac and the four chat exports");
    });

    it("reads an open 'Blocked on the Director' proposal as a block, and a closed one as cleared",
      function () {
        const ids = data().blocked.map((r) => r.proposalId);
        expect(ids, "open").to.contain(60);
        expect(ids, "executed, so the block has cleared").to.not.contain(99);
      });

    it("marks where a block came from, because that is how it ends", function () {
      const byId = {};
      data().blocked.forEach((r) => { byId[r.proposalId] = r; });
      expect(byId[60].source, "his vote clears it").to.equal("proposal");
      expect(byId[55].source, "a later decision clears it").to.equal("decision");
    });

    it("puts building in Building and built in Done, and neither in the other", function () {
      const d = data();
      expect(d.building.map((r) => r.proposalId)).to.deep.equal([59]);
      expect(d.done.map((r) => r.proposalId)).to.deep.equal([58]);
    });

    it("gives every row the organisation it belongs to, and a title to click", function () {
      const row = data().building[0];
      expect(row.organisation).to.equal("JD");
      expect(row.title).to.equal("A swarm dashboard");
      expect(row.aaoId).to.equal(2);
    });

    it("shows the latest now per agent, with its age", function () {
      const street = data().street;
      const kalam = street.filter((a) => a.key === "kalam")[0];
      expect(kalam.now).to.equal("building the dashboard");
      expect(kalam.ageMs).to.equal(30 * 60 * 1000);
      expect(kalam.silent).to.equal(false);
    });

    it("greys an agent silent over an hour, and one never heard from", function () {
      const street = data().street;
      const kural = street.filter((a) => a.key === "kural")[0];
      expect(kural.silent, "six hours ago").to.equal(true);
      const wren = street.filter((a) => a.key === "wren")[0];
      expect(wren.now, "never posted one").to.equal("");
      expect(wren.silent).to.equal(true);
    });

    it("keeps the Director off the street: he is who it is for", function () {
      const keys = data().street.map((a) => a.key);
      expect(keys).to.not.contain("director");
      expect(keys).to.not.contain("casting");
      expect(keys).to.contain("kalam");
    });

    it("names each agent's organisation from the rule sets, not from membership",
      function () {
        expect(S.organisationOf(R.KURAL), "the architect on JD").to.equal("JD");
        expect(S.organisationOf(R.WREN), "the architect on the main organisation")
          .to.equal("trilogy widget");
        expect(S.organisationOf(R.BUILDER), "a voter, not an architect").to.equal("widget-builder");
      });

    it("shows the chain alone when the message log is missing", function () {
      const d = S.dashboard([], PROPOSALS, AAOS, NOW);
      expect(d.blocked.map((r) => r.proposalId), "his filed blocks still read")
        .to.deep.equal([60, 61]);
      expect(d.building).to.deep.equal([]);
      expect(d.street.length, "every agent still gets a line").to.be.greaterThan(0);
    });
  });

  // Proposal 95. The Director is the only human and his attention is the
  // scarce thing. A vote view padded with what he has already deferred teaches
  // him to skim it, and a skimmed list is how proposal 54 went unnoticed for
  // two days. The risk runs one way: anything unreadable stays in the vote
  // view, because a proposal wrongly hidden is hidden from the one person who
  // must see it.
  describe("the Director's three views", function () {
    const W = require("../../governance/watch.js");

    const doc = (fields) => JSON.stringify(fields);
    const active = (id, fields) => ({
      id, aaoId: 2, status: 0, createdAt: 1789000000,
      text: doc(fields || { title: "Proposal " + id }),
      format: { doc: Object.assign({ title: "Proposal " + id }, fields || {}) }
    });
    const said = (id, summary, from) => ({
      from: from || "kural", to: "director", type: "decision",
      ts: "2026-09-21T0" + (id % 9) + ":00:00Z",
      subject: "Proposal " + id, summary: summary, refs: ["proposal " + id]
    });
    const view = (proposals, messages) =>
      R.viewsFor(proposals, messages || [], { triggerOf: (p) => p.format.doc.trigger });

    it("puts a proposal nobody has parked in the vote view", function () {
      expect(view([active(87)])[87]).to.equal("vote");
    });

    it("reads waiting and blocked, from anyone, as waiting", function () {
      const ps = [active(60), active(61)];
      const ms = [
        said(60, "waiting: kept open on the Director's request until Friday"),
        said(61, "blocked: waiting on the Director for the Mac", "kalam")
      ];
      const v = view(ps, ms);
      expect(v[60]).to.equal("waiting");
      expect(v[61], "a block is a wait on somebody").to.equal("waiting");
    });

    it("reads a decision that starts closed as closed", function () {
      const v = view([active(88)], [said(88, "closed: superseded by proposal 95")]);
      expect(v[88]).to.equal("closed");
    });

    it("keeps a proposal with an unfired trigger out of the vote view", function () {
      const p = active(93, { trigger: { text: "in a week", rule: "date:2026-09-28" } });
      expect(view([p])[93]).to.equal("waiting");
    });

    it("brings it back the moment the trigger fires", function () {
      const p = active(93, { trigger: { text: "in a week", rule: "date:2026-09-28" } });
      const fired = [{ from: "watch", to: "director", type: "status", proposal: 93,
        ts: "2026-09-28T00:00:00Z", subject: "Proposal 93", summary: "It has: the date passed." }];
      expect(view([p], fired)).to.deep.equal({ 93: "vote" });
    });

    it("does not read an unclaimed notice as a fired trigger", function () {
      const p = active(93, { trigger: { text: "in a week", rule: "date:2026-09-28" } });
      const notice = [{ from: "watch", to: "kural", type: "status", proposal: 93, unclaimed: true,
        ts: "2026-09-22T00:00:00Z", subject: "Proposal 93", summary: "nobody picked it up" }];
      expect(view([p], notice)[93], "still waiting on its own trigger").to.equal("waiting");
      expect(R.triggerHasFired(notice, 93)).to.equal(null);
    });

    it("finds a tie in the document and in a decision, either phrasing", function () {
      expect(R.tieIn("This is part of proposal 87.")).to.equal(87);
      expect(R.tieIn("Tied to Proposal #87")).to.equal(87);
      expect(R.tieIn("proposal 87 says otherwise"), "a mention is not a tie").to.equal(null);
      const p = active(86, { why: "Tied to proposal 87." });
      expect(R.tieTargetOf(p, [])).to.equal(87);
      expect(R.tieTargetOf(active(86), [said(86, "queued: part of proposal 87")])).to.equal(87);
    });

    it("moves a tied proposal with the one it is part of, and back with it", function () {
      const ps = [active(86, { why: "Tied to proposal 87." }), active(87)];
      expect(view(ps)[86], "87 needs a vote, so 86 does too").to.equal("vote");

      const parked = [said(87, "waiting: the Director asked to hold this until Friday")];
      const v = view(ps, parked);
      expect(v[87]).to.equal("waiting");
      expect(v[86], "it goes with its parent").to.equal("waiting");
    });

    it("does not close a tied proposal because its parent closed", function () {
      const ps = [active(86, { why: "Tied to proposal 87." }), active(87)];
      const v = view(ps, [said(87, "closed: superseded by proposal 95")]);
      expect(v[87]).to.equal("closed");
      expect(v[86], "only its own decision closes it").to.equal("vote");
    });

    it("survives two proposals each saying they are part of the other", function () {
      const ps = [active(1, { why: "part of proposal 2" }), active(2, { why: "part of proposal 1" })];
      const v = view(ps);
      expect(v).to.deep.equal({ 1: "vote", 2: "vote" });
    });

    it("leaves anything it cannot read in the vote view", function () {
      const v = view([active(70)], [said(70, "I had a look at this one.")]);
      expect(v[70]).to.equal("vote");
    });

    it("gives /swarm the same answer as the page", function () {
      const S = require("../../governance/swarm.js");
      const ps = [active(60), active(87)];
      const ms = [said(60, "waiting: until Friday")];
      const d = S.dashboard(ms, ps, [{ id: 2, topic: "JD" }], Date.now());
      expect(d.views).to.deep.equal(view(ps, ms));
    });

    describe("the watcher leaves a closed proposal's trigger alone", function () {
      const os = require("os");
      let messagesFile;

      const withTrigger = (id, status) => Object.assign(
        active(id, { trigger: { text: "in a week", rule: "date:2020-01-01" } }), { status: status });

      beforeEach(function () {
        messagesFile = path.join(os.tmpdir(),
          "governance-closed-trigger-" + Date.now() + "-" + Math.random().toString(16).slice(2) + ".jsonl");
      });
      afterEach(function () {
        if (messagesFile && fs.existsSync(messagesFile)) fs.unlinkSync(messagesFile);
      });

      it("fires a trigger on an Active proposal nobody has closed", async function () {
        const out = await W.runOnce([withTrigger(93, 0)], { messagesFile });
        expect(out.fired.map((f) => f.proposal)).to.deep.equal([93]);
      });

      it("skips one whose latest decision is closed, and says why", async function () {
        fs.writeFileSync(messagesFile, JSON.stringify({
          id: "d-1", from: "kural", to: "director", type: "decision", ts: "2026-09-21T05:26:00Z",
          subject: "Proposal 93", summary: "closed: superseded by proposal 98", refs: ["proposal 93"]
        }) + "\n", "utf8");
        const out = await W.runOnce([withTrigger(93, 0)], { messagesFile });
        expect(out.fired).to.deep.equal([]);
        expect(out.looked).to.deep.equal([{ id: 93, fired: false, because: "closed" }]);
      });

      it("skips one whose chain status is not Active", async function () {
        const out = await W.runOnce([withTrigger(94, 1)], { messagesFile });
        expect(out.fired).to.deep.equal([]);
        expect(out.looked[0].because).to.equal("closed");
        expect(fs.existsSync(messagesFile), "nothing was written").to.equal(false);
      });

      it("reads closed the same way the card does", function () {
        expect(W.skipBecause(withTrigger(93, 0), []), "nothing said").to.equal(null);
        expect(W.skipBecause(withTrigger(93, 2), []), "rejected on chain").to.equal("closed");
      });
    });
  });

  // Proposal 91's one addition to proposal 54: a pasted screenshot may carry a
  // customer's name or a credential, and .gitignore is a line anyone can
  // delete. The directory is outside the repository, and one inside it is
  // refused rather than obeyed.
  describe("where a pasted screenshot may be written", function () {
    const D = require("../../governance/inbox-dir.js");
    const os = require("os");

    it("defaults outside the repository", function () {
      const chosen = D.inboxRoot({});
      expect(D.isInside(D.REPO, chosen.root), "inside the repository").to.equal(false);
      expect(chosen.root).to.equal(D.DEFAULT_ROOT);
      expect(chosen.refused).to.equal(null);
    });

    it("honours a directory outside the repository, named either way", function () {
      const outside = path.join(os.tmpdir(), "peoplenet-image-check");
      expect(D.inboxRoot({ GOVERNANCE_INBOX_DIR: outside }).root).to.equal(path.resolve(outside));
      expect(D.inboxRoot({ GOVERNANCE_LOG_DIR: outside }).root,
        "the checks move the images with the logs").to.equal(path.resolve(outside));
      expect(D.inboxRoot({ GOVERNANCE_INBOX_DIR: outside }).from).to.equal("GOVERNANCE_INBOX_DIR");
    });

    it("refuses a directory inside the repository, and says why in one sentence", function () {
      const inside = path.join(D.REPO, "governance");
      const chosen = D.inboxRoot({ GOVERNANCE_INBOX_DIR: inside });
      expect(chosen.root, "falls back to the safe default").to.equal(D.DEFAULT_ROOT);
      expect(chosen.refused).to.be.a("string");
      expect(chosen.refused).to.contain("inside the repository");
      expect(chosen.refused).to.contain(D.DEFAULT_ROOT);
    });

    it("refuses a path that climbs back into the repository", function () {
      const climbed = path.join(D.REPO, "..", path.basename(D.REPO), "governance", "inbox");
      expect(D.inboxRoot({ GOVERNANCE_LOG_DIR: climbed }).root).to.equal(D.DEFAULT_ROOT);
    });

    it("deletes the file the server wrote, not one beside the log", function () {
      const os2 = require("os");
      const filing = require("../../scripts/wren-file-draft.js");
      const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "peoplenet-discard-"));
      fs.mkdirSync(path.join(dir, "inbox"));
      const file = path.join(dir, "inbox", "draft-x.png");
      fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const draft = {
        id: "draft-x",
        image: { path: "inbox/draft-x.png", bytes: 4, type: "image/png", sha256: "c".repeat(64) }
      };

      const asked = [];
      filing.discardDraftImage(draft, { dir: dir, unlink: (f) => asked.push(f) });
      expect(asked).to.deep.equal([file]);

      // With no directory given it asks the same function the server asks, so
      // the file it would delete is the file the server wrote.
      const fallback = filing.discardDraftImage(draft, { rehearsal: true });
      expect(fallback.file).to.equal(path.join(D.inboxRoot().root, "inbox", "draft-x.png"));
    });
  });

  // Proposal 91. Proposal 54 passed on 2026-09-19 and nothing noticed for two
  // days, because every column on the dashboard is built from agents' decision
  // messages and no agent had written one. These pin the list that finds them.
  describe("passed, and nobody picked it up", function () {
    const S = require("../../governance/swarm.js");
    const W = require("../../governance/watch.js");
    const os = require("os");

    const NOW = Date.parse("2026-09-21T12:00:00Z");
    const HOUR = 3600 * 1000;
    const AAOS = [
      { id: 0, topic: "trilogy widget" }, { id: 2, topic: "JD" }, { id: 3, topic: "JD-build" }
    ];

    // A proposal executed `hoursAgo` hours before NOW. executedAt is in seconds,
    // as the chain reports it.
    const passed = (id, aaoId, title, hoursAgo) => ({
      id, aaoId, status: 1, createdAt: Math.floor((NOW - 48 * HOUR) / 1000),
      executedBlock: 200 + id,
      executedAt: Math.floor((NOW - hoursAgo * HOUR) / 1000),
      text: JSON.stringify({ title })
    });

    const list = (messages, proposals) =>
      S.unclaimed(messages || [], proposals, AAOS, NOW).map((r) => r.proposalId);

    it("lists a passed proposal no agent has spoken about for over four hours", function () {
      const rows = S.unclaimed([], [passed(54, 0, "Paste a screenshot", 50)], AAOS, NOW);
      expect(rows.map((r) => r.proposalId)).to.deep.equal([54]);
      const row = rows[0];
      expect(row.organisation).to.equal("trilogy widget");
      expect(row.title).to.equal("Paste a screenshot");
      expect(row.architect, "who is told, from the rule set").to.equal("Wren");
      expect(Math.round(row.waitedMs / HOUR)).to.equal(50);
    });

    it("draws the four-hour line where the Director set it", function () {
      const early = passed(70, 2, "Three hours and fifty-nine minutes", 3.983);
      const late = passed(71, 2, "Four hours and one minute", 4.017);
      expect(list([], [early]), "not yet four hours").to.deep.equal([]);
      expect(list([], [late]), "past four hours").to.deep.equal([71]);
    });

    it("drops a proposal any agent has posted a decision on", function () {
      const proposals = [passed(54, 0, "Paste a screenshot", 50), passed(58, 2, "The watcher executes", 50)];
      const claimed = [
        { from: "kalam", type: "decision", ts: "2026-09-19T03:00:00Z",
          refs: ["proposal 58"], subject: "s", summary: "Built in commit 1ee02d5." }
      ];
      expect(list(claimed, proposals)).to.deep.equal([54]);
    });

    it("counts a claim whatever the decision says, even a block or a wait", function () {
      const proposals = [passed(60, 2, "Chain to the cloud", 50)];
      const blocked = [
        { from: "kural", type: "decision", ts: "2026-09-19T01:00:00Z", refs: ["proposal 60"],
          subject: "s", summary: "blocked: waiting on the Director for the Hetzner token" }
      ];
      expect(list(blocked, proposals), "somebody is holding it").to.deep.equal([]);
    });

    it("does not let the watcher's own decision claim a proposal", function () {
      const proposals = [passed(95, 3, "Three lists", 50)];
      const watchers = [
        { from: "watch", type: "decision", ts: "2026-09-20T01:00:00Z", refs: ["proposal 95"],
          subject: "s", summary: "Built into the record: it passed 1 to 0." }
      ];
      expect(list(watchers, proposals), "the watcher executes; it does not build")
        .to.deep.equal([95]);
    });

    it("lists only what passed: not an open proposal, not a rejected one", function () {
      const open = Object.assign(passed(80, 2, "Still being voted on", 50), { status: 0 });
      const rejected = Object.assign(passed(81, 2, "Voted down", 50), { status: 2 });
      expect(list([], [open, rejected, passed(82, 2, "Passed", 50)])).to.deep.equal([82]);
    });

    it("puts the longest wait first", function () {
      const rows = list([], [passed(1, 2, "a", 5), passed(2, 2, "b", 40), passed(3, 2, "c", 9)]);
      expect(rows).to.deep.equal([2, 3, 1]);
    });

    it("leads the dashboard, above Blocked", function () {
      const d = S.dashboard([], [passed(54, 0, "Paste a screenshot", 50)], AAOS, NOW);
      var keys = Object.keys(d);
      expect(keys.indexOf("unclaimed"), "before Blocked").to.be.lessThan(keys.indexOf("blocked"));
      expect(d.unclaimed.map((r) => r.proposalId)).to.deep.equal([54]);
    });

    describe("the watcher tells the architect, once", function () {
      let messagesFile;

      const read = () => (fs.existsSync(messagesFile)
        ? fs.readFileSync(messagesFile, "utf8").split(/\r?\n/).filter(Boolean).map(JSON.parse)
        : []);

      beforeEach(function () {
        messagesFile = path.join(os.tmpdir(), "governance-unclaimed-" + Date.now() + "-" + Math.random().toString(16).slice(2) + ".jsonl");
      });

      afterEach(function () {
        if (messagesFile && fs.existsSync(messagesFile)) fs.unlinkSync(messagesFile);
      });

      const run = (proposals) =>
        W.reportUnclaimed(proposals, AAOS, { messagesFile, nowMs: NOW });

      it("posts one message to the organisation's architect", function () {
        const result = run([passed(54, 0, "Paste a screenshot", 50)]);
        expect(result.told.map((t) => t.proposal)).to.deep.equal([54]);
        const posted = read();
        expect(posted.length).to.equal(1);
        expect(posted[0].from).to.equal("watch");
        expect(posted[0].to, "Wren is the architect on the trilogy widget").to.equal("wren");
        expect(posted[0].subject).to.contain("54");
        expect(posted[0].unclaimed).to.equal(true);
      });

      it("tells Kural about a proposal on JD, and Wren about one on the widget", function () {
        run([passed(54, 0, "Paste a screenshot", 50), passed(91, 2, "Deliver 54", 50)]);
        const to = {};
        read().forEach((m) => { to[m.proposal] = m.to; });
        expect(to).to.deep.equal({ 54: "wren", 91: "kural" });
      });

      it("says it once, however many times the watcher runs", function () {
        const proposals = [passed(54, 0, "Paste a screenshot", 50)];
        run(proposals);
        const second = run(proposals);
        expect(second.told, "already reported").to.deep.equal([]);
        expect(second.listed.map((r) => r.proposalId), "still listed on the page")
          .to.deep.equal([54]);
        expect(read().length).to.equal(1);
      });

      it("says nothing about a proposal an agent has claimed", function () {
        fs.writeFileSync(messagesFile, JSON.stringify({
          id: "decision-1", from: "kalam", to: "all", type: "decision",
          ts: "2026-09-20T01:00:00Z", subject: "Proposal 54", refs: ["proposal 54"],
          summary: "building: the screenshot paste"
        }) + "\n", "utf8");
        const result = run([passed(54, 0, "Paste a screenshot", 50)]);
        expect(result.listed).to.deep.equal([]);
        expect(result.told).to.deep.equal([]);
        expect(read().length, "nothing appended").to.equal(1);
      });

      it("leaves a proposal's trigger free to fire after an unclaimed notice", function () {
        run([passed(54, 0, "Paste a screenshot", 50)]);
        expect(W.alreadyFired(read(), 54),
          "an unclaimed notice is not a fired trigger").to.equal(false);
        expect(W.alreadyToldUnclaimed(read(), 54)).to.equal(true);
      });
    });
  });

  // The kolam is not wired into the page: the Director sees the samples first.
  // These pin the rules a pulli kolam has to obey, because a drawing that
  // quietly breaks them is worse than no drawing.
  describe("the kolam a chain address draws", function () {
    const K = require("../../governance/swarm/kolam.js");
    const KALAM = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";

    // Every point of the line, sampled, so the rules can be measured.
    function trace(k) {
      const points = [];
      const turn = (v) => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      k.loop.forEach((step) => {
        const piece = k.arcs[step.arc];
        const from = K.pointOf(step.from, k.grid);
        const to = K.pointOf(step.to, k.grid);
        const a0 = Math.atan2(from.y - piece.cy, from.x - piece.cx);
        const a1 = Math.atan2(to.y - piece.cy, to.x - piece.cx);
        const sweep = step.from === piece.a ? piece.sweep : 1 - piece.sweep;
        const span = sweep === 1 ? turn(a1 - a0) : -turn(a0 - a1);
        for (let i = 0; i < 24; i++) {
          const angle = a0 + (span * i) / 24;
          points.push([piece.cx + piece.r * Math.cos(angle), piece.cy + piece.r * Math.sin(angle)]);
        }
      });
      return points;
    }

    it("is one continuous closed line, not several", function () {
      const k = K.kolam(KALAM);
      expect(K.loopsOf(k.arcs).length).to.equal(1);
      expect(k.loop.length, "and it uses every arc in the figure").to.equal(k.arcs.length);
      const start = K.pointOf(k.loop[0].from, k.grid);
      const end = K.pointOf(k.loop[k.loop.length - 1].to, k.grid);
      expect(start).to.deep.equal(end);
    });

    it("never touches a dot: it circles each one at a constant distance", function () {
      const k = K.kolam(KALAM);
      const points = trace(k);
      let nearest = Infinity;
      k.dots.forEach((dot) => points.forEach((p) => {
        nearest = Math.min(nearest, Math.hypot(p[0] - dot.x, p[1] - dot.y));
      }));
      expect(nearest).to.be.closeTo(k.grid.unit / 2, 0.001);
    });

    it("is symmetric under a half turn, to the point", function () {
      const k = K.kolam(KALAM);
      const points = trace(k);
      const key = (p) => Math.round(p[0] * 4) / 4 + "," + Math.round(p[1] * 4) / 4;
      const drawn = new Set(points.map(key));
      const centre = k.size / 2;
      const missing = points
        .map((p) => [2 * centre - p[0], 2 * centre - p[1]])
        .filter((p) => !drawn.has(key(p)));
      expect(missing.length, "every point's opposite is on the line too").to.equal(0);
    });

    it("draws the same kolam for the same address, and a different one for another",
      function () {
        expect(K.kolam(KALAM).path).to.equal(K.kolam(KALAM).path);
        expect(K.kolam(KALAM).path).to.not.equal(K.kolam(R.KURAL).path);
        expect(K.kolam(KALAM).path, "the address is not case sensitive on chain")
          .to.equal(K.kolam(KALAM.toLowerCase()).path);
      });

    it("draws one for any address, not just the lucky ones", function () {
      for (let i = 0; i < 25; i++) {
        const address = "0x" + require("crypto").createHash("sha1").update("agent" + i)
          .digest("hex").slice(0, 40);
        expect(K.loopsOf(K.kolam(address).arcs).length, address).to.equal(1);
      }
    });

    it("refuses an even grid, which cannot be joined into one loop", function () {
      // A half turn pairs every cell with another, so flips come two at a time
      // and the loop count keeps its parity. The odd grid's centre cell is its
      // own partner, and that single flip is what makes one loop reachable.
      expect(() => K.kolam(KALAM, { cells: 6 })).to.throw(/odd/);
    });

    it("closes the line when idle, leaves it part drawn when working", function () {
      const idle = K.toSVG(KALAM, { state: "idle" });
      const working = K.toSVG(KALAM, { state: "working", progress: 0.45 });
      expect(idle).to.contain(" Z");
      expect(idle).to.not.contain("stroke-dasharray");
      expect(working).to.contain("stroke-dasharray");
    });

    it("opens the line at a lit dot when blocked", function () {
      const k = K.kolam(KALAM);
      const open = K.openPath(k);
      expect(open.path, "an open line has no close command").to.not.contain(" Z");
      expect(
        k.dots.some((d) => Math.abs(d.x - open.lit.x) < 0.01 && Math.abs(d.y - open.lit.y) < 0.01),
        "and it stops at a real dot, not at a point in the air"
      ).to.equal(true);
      expect(K.toSVG(KALAM, { state: "blocked" })).to.contain("#a8322a");
    });

    it("writes an SVG that stands on its own", function () {
      const svg = K.toSVG(KALAM);
      expect(svg.indexOf("<svg xmlns=")).to.equal(0);
      expect(svg).to.contain("</svg>");
      expect((svg.match(/<circle/g) || []).length, "one per dot").to.equal(K.kolam(KALAM).dots.length);
      expect((svg.match(/<path/g) || []).length, "one line").to.equal(1);
    });
  });

  // --- proposal 64: the dots are the tasks --------------------------------

  describe("the tasks an agent holds", function () {
    const S = require("../../governance/swarm.js");
    const AAOS = [{ id: 2, topic: "JD" }, { id: 3, topic: "JD-build" }];
    const titled = (id, status, title, proposer, createdAt) =>
      ({ id, aaoId: 2, status, proposer, createdAt, text: JSON.stringify({ title }) });

    const PROPOSALS = [
      titled(70, 1, "Done and dusted", R.KALAM, 1758000000),
      titled(71, 0, "Still in hand", R.KALAM, 1758000100),
      titled(72, 0, "Kural filed this and it is open", R.KURAL, 1758000200),
      titled(73, 0, "Blocked on the Director: the Hetzner API token", R.KURAL, 1758000300),
      titled(74, 1, "Kural filed this and it closed", R.KURAL, 1758000400)
    ];
    const decision = (from, ts, id, summary) =>
      ({ from, type: "decision", ts, refs: ["proposal " + id], summary, subject: "s" });
    const MESSAGES = [
      decision("kalam", "2026-09-19T01:00:00Z", 70, "building: picked it up."),
      decision("kalam", "2026-09-19T02:00:00Z", 70, "Built in commit abc1234."),
      decision("kalam", "2026-09-19T03:00:00Z", 71, "building: in hand now."),
      decision("kural", "2026-09-19T04:00:00Z", 72, "blocked: waiting on Wren for the facet cut"),
      decision("wren", "2026-09-19T05:00:00Z", 70, "Built in commit abc1234.")
    ];

    it("counts a proposal the agent has decided on, and nobody else's", function () {
      const mine = S.tasksFor("kalam", MESSAGES, PROPOSALS, AAOS).map((t) => t.proposalId);
      expect(mine).to.deep.equal([70, 71]);
      expect(S.tasksFor("wren", MESSAGES, PROPOSALS, AAOS).map((t) => t.proposalId))
        .to.deep.equal([70]);
    });

    it("takes the state from that agent's latest decision, not from anyone else's",
      function () {
        const mine = S.tasksFor("kalam", MESSAGES, PROPOSALS, AAOS);
        expect(mine.filter((t) => t.proposalId === 70)[0].state, "building then built")
          .to.equal("built");
        expect(mine.filter((t) => t.proposalId === 71)[0].state).to.equal("building");
      });

    it("folds adoption's nine states onto the dot's four", function () {
      expect(S.dotStateOf("blocked")).to.equal("blocked");
      expect(S.dotStateOf("building")).to.equal("building");
      expect(S.dotStateOf("built")).to.equal("built");
      expect(S.dotStateOf("in-widget"), "in the widget is done").to.equal("built");
      expect(S.dotStateOf("closed"), "closed is done, however it closed").to.equal("built");
      expect(S.dotStateOf("waiting"), "deferred is still held").to.equal("queued");
      expect(S.dotStateOf("queued")).to.equal("queued");
      expect(S.dotStateOf("unknown")).to.equal("queued");
    });

    it("gives an architect the proposals it filed, open or passed", function () {
      const kural = S.tasksFor("kural", MESSAGES, PROPOSALS, AAOS);
      const ids = kural.map((t) => t.proposalId);
      expect(ids, "72 decided on, 73 filed and open").to.contain(73);
      // Proposal 66: it used to drop off here the moment it passed, which is
      // how finished work vanished instead of filling its dot.
      expect(ids, "74 passed, and passed work is done work").to.contain(74);
      expect(kural.filter((t) => t.proposalId === 74)[0].state).to.equal("built");
      expect(ids, "and it does not pick up what Kalam filed").to.not.contain(71);
    });

    it("does not give a builder its filed proposals: only an architect holds those",
      function () {
        // Kalam filed 71 and it is open, but Kalam is no organisation's
        // architect, so 71 is a task only because Kalam decided on it.
        const without = S.tasksFor("kalam", [], PROPOSALS, AAOS);
        expect(without).to.deep.equal([]);
      });

    it("reads an open block on the Director as blocked, so the kolam and the column agree",
      function () {
        const task = S.tasksFor("kural", MESSAGES, PROPOSALS, AAOS)
          .filter((t) => t.proposalId === 73)[0];
        expect(task.state).to.equal("blocked");
        expect(task.who).to.equal("the Director");
        expect(task.what).to.equal("the Hetzner API token");
      });

    it("orders them oldest first, which is the order the kolam draws", function () {
      const kural = S.tasksFor("kural", MESSAGES, PROPOSALS, AAOS);
      const times = kural.map((t) => t.at);
      for (let i = 1; i < times.length; i++) {
        expect(times[i - 1] <= times[i], "task " + i + " is not older than the one before")
          .to.equal(true);
      }
    });

    it("dates a task from when the agent first spoke about it, not from the latest word",
      function () {
        const task = S.tasksFor("kalam", MESSAGES, PROPOSALS, AAOS)
          .filter((t) => t.proposalId === 70)[0];
        expect(task.at).to.equal(Date.parse("2026-09-19T01:00:00Z"));
      });

    // Proposal 66. An architect's passed proposal used to vanish from its kolam
    // the moment it passed, so the line could never complete; a rejected one
    // lingered as a queued ring. Both made the drawing disagree with the chain.
    describe("the chain has the last word on a proposal the agent filed", function () {
      const filed = (id, status, proposer, title) =>
        ({ id, aaoId: 2, status, proposer, createdAt: 1758000000,
           text: JSON.stringify({ title: title || ("Proposal " + id) }) });
      const CHAIN = [
        filed(80, 1, R.KURAL, "Kural filed it and it passed"),
        filed(81, 2, R.KURAL, "Kural filed it and it was rejected"),
        filed(82, 0, R.KURAL, "Kural filed it and it is open"),
        filed(83, 1, R.DIRECTOR, "The Director filed it and it passed")
      ];
      // Every one carries a decision that says something ELSE, so the fold is
      // what is being read, not the decision.
      const SAID = [80, 81, 82].map((id) =>
        ({ from: "kural", type: "decision", ts: "2026-01-01T00:00:00Z",
           refs: ["proposal " + id], summary: "waiting: not yet.", subject: "s" }))
        .concat([{ from: "kural", type: "decision", ts: "2026-01-01T00:00:00Z",
                   refs: ["proposal 83"], summary: "building: in hand.", subject: "s" }]);
      const kural = () => S.tasksFor("kural", SAID, CHAIN, AAOS);
      const one = (id) => kural().filter((t) => t.proposalId === id)[0];

      it("folds Executed to built, whatever the agent last said", function () {
        expect(one(80).state, "it passed, so the work is done").to.equal("built");
      });

      it("drops a Rejected one: the organisation said no, so nobody holds it", function () {
        expect(one(81)).to.equal(undefined);
        expect(kural().map((t) => t.proposalId)).to.not.contain(81);
      });

      it("leaves an Active one exactly as it was", function () {
        expect(one(82).state, "the decision still speaks").to.equal("queued");
      });

      it("does not touch a proposal the agent did not file", function () {
        expect(one(83).state, "the Director filed it; Kural's own word stands")
          .to.equal("building");
      });

      it("lets the line complete, which was the whole point", function () {
        // Before 66 the passed one vanished and the rejected one lingered as a
        // ring, so the drawn share was 0 of 2 held. Now it is 1 of 2, and an
        // architect who finishes everything reaches a complete line.
        const held = kural().filter((t) => t.proposalId === 80 || t.proposalId === 81);
        expect(held.map((t) => t.proposalId), "80 held, 81 gone").to.deep.equal([80]);
        expect(held.filter((t) => t.state === "built").length / held.length).to.equal(1);
      });
    });

    it("hands every agent on the street its own task list", function () {
      const d = S.dashboard(MESSAGES, PROPOSALS, AAOS, Date.now());
      const kalam = d.street.filter((a) => a.key === "kalam")[0];
      expect(kalam.tasks.map((t) => t.proposalId)).to.deep.equal([70, 71]);
      expect(kalam.done, "one of the two is built").to.equal(1);
      d.street.forEach((agent) => {
        expect(Array.isArray(agent.tasks), agent.key + " has no task list").to.equal(true);
      });
    });
  });

  describe("the kolam a queue draws", function () {
    const K = require("../../governance/swarm/kolam.js");
    const KALAM = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
    const task = (id, state, at) =>
      ({ proposalId: id, aaoId: 2, title: "Task " + id, state,
         who: state === "blocked" ? "the Director" : "", what: "", at });
    const queue = (n, state) =>
      Array.from({ length: n }, (_, i) => task(i + 1, state || "queued", i + 1));

    it("grows the grid to hold the queue, on odd sizes only", function () {
      expect(K.gridFor(0)).to.equal(7);
      expect(K.gridFor(36), "36 dots fit a 7 grid exactly").to.equal(7);
      expect(K.gridFor(37), "one more needs the next odd size").to.equal(9);
      expect(K.gridFor(64)).to.equal(9);
      expect(K.gridFor(65)).to.equal(11);
      [0, 1, 37, 99].forEach((n) => expect(K.gridFor(n) % 2, n + " tasks").to.equal(1));
    });

    it("never shrinks below the size the kolam already had", function () {
      expect(K.gridFor(1, 11), "a bigger minimum wins").to.equal(11);
      expect(K.gridFor(1, 3), "and a smaller one does not").to.equal(7);
    });

    it("fills the dots from the centre outward, oldest at the centre", function () {
      const k = K.withTasks(KALAM, queue(5));
      const centre = k.size / 2;
      const held = k.pulli.filter((p) => p.task)
        .map((p) => ({ id: p.task.proposalId, d: Math.hypot(p.x - centre, p.y - centre) }))
        .sort((a, b) => a.id - b.id);
      expect(held.length).to.equal(5);
      for (let i = 1; i < held.length; i++) {
        expect(held[i].d).to.be.at.least(held[i - 1].d - 0.001);
      }
    });

    it("leaves every other dot as open ground", function () {
      const k = K.withTasks(KALAM, queue(5));
      expect(k.pulli.filter((p) => p.task).length).to.equal(5);
      expect(k.pulli.filter((p) => p.state === "open").length).to.equal(k.dots.length - 5);
    });

    it("draws the line as far as the queue is done", function () {
      const half = [task(1, "built", 1), task(2, "built", 2), task(3, "queued", 3), task(4, "blocked", 4)];
      const k = K.withTasks(KALAM, half);
      expect(k.done).to.equal(2);
      expect(k.total).to.equal(4);
      expect(k.progress).to.equal(0.5);
      expect(K.withTasks(KALAM, queue(4, "built")).progress, "a finished queue").to.equal(1);
      expect(K.withTasks(KALAM, []).progress, "nothing owed is nothing unfinished").to.equal(1);
    });

    it("keeps the whole closed loop and hides the rest, rather than drawing a shorter one",
      function () {
        const k = K.withTasks(KALAM, queue(4, "queued"));
        expect(K.loopsOf(k.arcs).length, "still one loop").to.equal(1);
        expect(k.path.slice(-1), "still closed").to.equal("Z");
        const svg = K.toSVG(KALAM, { tasks: queue(4, "queued") });
        expect(svg).to.contain("stroke-dashoffset");
        expect(svg, "the whole path is still in the file").to.contain(k.path);
      });

    it("still refuses to draw anything that breaks the kolam's own rules", function () {
      const k = K.withTasks(KALAM, queue(40));
      expect(k.cells, "the queue outgrew the default grid").to.equal(9);
      expect(K.loopsOf(k.arcs).length).to.equal(1);
      expect(k.dots.length).to.equal(64);
    });

    it("gives every task dot a title, a state and a way in from the keyboard", function () {
      const svg = K.toSVG(KALAM, { tasks: [task(7, "blocked", 1), task(8, "built", 2)] });
      expect((svg.match(/tabindex="0"/g) || []).length, "one per task").to.equal(2);
      expect(svg).to.contain('data-proposal="7"');
      expect(svg).to.contain('data-state="blocked"');
      expect(svg, "the block says who, with no script running").to.contain("waiting on the Director");
      expect(svg, "an empty dot says so too").to.contain("Open ground");
    });
  });

  // --- proposal 68: the architect's watch ---------------------------------
  //
  // The loop is in scripts/watch-jd.js. Everything it decides is here, so it is
  // tested without starting a watch and without a chain.
  describe("what an architect's watch covers, and where it left off", function () {
    const W = require("../../governance/architect-watch.js");
    const os = require("os");

    const AAOS = [
      { id: 0, topic: "trilogy widget" }, { id: 1, topic: "widget-builder" },
      { id: 2, topic: "JD" }, { id: 3, topic: "JD-build" }
    ];

    describe("the organisations", function () {
      it("covers the architect's own organisation and every room under it", function () {
        expect(W.topicsFor(R.KURAL)).to.deep.equal(["JD", "JD-build"]);
        expect(W.topicsFor(R.WREN)).to.deep.equal(["trilogy widget", "widget-builder"]);
      });

      it("covers nothing for an agent that is nobody's architect", function () {
        expect(W.topicsFor(R.KALAM), "Kalam builds; it does not watch").to.deep.equal([]);
        expect(W.topicsFor(R.BUILDER)).to.deep.equal([]);
      });

      it("reads the rooms off the rule sets, so a new one needs no code here", function () {
        // JD-build is covered because its rule set names JD as its parent, not
        // because this file or watch-jd.js lists it.
        expect(R.AAO_RULES["JD-build"].parent).to.equal("JD");
        expect(W.topicsFor(R.KURAL)).to.contain("JD-build");
      });

      it("turns topics into the ids the chain uses", function () {
        const found = W.resolve(W.topicsFor(R.KURAL), AAOS);
        expect(found.organisations).to.deep.equal([
          { id: 2, topic: "JD" }, { id: 3, topic: "JD-build" }
        ]);
        expect(found.ids).to.deep.equal([2, 3]);
      });

      it("names a topic that is not on this chain instead of quietly dropping it",
        function () {
          const found = W.resolve(["JD", "not-created-yet"], AAOS);
          expect(found.missing).to.deep.equal(["not-created-yet"]);
          expect(found.ids, "and covers what it can").to.deep.equal([2]);
        });
    });

    describe("the cursor", function () {
      let file;

      beforeEach(function () {
        file = path.join(os.tmpdir(), "peoplenet-watch-test-" + Date.now() + "-" +
          Math.random().toString(36).slice(2) + ".json");
      });

      afterEach(function () {
        [file, file + ".tmp"].forEach((f) => { if (fs.existsSync(f)) fs.unlinkSync(f); });
      });

      it("lives outside the repository", function () {
        const at = W.cursorPath("kural");
        expect(at.startsWith(os.tmpdir()), at + " is not under the temp directory").to.equal(true);
        expect(at).to.contain("kural");
        const repo = path.join(__dirname, "..", "..");
        expect(path.relative(repo, at).startsWith(".."),
          "a position is not a record; it must not dirty the working tree").to.equal(true);
      });

      it("names the cursor for the watch, so two watches do not share one", function () {
        expect(W.cursorPath("kural")).to.not.equal(W.cursorPath("wren"));
      });

      it("comes back exactly as it went in", function () {
        W.writeCursor(file, { block: 274, offsets: { "messages.jsonl": 9001, "answers.jsonl": 42 } });
        const { cursor, why } = W.readCursor(file);
        expect(why).to.equal(null);
        expect(cursor.block).to.equal(274);
        expect(cursor.offsets).to.deep.equal({ "messages.jsonl": 9001, "answers.jsonl": 42 });
        expect(cursor.at, "and says when it was written").to.be.a("string");
      });

      it("leaves no half-written cursor behind", function () {
        W.writeCursor(file, { block: 1, offsets: {} });
        expect(fs.existsSync(file + ".tmp"), "the temporary file is renamed, not left")
          .to.equal(false);
      });

      it("says why it cannot be used, rather than guessing", function () {
        expect(W.readCursor(file).cursor, "missing").to.equal(null);
        expect(W.readCursor(file).why).to.contain("no cursor");

        fs.writeFileSync(file, "not json at all", "utf8");
        expect(W.readCursor(file).cursor).to.equal(null);
        expect(W.readCursor(file).why).to.contain("not JSON");

        fs.writeFileSync(file, JSON.stringify({ offsets: {} }), "utf8");
        expect(W.readCursor(file).cursor).to.equal(null);
        expect(W.readCursor(file).why).to.contain("no block");
      });

      it("resumes a log where it stopped, so lines written while it was down are read",
        function () {
          W.writeCursor(file, { block: 5, offsets: { "messages.jsonl": 100 } });
          const { cursor } = W.readCursor(file);
          // The log grew by 40 bytes while the watch was not running.
          expect(W.offsetFor(cursor, "messages.jsonl", 140).from,
            "read from where it stopped, not from the new end").to.equal(100);
        });

      it("starts a log it has never seen at its end, not at its beginning", function () {
        W.writeCursor(file, { block: 5, offsets: {} });
        const { cursor } = W.readCursor(file);
        const where = W.offsetFor(cursor, "kalam-votes.jsonl", 900);
        expect(where.from, "a log added today is not a day of history to replay").to.equal(900);
        expect(where.fresh).to.equal(true);
      });

      it("reads a log whole again if it is shorter than the cursor, and says so", function () {
        W.writeCursor(file, { block: 5, offsets: { "messages.jsonl": 500 } });
        const { cursor } = W.readCursor(file);
        const where = W.offsetFor(cursor, "messages.jsonl", 120);
        expect(where.from).to.equal(0);
        expect(where.shrank).to.equal(true);
      });
    });

    describe("which records belong to the watch", function () {
      const ids = [2, 3];

      it("keeps a record from one of its organisations", function () {
        expect(W.recordIsMine({ aaoId: 2 }, ids)).to.equal(true);
        expect(W.recordIsMine({ aaoId: 3 }, ids)).to.equal(true);
        expect(W.recordIsMine({ aaoId: "3" }, ids), "a string id is still an id").to.equal(true);
      });

      it("drops one from another architect's organisation", function () {
        expect(W.recordIsMine({ aaoId: 0 }, ids)).to.equal(false);
        expect(W.recordIsMine({ aaoId: 1 }, ids)).to.equal(false);
      });

      it("keeps a record that names no organisation", function () {
        // The message stream carries plenty that belongs to no single room --
        // the Director's own questions among them -- and dropping those would
        // hide exactly what the watch is for.
        expect(W.recordIsMine({ from: "director", subject: "?" }, ids)).to.equal(true);
        expect(W.recordIsMine({ aaoId: null }, ids)).to.equal(true);
        expect(W.recordIsMine({ aaoId: "" }, ids)).to.equal(true);
      });

      it("drops nothing at all", function () {
        expect(W.recordIsMine(null, ids)).to.equal(false);
      });
    });
  });

  // --- proposal 89: who files a draft, and how often ----------------------
  //
  // The Director's one draft on JD became proposals 87 and 88 a second apart,
  // because two watchers filed it. One of those was signed from the Director's
  // own account by an agent that is not even a member of JD.
  describe("a draft is filed once, by the organisation's architect", function () {
    const filedAs = (id) => ({ state: "filed", proposalId: id, draft: "draft-x" });
    const JD = () => R.rulesFor({ topic: "JD" });
    const MAIN = () => R.rulesFor({ topic: "trilogy widget" });
    const NAMELESS = () => R.rulesFor({ topic: "nobody has written a rule for this" });

    it("lets the architect file it", function () {
      expect(R.draftFilingProblem(JD(), R.KURAL, [], { topic: "JD" })).to.equal(null);
      expect(R.draftFilingProblem(MAIN(), R.WREN, [], { topic: "trilogy widget" })).to.equal(null);
    });

    it("refuses anyone else, and says who files it", function () {
      const problem = R.draftFilingProblem(JD(), R.WREN, [], { topic: "JD" });
      expect(problem).to.equal("This draft is on JD; its architect is Kural. Kural files it.");
    });

    it("refuses the Director's own account, which is how 87 was filed", function () {
      // Wren is a viewer on JD and not a member, so its watcher signed from
      // account 0. The refusal must not care whose account it is.
      const problem = R.draftFilingProblem(JD(), R.DIRECTOR, [], { topic: "JD" });
      expect(problem).to.contain("its architect is Kural");
    });

    it("refuses a draft that is already filed, and names what it became", function () {
      const problem = R.draftFilingProblem(JD(), R.KURAL, [filedAs(87)], { topic: "JD" });
      expect(problem).to.equal(
        "This draft is already filed: it became proposal 87. Nothing to file.");
    });

    it("asks 'already filed' first, because it is true whoever is asking", function () {
      const problem = R.draftFilingProblem(JD(), R.WREN, [filedAs(88)], { topic: "JD" });
      expect(problem, "the wrong filer is not the useful thing to say here")
        .to.contain("already filed");
    });

    it("ignores a draft record that is not a filing", function () {
      const waiting = [{ state: "awaiting-wren", draft: "draft-x" }];
      expect(R.draftFilingProblem(JD(), R.KURAL, waiting, { topic: "JD" })).to.equal(null);
    });

    it("leaves an organisation with no architect exactly as it was", function () {
      expect(NAMELESS().architect, "nothing to enforce").to.equal(null);
      expect(R.draftFilingProblem(NAMELESS(), R.WREN, [], { topic: "somewhere" })).to.equal(null);
      expect(R.draftFilingProblem(NAMELESS(), R.DIRECTOR, [], { topic: "somewhere" })).to.equal(null);
    });

    it("still refuses a second filing there, because that rule needs no architect",
      function () {
        expect(R.draftFilingProblem(NAMELESS(), R.WREN, [filedAs(5)], { topic: "somewhere" }))
          .to.contain("already filed");
      });

    describe("on a chain, through the script's own checks", function () {
      // The organisation, the signer and the log, exactly as the script reads
      // them, on the throwaway network this file already stands up.
      async function filingProblemFor(aaoId, signer, filed) {
        const chainAao = (await R.readAAOs(aao)).filter((a) => a.id === aaoId)[0];
        return R.draftFilingProblem(
          R.rulesFor({ topic: chainAao.topic }), signer.address, filed, { topic: chainAao.topic });
      }

      it("reads the organisation off the chain, not off the draft record", async function () {
        // mainId is "trilogy widget" here, whose architect is Wren.
        expect(await filingProblemFor(mainId, wren, [])).to.equal(null);
        expect(await filingProblemFor(mainId, builder, []))
          .to.contain("its architect is Wren");
      });

      it("refuses an account that is not a member before it can send", async function () {
        const chainAao = (await R.readAAOs(aao)).filter((a) => a.id === subId)[0];
        expect(await aao.isMember(subId, outsider.address), "not on this organisation")
          .to.equal(false);
        // The architect check comes first and already refuses this account, so
        // it never reaches submitProposal. Both guards hold, in that order.
        const problem = R.draftFilingProblem(
          R.rulesFor({ topic: chainAao.topic }), outsider.address, [], { topic: chainAao.topic });
        expect(problem).to.contain("files it");
      });

      it("refuses a draft already filed on this chain", async function () {
        const id = await submit(mainId, wren, JSON.stringify(
          { title: "Filed once already", summary: "s", why: "w" }));
        expect(await filingProblemFor(mainId, wren, [{ state: "filed", proposalId: id }]))
          .to.contain("it became proposal " + id);
      });
    });
  });

  // --- proposal 90: who answers a question --------------------------------
  //
  // The Director's question on proposal 87 got two answers two seconds apart,
  // from Wren and from Kural, because every question was addressed to "wren"
  // whatever organisation it was asked on, and both architects watch the file.
  describe("a question goes to the architect of the organisation it was asked on",
    function () {
      const asked = (to, aaoId) => ({ id: "q-1", from: "director", to, aaoId, text: "?" });
      const JD = () => R.rulesFor({ topic: "JD" });
      const MAIN = () => R.rulesFor({ topic: "trilogy widget" });
      const NAMELESS = () => R.rulesFor({ topic: "nobody has written a rule for this" });

      it("addresses it to that organisation's architect", function () {
        expect(R.questionRouting(JD()).to).to.equal("kural");
        expect(R.questionRouting(MAIN()).to).to.equal("wren");
        expect(R.questionRouting(R.rulesFor({ topic: "JD-build" })).to).to.equal("kural");
      });

      it("ignores the 'to' on questions written before this, which all say wren",
        function () {
          // This is the whole bug: the page said "Ask Kural" on JD for days
          // while the message it sent said "to wren".
          const old = asked("wren", 2);
          expect(R.questionRouting(JD(), old).to, "the rule set decides, not the message")
            .to.equal("kural");
          expect(R.questionRouting(JD(), old).fromRules).to.equal(true);
        });

      it("keeps the message's own 'to' where no architect is named", function () {
        expect(R.questionRouting(NAMELESS(), asked("wren", 9)).to).to.equal("wren");
        expect(R.questionRouting(NAMELESS(), asked("builder", 9)).to).to.equal("builder");
        expect(R.questionRouting(NAMELESS(), null).to, "and wren when there is nothing")
          .to.equal("wren");
        expect(R.questionRouting(NAMELESS(), asked("wren", 9)).fromRules).to.equal(false);
      });

      it("lets the right architect answer", function () {
        expect(R.answerProblem(JD(), asked("wren", 2), "kural", { topic: "JD" })).to.equal(null);
        expect(R.answerProblem(MAIN(), asked("wren", 0), "wren", { topic: "trilogy widget" }))
          .to.equal(null);
      });

      it("refuses anyone else, and says who answers it", function () {
        expect(R.answerProblem(JD(), asked("wren", 2), "wren", { topic: "JD" })).to.equal(
          "This question is on JD; Kural answers it. " +
          "Pass --second-opinion to add a view instead.");
      });

      it("refuses a builder too, not only the other architect", function () {
        expect(R.answerProblem(JD(), asked("wren", 2), "kalam", { topic: "JD" }))
          .to.contain("Kural answers it");
      });

      it("always allows a second opinion, from anyone", function () {
        const options = { topic: "JD", secondOpinion: true };
        expect(R.answerProblem(JD(), asked("wren", 2), "wren", options)).to.equal(null);
        expect(R.answerProblem(JD(), asked("wren", 2), "kalam", options)).to.equal(null);
      });

      it("leaves an organisation with no architect answering as it always did",
        function () {
          expect(R.answerProblem(NAMELESS(), asked("wren", 9), "wren", { topic: "x" }))
            .to.equal(null);
          expect(R.answerProblem(NAMELESS(), asked("wren", 9), "kural", { topic: "x" }))
            .to.contain("Wren answers it");
        });

      it("tells a second opinion from an answer", function () {
        expect(R.isSecondOpinion({ second_opinion: true })).to.equal(true);
        expect(R.isSecondOpinion({})).to.equal(false);
        expect(R.isSecondOpinion(null)).to.equal(false);
      });

      it("keeps a second opinion out of the count that closes a question", function () {
        // What the page and --list both do: a question carrying only a second
        // opinion has been thought about and not answered.
        const log = [
          { question: "q-1", from: "kural", summary: "The answer." },
          { question: "q-2", from: "wren", summary: "A view.", second_opinion: true }
        ];
        const settled = (id) => log.filter((a) => a.question === id && !R.isSecondOpinion(a));
        expect(settled("q-1").length, "answered").to.equal(1);
        expect(settled("q-2").length, "still open").to.equal(0);
      });

      describe("on a chain, through the organisations the script reads", function () {
        it("routes by the organisation the question names, not by its 'to'",
          async function () {
            const chain = await R.readAAOs(aao);
            const main = chain.filter((a) => a.id === mainId)[0];
            const sub = chain.filter((a) => a.id === subId)[0];
            // Both were asked "to wren"; the rule sets send them different ways
            // only where the rule sets differ.
            expect(R.questionRouting(R.rulesFor({ topic: main.topic }), asked("wren", mainId)).to)
              .to.equal("wren");
            expect(R.answerProblem(R.rulesFor({ topic: sub.topic }), asked("wren", subId),
              "wren", { topic: sub.topic }), "Wren is the widget-builder's architect")
              .to.equal(null);
          });

        it("falls back to the message when the chain knows no such organisation",
          async function () {
            const unknown = R.rulesFor({ topic: "" });
            expect(unknown.architect, "no rule set, no architect").to.equal(null);
            expect(R.questionRouting(unknown, asked("wren", 99)).to).to.equal("wren");
          });
      });
    });

  // --- proposal 92: the chain survives a sign-out -------------------------
  //
  // On 2026-09-19 a Windows sign-out destroyed the chain. The replay tool
  // rebuilt it, but the only export that existed was one taken by luck during a
  // rehearsal, and every vote cast after it was lost.
  //
  // Nothing here touches the live node, the live server, the live logs or the
  // real snapshot directory. Every path below is a throwaway directory, and no
  // process is spawned.
  describe("the snapshot that makes the record survive", function () {
    const SNAP = require("../../governance/snapshots.js");
    const os = require("os");
    let dir;

    const body = (events, proposals, block) => JSON.stringify({
      blockNumber: block === undefined ? 100 : block,
      events: Array.from({ length: events }, (_, i) => ({ name: "VoteCast", block: i })),
      state: {
        aaoCount: 4,
        aaos: [],
        proposals: Array.from({ length: proposals }, (_, i) => ({ id: i }))
      }
    });

    function put(name, text) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text, "utf8");
      return file;
    }

    beforeEach(function () {
      dir = path.join(os.tmpdir(), "peoplenet-snap-test-" + Date.now() + "-" +
        Math.random().toString(36).slice(2));
      fs.mkdirSync(dir, { recursive: true });
    });

    afterEach(function () {
      if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    });

    it("lives outside the repository, and outside the temp directory by default",
      function () {
        // The temp directory is a place the operating system empties, and while
        // the chain is in one process's memory the snapshot is the only copy.
        const where = SNAP.directory();
        const repo = path.join(__dirname, "..", "..");
        expect(path.relative(repo, where).startsWith(".."),
          where + " is inside the repository").to.equal(true);
        expect(where.startsWith(os.tmpdir()),
          where + " is under the temp directory").to.equal(false);
        expect(where).to.contain("peoplenet-snapshots");
      });

    it("takes its directory from the environment when told", function () {
      const was = process.env.PEOPLENET_SNAPSHOT_DIR;
      try {
        process.env.PEOPLENET_SNAPSHOT_DIR = dir;
        delete require.cache[require.resolve("../../governance/snapshots.js")];
        expect(require("../../governance/snapshots.js").directory()).to.equal(path.resolve(dir));
      } finally {
        if (was === undefined) delete process.env.PEOPLENET_SNAPSHOT_DIR;
        else process.env.PEOPLENET_SNAPSHOT_DIR = was;
        delete require.cache[require.resolve("../../governance/snapshots.js")];
      }
    });

    it("names them so the newest sorts last, with no clock to trust twice",
      function () {
        const early = SNAP.nameFor(new Date("2026-09-21T05:00:00Z"));
        const later = SNAP.nameFor(new Date("2026-09-21T05:10:00Z"));
        expect([later, early].sort()).to.deep.equal([early, later]);
        expect(SNAP.isSnapshotName(path.basename(early))).to.equal(true);
        expect(SNAP.isSnapshotName("notes.txt")).to.equal(false);
      });

    it("refuses to replace a good snapshot with an export holding fewer events",
      function () {
        const problem = SNAP.replacementProblem({ events: 100, proposals: 60 },
          { events: 193, proposals: 60 });
        expect(problem).to.contain("100 events");
        expect(problem).to.contain("193");
        expect(problem, "and says why, not just no").to.contain("The record only grows");
      });

    it("refuses on fewer proposals too, even when the events grew", function () {
      const problem = SNAP.replacementProblem({ events: 300, proposals: 4 },
        { events: 193, proposals: 60 });
      expect(problem).to.contain("4 proposals");
      expect(problem).to.contain("60");
    });

    it("allows a bigger one, and allows the very first", function () {
      expect(SNAP.replacementProblem({ events: 200, proposals: 61 },
        { events: 193, proposals: 60 })).to.equal(null);
      expect(SNAP.replacementProblem({ events: 1, proposals: 0 }, null)).to.equal(null);
    });

    it("refuses an export it could not read at all", function () {
      expect(SNAP.replacementProblem(null, null)).to.contain("could not be read");
    });

    it("measures against the newest one it can READ, not merely the newest",
      function () {
        put(SNAP.nameFor(new Date("2026-09-21T05:00:00Z")), body(193, 60));
        put(SNAP.nameFor(new Date("2026-09-21T05:10:00Z")), "{ truncated mid-write");
        const good = SNAP.newestGood(dir);
        expect(path.basename(good.file)).to.contain("05-00-00");
        expect(good.summary.events, "a corrupt newest must not become the yardstick")
          .to.equal(193);
      });

    it("writes through a temporary file and a rename, leaving no part behind",
      function () {
        const file = path.join(dir, SNAP.nameFor(new Date()));
        SNAP.writeAtomic(file, body(5, 2));
        expect(fs.existsSync(file)).to.equal(true);
        expect(fs.existsSync(file + ".part"), "the part file is renamed, not left")
          .to.equal(false);
        expect(SNAP.summarise(file).events).to.equal(5);
      });

    it("keeps the last N and drops the oldest first", function () {
      for (let i = 0; i < 8; i++) {
        put(SNAP.nameFor(new Date(Date.UTC(2026, 8, 21, 5, i))), body(10 + i, 3));
      }
      expect(SNAP.list(dir).length).to.equal(8);
      const removed = SNAP.prune(dir, 3);
      expect(removed.length).to.equal(5);
      const left = SNAP.list(dir).map((f) => path.basename(f));
      expect(left.length).to.equal(3);
      expect(left[left.length - 1], "the newest survives").to.contain("05-07");
      expect(left[0], "and the oldest kept is the fourth from the end").to.contain("05-05");
    });

    it("prunes nothing when there is nothing spare", function () {
      put(SNAP.nameFor(new Date()), body(1, 1));
      expect(SNAP.prune(dir, 200)).to.deep.equal([]);
      expect(SNAP.list(dir).length).to.equal(1);
    });

    it("reads an empty or missing directory as no snapshots, not an error",
      function () {
        expect(SNAP.list(path.join(dir, "not-there"))).to.deep.equal([]);
        expect(SNAP.newest(dir)).to.equal(null);
        expect(SNAP.newestGood(dir)).to.equal(null);
      });

    it("summarises a file it cannot parse as nothing, not as zero", function () {
      const file = put(SNAP.nameFor(new Date()), "not json");
      expect(SNAP.summarise(file), "nothing is not the same as a small snapshot")
        .to.equal(null);
    });
  });

  describe("bringing it all back up", function () {
    const UP = require("../../scripts/up.js");

    it("knows a process id it started from one that is gone", function () {
      expect(UP.alive(process.pid), "this very process").to.equal(true);
      expect(UP.alive(0)).to.equal(false);
      expect(UP.alive(null)).to.equal(false);
      // A pid that is almost certainly not a running process.
      expect(UP.alive(999999)).to.equal(false);
    });

    it("records what it started by process id, never by name", function () {
      const source = fs.readFileSync(
        path.join(__dirname, "..", "..", "scripts", "up.js"), "utf8");
      // A name match once killed an architect's watch three times in an
      // afternoon. Nothing here may look a process up by its command line.
      expect(source).to.not.contain("CommandLine");
      expect(source).to.not.contain("taskkill");
      expect(source).to.not.contain("pkill");
      expect(source, "it starts things and records their pids").to.contain("recordPid");
    });

    it("does nothing when the chain is already up with a record on it", function () {
      // The shape of the check, read off the script: an answering node AND a
      // diamond holding something. A node that answers with an empty diamond is
      // a rebuilt chain waiting for a replay, not a running system.
      const source = fs.readFileSync(
        path.join(__dirname, "..", "..", "scripts", "up.js"), "utf8");
      expect(source).to.contain("already up");
      expect(source).to.contain("chainHoldsRecord");
    });

    it("refuses to replay onto a diamond that is not the one it expects",
      function () {
        const source = fs.readFileSync(
          path.join(__dirname, "..", "..", "scripts", "up.js"), "utf8");
        expect(source).to.contain("Refusing to replay onto it");
        expect(source, "and proves the vote guard by calling it").to.contain("voteGuardPresent");
      });

    it("prints the logon task rather than installing it", function () {
      const source = fs.readFileSync(
        path.join(__dirname, "..", "..", "scripts", "up.js"), "utf8");
      expect(source).to.contain("it is not installed");
      expect(source.indexOf('spawn(process.execPath, ["schtasks'), "never runs it")
        .to.equal(-1);
    });
  });

  describe("wren-decide's state reader, which writes no transaction at all", function () {
    it("reads the state out of the words, and refuses words that say nothing", async function () {
      expect(A.stateOf({ summary: "queued behind S12." }).key).to.equal("queued");
      expect(A.stateOf({ summary: "Built in commit abc." }).key).to.equal("built");
      expect(A.stateOf({ summary: "waiting: not yet." }).key).to.equal("waiting");
      expect(A.stateOf({ summary: "closed: superseded by proposal 31." }).key).to.equal("closed");
      expect(A.stateOf({ summary: "I looked at it." }).key).to.equal("unknown");
    });

    // governance/check.js used to judge every decision ever written, so one of
    // Kural's on proposal 38 with no state word held the check red after a
    // later decision on 38 had already said where it got to. The log is
    // append-only: that line cannot be edited, so the check could never be made
    // green by writing the right thing next.
    it("judges a proposal by its latest decision, so a superseded one is history",
      function () {
        const log = [
          { id: "decision-older", type: "decision", ts: "2026-01-01T00:00:00Z",
            refs: ["proposal 38"], summary: "The Director ruled Wren a viewer on JD." },
          { id: "decision-newer", type: "decision", ts: "2026-01-02T00:00:00Z",
            refs: ["proposal 38"], summary: "Built in commit abc1234." }
        ];
        expect(A.stateOf(log[0]).key, "the older one says nothing").to.equal("unknown");

        const latest = A.indexDecisions(log);
        expect(latest[38].id).to.equal("decision-newer");
        expect(A.stateOf(latest[38]).key).to.equal("built");

        // The check, in the one line it is: no proposal's latest decision is
        // unknown. The older, stateless message is not judged at all.
        const unknown = Object.keys(latest)
          .filter((id) => A.stateOf(latest[id]).key === "unknown");
        expect(unknown).to.deep.equal([]);
      });
  });
});
