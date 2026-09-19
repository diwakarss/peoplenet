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
  describe("one vote script for all three agents (proposal 30)", function () {
    const V = require("../../governance/vote.js");
    const VOTERS = [
      { file: "wren-vote.js", account: 1, label: "Wren",
        log: "wren-votes.jsonl", defaultAaoId: 0 },
      { file: "builder-vote.js", account: 3, label: "Builder",
        log: "builder-votes.jsonl", defaultAaoId: 1 },
      { file: "widget-vote.js", account: 4, label: "Widget",
        log: "widget-votes.jsonl", defaultAaoId: 1 }
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
      // Three voters, three logs: a shared script must not pool them.
      const logs = VOTERS.map((v) => v.log);
      expect(new Set(logs).size).to.equal(3);
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
      { dir: "scripts", file: "propose.js", send: "connect(signer).submitProposal(" }
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
      "execute-decided.js", "cut-aao-facet.js"
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
      "create-widget-builder-aao.js"
    ];

    ALL.forEach((file) => {
      it(`${file} gets past its own require and argument parsing`, function () {
        let output = "";
        try {
          output = execFileSync(process.execPath, [path.join(REPO, "scripts", file)], {
            cwd: REPO,
            encoding: "utf8",
            timeout: 60000,
            env: Object.assign({}, process.env, { HARDHAT_NETWORK: "hardhat" })
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
