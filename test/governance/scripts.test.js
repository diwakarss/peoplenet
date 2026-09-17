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
const { ethers } = require("hardhat");
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
      { file: "wren-vote.js", send: "connect(wren).vote(" },
      { file: "builder-vote.js", send: "connect(builder).vote(" },
      { file: "wren-decide.js", send: "appendFileSync(MESSAGES" },
      { file: "wren-file-draft.js", send: "connect(signer).submitProposal(" },
      { file: "propose.js", send: "connect(signer).submitProposal(" }
    ];

    scripts.forEach(({ file, send }) => {
      it(`${file} declares the flag, returns it, and checks it before it writes`, function () {
        const source = fs.readFileSync(
          path.join(__dirname, "..", "..", "scripts", file), "utf8");

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
    const WRITERS = [
      "wren-vote.js", "builder-vote.js", "wren-decide.js", "wren-file-draft.js",
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

  describe("wren-decide's state reader, which writes no transaction at all", function () {
    it("reads the state out of the words, and refuses words that say nothing", async function () {
      expect(A.stateOf({ summary: "queued behind S12." }).key).to.equal("queued");
      expect(A.stateOf({ summary: "Built in commit abc." }).key).to.equal("built");
      expect(A.stateOf({ summary: "waiting: not yet." }).key).to.equal("waiting");
      expect(A.stateOf({ summary: "closed: superseded by proposal 31." }).key).to.equal("closed");
      expect(A.stateOf({ summary: "I looked at it." }).key).to.equal("unknown");
    });
  });
});
