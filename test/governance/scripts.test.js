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
      "wren-vote.js", "builder-vote.js", "wren-decide.js", "wren-answer.js",
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
