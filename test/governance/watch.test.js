// The watcher, tested against a chain that is thrown away afterwards.
//
// This file exists because of a real closure. On 2026-09-17 the watcher
// executed sub-AAO proposals 26, 29 and 30 on a single builder vote, within
// six minutes of it being cast, and the one-hour window the rule promised never
// ran. The cause was that the window was measured from the proposal's filing
// time instead of from the first vote: the proposals were days old, so the
// window had "already passed" before anybody voted.
//
// So what is pinned here is the watcher's decision, on chain, under both of the
// widget-builder's rules -- the interim one that runs until the widget casts its
// first vote, and the standing one that resumes the moment it does.
//
// Everything runs on the in-process hardhat network. Nothing here touches the
// node on 8545, and the only messages written go to a temporary file.
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getSelectors, FacetCutAction } = require("../helpers/diamond");
const R = require("../../governance/read.js");
const W = require("../../governance/watch.js");

const HOUR = 3600;

describe("the watcher closes what the rules say is decided", function () {
  let aao, diamondAddress;
  let director, wren, casting, builder, widget;
  let mainId, subId;
  let messagesFile;
  let signerByAddress;

  async function submit(aaoId, signer, doc) {
    const tx = await aao.connect(signer).submitProposal(aaoId, JSON.stringify(doc));
    const receipt = await tx.wait();
    const log = receipt.logs
      .map((l) => { try { return aao.interface.parseLog(l); } catch (e) { return null; } })
      .find((x) => x && x.name === "ProposalSubmitted");
    return Number(log.args.proposalId);
  }

  function doc(title) {
    return { title: title, summary: "Filed by the watcher test.", why: "So the watcher has something to decide." };
  }

  // Everything the watcher needs, with the clock handed in so a window can be
  // crossed without waiting an hour.
  function options(nowSeconds) {
    return {
      ethers: ethers,
      diamond: diamondAddress,
      messagesFile: messagesFile,
      nowSeconds: nowSeconds,
      signerFor: async (address) => {
        const signer = signerByAddress[String(address).toLowerCase()];
        if (!signer) throw new Error(`no unlocked signer for ${address}`);
        return signer;
      }
    };
  }

  async function state() {
    const aaos = await R.readAAOs(aao);
    const all = await R.readAllProposals(aao, aaos);
    return { aaos, all };
  }

  async function readOne(aaoId, id) {
    return (await R.readProposals(aao, aaoId)).filter((p) => p.id === id)[0];
  }

  function messages() {
    if (!fs.existsSync(messagesFile)) return [];
    return fs.readFileSync(messagesFile, "utf8")
      .split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  }

  before(async function () {
    const signers = await ethers.getSigners();
    [director, wren, casting, builder, widget] = signers;
    signerByAddress = {};
    [director, wren, casting, builder, widget].forEach((s) => {
      signerByAddress[s.address.toLowerCase()] = s;
    });

    const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
    const diamondCutFacet = await DiamondCutFacet.deploy();
    const Diamond = await ethers.getContractFactory("DiamondController");
    const diamond = await Diamond.deploy(director.address, await diamondCutFacet.getAddress());
    const AAOFacet = await ethers.getContractFactory("AAOFacet");
    const aaoFacet = await AAOFacet.deploy();

    diamondAddress = await diamond.getAddress();
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

    let tx = await aao.connect(director).createAAO("trilogy widget", HOUR);
    let receipt = await tx.wait();
    mainId = Number(receipt.logs
      .map((l) => { try { return aao.interface.parseLog(l); } catch (e) { return null; } })
      .find((x) => x && x.name === "AAOCreated").args.aaoId);
    await aao.connect(wren).joinAAO(mainId);
    await aao.connect(casting).joinAAO(mainId);

    tx = await aao.connect(director).createAAO("widget-builder", HOUR);
    receipt = await tx.wait();
    subId = Number(receipt.logs
      .map((l) => { try { return aao.interface.parseLog(l); } catch (e) { return null; } })
      .find((x) => x && x.name === "AAOCreated").args.aaoId);
    await aao.connect(wren).joinAAO(subId);
    await aao.connect(builder).joinAAO(subId);
    await aao.connect(widget).joinAAO(subId);

    messagesFile = path.join(os.tmpdir(), "governance-watch-test-" + Date.now() + ".jsonl");
  });

  after(function () {
    if (messagesFile && fs.existsSync(messagesFile)) fs.unlinkSync(messagesFile);
  });

  // --- the interim rule, while the widget has never voted ----------------

  describe("under the interim rule, while the widget has never voted", function () {
    it("is the rule the chain says is in force", async function () {
      const { aaos, all } = await state();
      const sub = aaos.filter((a) => a.id === subId)[0];
      const rules = R.effectiveRules(sub, all.filter((p) => p.aaoId === subId));
      expect(rules.interim, "the widget has cast nothing, so the interim rule runs").to.equal(true);
      expect(rules.windowHours).to.equal(1);
      expect(rules.regime, "the page and the scripts need a sentence to print").to.be.a("string");
    });

    it("does not execute a lone vote inside the hour -- the bug that closed 26, 29 and 30",
      async function () {
        const id = await submit(subId, builder, doc("A lone builder vote, freshly cast"));
        await aao.connect(builder).vote(id, true);

        const { aaos, all } = await state();
        const votedAt = all.filter((p) => p.id === id)[0].votes[0].at;
        expect(votedAt, "the vote must carry a block timestamp").to.be.greaterThan(0);

        const { executed, waiting } = await W.executeDecided(aaos, all, options(votedAt + 30 * 60));
        expect(executed.map((e) => e.id), "nothing should have been closed").to.not.contain(id);
        expect(Number((await aao.getProposal(id)).status), "still open").to.equal(0);

        const held = waiting.filter((w) => w.id === id)[0];
        expect(held, "and the watcher should say it is holding, not stay silent").to.not.equal(undefined);
        expect(held.reason).to.contain("1-hour window");
      });

    it("is not rescued by the proposal being old: the window runs from the vote", async function () {
      // This is exactly the shape 26, 29 and 30 were in -- filed days earlier,
      // voted on once, minutes ago. Measured from the filing time the window
      // had long passed; measured from the vote it has barely started.
      const id = await submit(subId, builder, doc("Filed long ago, voted on just now"));
      await aao.connect(builder).vote(id, true);

      const { aaos, all } = await state();
      const proposal = all.filter((p) => p.id === id)[0];
      const aged = all.map((p) => (p.id === id
        ? Object.assign({}, p, { createdAt: p.createdAt - 30 * 24 * HOUR })
        : p));

      const { executed } = await W.executeDecided(aaos, aged, options(proposal.votes[0].at + 5 * 60));
      expect(executed.map((e) => e.id)).to.not.contain(id);
      expect(Number((await aao.getProposal(id)).status)).to.equal(0);
    });

    it("executes the same lone vote once the hour has passed", async function () {
      const id = await submit(subId, builder, doc("A lone builder vote, an hour old"));
      await aao.connect(builder).vote(id, true);

      const { aaos, all } = await state();
      const votedAt = all.filter((p) => p.id === id)[0].votes[0].at;

      const { executed } = await W.executeDecided(aaos, all, options(votedAt + 61 * 60));
      const mine = executed.filter((e) => e.id === id)[0];
      expect(mine, "an hour and a minute later it should carry").to.not.equal(undefined);
      expect(mine.passed).to.equal(true);
      expect(Number((await aao.getProposal(id)).status)).to.equal(1);
    });

    it("executes at once when the builder and Wren have both voted", async function () {
      const id = await submit(subId, builder, doc("Both interim voters agree"));
      await aao.connect(builder).vote(id, true);
      await aao.connect(wren).vote(id, true);

      const { aaos, all } = await state();
      const votedAt = all.filter((p) => p.id === id)[0].votes[0].at;

      // One minute in: no window is needed at all when every voter is in.
      const { executed } = await W.executeDecided(aaos, all, options(votedAt + 60));
      const mine = executed.filter((e) => e.id === id)[0];
      expect(mine, "both voters in and decisive").to.not.equal(undefined);
      expect(mine.reason).to.contain("every vote in");
      expect(Number((await aao.getProposal(id)).status)).to.equal(1);
    });

    it("pins a level tally instead of executing it, and names no tie-breaker it does not have",
      async function () {
        const id = await submit(subId, builder, doc("The two interim voters disagree"));
        await aao.connect(builder).vote(id, true);
        await aao.connect(wren).vote(id, false);

        const { aaos, all } = await state();
        const { executed, waiting } = await W.executeDecided(
          aaos, all, options(all.filter((p) => p.id === id)[0].votes[0].at + 10 * HOUR));

        expect(executed.map((e) => e.id)).to.not.contain(id);
        const pinned = waiting.filter((w) => w.id === id)[0];
        expect(pinned, "a level tally must be reported, not swallowed").to.not.equal(undefined);
        expect(pinned.reason).to.contain("no tie-breaker");
        expect(Number((await aao.getProposal(id)).status), "and it stays open").to.equal(0);
      });

    it("says what it did, where the Director reads it", async function () {
      const written = messages().filter((m) => m.from === "watch" && m.type === "decision");
      expect(written.length, "every execution should have left a message").to.be.greaterThan(0);
      const last = written[written.length - 1];
      expect(last.subject).to.contain("executed automatically");
      expect(last.summary).to.contain("interim rule");
      expect(last.aaoId).to.equal(subId);
    });

    // Before proposal 58 this asserted that the main organisation executed
    // nothing at all from the watcher. It executes on the Director's vote now,
    // and what still holds is the half that matters here: it has no timer, so
    // a vote that is not the Director's never carries, however long it waits.
    it("gives the main organisation no timer: another voter's vote never carries",
      async function () {
        const id = await submit(mainId, director, doc("The Director's own organisation"));
        await aao.connect(wren).vote(id, true);

        const { aaos, all } = await state();
        const aYearOn = Math.floor(Date.now() / 1000) + 365 * 24 * HOUR;
        const { executed } = await W.executeDecided(aaos, all, options(aYearOn));
        expect(executed.map((e) => e.id)).to.not.contain(id);
        expect(Number((await aao.getProposal(id)).status)).to.equal(0);
      });
  });

  // --- the standing rule, once the widget has voted ----------------------

  describe("once the widget has cast its first vote", function () {
    before(async function () {
      // The vote that ends the interim regime. Nothing is unset anywhere: from
      // here on effectiveRules reads a different rule off the same chain.
      const first = await submit(subId, builder, doc("The one the widget votes on"));
      await aao.connect(widget).vote(first, true);
    });

    it("runs the standing rule, with Wren back to breaking ties", async function () {
      const { aaos, all } = await state();
      const sub = aaos.filter((a) => a.id === subId)[0];
      const rules = R.effectiveRules(sub, all.filter((p) => p.aaoId === subId));
      expect(rules.interim).to.not.equal(true);
      expect(rules.voters.map(R.labelFor)).to.deep.equal(["Builder", "Widget"]);
      expect(R.sameAddress(rules.casting, R.WREN)).to.equal(true);
      expect(rules.windowHours).to.equal(24);
    });

    it("holds a lone vote for a day now, not an hour", async function () {
      const id = await submit(subId, builder, doc("A lone vote under the standing rule"));
      await aao.connect(builder).vote(id, true);

      const { aaos, all } = await state();
      const votedAt = all.filter((p) => p.id === id)[0].votes[0].at;

      const early = await W.executeDecided(aaos, all, options(votedAt + 2 * HOUR));
      expect(early.executed.map((e) => e.id), "two hours is no longer enough").to.not.contain(id);
      expect(Number((await aao.getProposal(id)).status)).to.equal(0);

      const late = await W.executeDecided(aaos, all, options(votedAt + 25 * HOUR));
      expect(late.executed.map((e) => e.id), "twenty-five hours is").to.contain(id);
      expect(Number((await aao.getProposal(id)).status)).to.equal(1);
    });

    it("executes when the builder and the widget have both voted", async function () {
      const id = await submit(subId, builder, doc("Builder and widget agree"));
      await aao.connect(builder).vote(id, true);
      await aao.connect(widget).vote(id, true);

      const { aaos, all } = await state();
      const votedAt = all.filter((p) => p.id === id)[0].votes[0].at;
      // A minute in: with every voter of the standing rule in, no window applies.
      const { executed } = await W.executeDecided(aaos, all, options(votedAt + 60));
      const mine = executed.filter((e) => e.id === id)[0];
      expect(mine, "both standing voters in and decisive").to.not.equal(undefined);
      expect(mine.passed).to.equal(true);
      expect(mine.reason).to.contain("every vote in");
    });

    it("waits for Wren on a level tally rather than closing it", async function () {
      const id = await submit(subId, builder, doc("Builder and widget disagree"));
      await aao.connect(builder).vote(id, true);
      await aao.connect(widget).vote(id, false);

      const { aaos, all } = await state();
      const { executed, waiting } = await W.executeDecided(
        aaos, all, options(all.filter((p) => p.id === id)[0].votes[0].at + 48 * HOUR));

      expect(executed.map((e) => e.id)).to.not.contain(id);
      const pinned = waiting.filter((w) => w.id === id)[0];
      expect(pinned).to.not.equal(undefined);
      expect(pinned.reason).to.contain("Wren breaks it");
      expect(Number((await aao.getProposal(id)).status)).to.equal(0);
    });

    it("does not execute a vote it cannot date, whatever the rule", async function () {
      // The failure mode the original bug hid behind: with no timestamp there is
      // no window, and a watcher that guesses closes a proposal early. A missed
      // pass costs five minutes; an early execution cannot be undone.
      const id = await submit(subId, builder, doc("A vote with its timestamp stripped"));
      await aao.connect(builder).vote(id, true);

      const { aaos, all } = await state();
      const blinded = all.map((p) => (p.id === id
        ? Object.assign({}, p, { votes: p.votes.map((v) => Object.assign({}, v, { at: 0 })) })
        : p));

      const { executed, waiting } = await W.executeDecided(
        aaos, blinded, options(Math.floor(Date.now() / 1000) + 365 * 24 * HOUR));
      expect(executed.map((e) => e.id)).to.not.contain(id);
      expect(waiting.filter((w) => w.id === id)[0].reason).to.contain("cannot be measured");
      expect(Number((await aao.getProposal(id)).status)).to.equal(0);
    });
  });

  // --- the loop the server starts ----------------------------------------

  describe("start(), the loop that runs beside the server", function () {
    it("runs one pass on demand, checking triggers and closing what is decided",
      async function () {
        const id = await submit(subId, builder, doc("Closed by a pass of the loop"));
        await aao.connect(builder).vote(id, true);
        await aao.connect(widget).vote(id, true);

        const before = messages().length;
        let passes = 0;

        const loop = W.start(
          async () => {
            passes++;
            const aaos = await R.readAAOs(aao);
            return R.readAllProposals(aao, aaos);
          },
          Object.assign({}, options(undefined), {
            // No first pass on its own timer and no interval worth waiting for:
            // the test drives tick() itself, so the assertion is about what one
            // pass does and not about how long it takes to happen.
            firstDelayMs: 24 * HOUR * 1000,
            intervalMs: 24 * HOUR * 1000,
            readAaos: () => R.readAAOs(aao),
            latestBlock: () => ethers.provider.getBlock("latest")
          })
        );

        try {
          await loop.tick();
        } finally {
          loop.stop();
        }

        expect(passes, "the pass should have read the chain once").to.equal(1);
        expect(Number((await aao.getProposal(id)).status), "and closed the decided proposal")
          .to.equal(1);
        expect(messages().length, "and said so in the message log").to.be.greaterThan(before);
      });

    it("takes its clock from the chain, not the wall", async function () {
      const block = await ethers.provider.getBlock("latest");
      const fromChain = await W.chainNow({ latestBlock: () => ethers.provider.getBlock("latest") });
      expect(fromChain).to.equal(Number(block.timestamp));

      // An explicit clock wins, and a node that will not answer falls back to
      // the wall rather than stopping the watcher.
      expect(await W.chainNow({ nowSeconds: 42 })).to.equal(42);
      const fallback = await W.chainNow({
        latestBlock: () => { throw new Error("no node"); }
      });
      expect(fallback).to.be.closeTo(Math.floor(Date.now() / 1000), 5);
    });

    it("survives a pass that throws, because a watcher that dies watches nothing",
      async function () {
        const loop = W.start(
          async () => { throw new Error("the node went away"); },
          Object.assign({}, options(undefined), {
            firstDelayMs: 24 * HOUR * 1000,
            intervalMs: 24 * HOUR * 1000
          })
        );
        try {
          await loop.tick();     // must not reject
          await loop.tick();     // and must still be usable afterwards
        } finally {
          loop.stop();
        }
      });

    it("does nothing at all without a signer, so a read-only watcher stays read-only",
      async function () {
        const id = await submit(subId, builder, doc("Nothing should close this"));
        await aao.connect(builder).vote(id, true);
        await aao.connect(widget).vote(id, true);

        const { aaos, all } = await state();
        const result = await W.executeDecided(aaos, all, {
          ethers: ethers, diamond: diamondAddress, messagesFile: messagesFile
        });
        expect(result.executed).to.deep.equal([]);
        expect(Number((await aao.getProposal(id)).status)).to.equal(0);
      });
  });

  // --- the organisations where the Director's vote settles it -------------
  //
  // Proposal 58. The page executed these in the browser, so a proposal the
  // Director decided while the page was shut stayed Active until somebody
  // opened it. The watcher closes them now, on the same rule the page printed.
  describe("where the rule is on-director-vote", function () {
    async function sweep() {
      const { aaos, all } = await state();
      return W.executeDecided(aaos, all, options());
    }

    it("is the rule the main organisation runs", async function () {
      const { aaos, all } = await state();
      const main = aaos.filter((a) => a.id === mainId)[0];
      const rules = R.effectiveRules(main, all.filter((p) => p.aaoId === mainId));
      expect(rules.autoExecute).to.equal("on-director-vote");
      expect(R.sameAddress(rules.executeAs, R.DIRECTOR)).to.equal(true);
    });

    it("executes a decisive tally the moment the Director votes for", async function () {
      const id = await submit(mainId, director, doc("The Director votes for"));
      await aao.connect(director).vote(id, true);

      const { executed } = await sweep();
      const hit = executed.filter((e) => e.id === id)[0];
      expect(hit, "the watcher should have closed it").to.not.equal(undefined);
      expect(hit.passed).to.equal(true);
      expect(Number((await aao.getProposal(id)).status), "Executed").to.equal(1);
      expect(hit.reason).to.contain("The Director voted");

      const said = messages().filter((m) => m.proposal === id)[0];
      expect(said, "and it says so where the Director reads it").to.not.equal(undefined);
      expect(said.type).to.equal("decision");
    });

    it("executes a decisive tally the Director votes against, as rejected", async function () {
      const id = await submit(mainId, director, doc("The Director votes against"));
      await aao.connect(director).vote(id, false);

      const { executed } = await sweep();
      const hit = executed.filter((e) => e.id === id)[0];
      expect(hit, "a no is a decision too").to.not.equal(undefined);
      expect(hit.passed).to.equal(false);
      expect(Number((await aao.getProposal(id)).status), "Rejected").to.equal(2);
    });

    it("leaves a level tally to the casting vote and says so", async function () {
      const id = await submit(mainId, director, doc("Level, and the casting vote decides"));
      await aao.connect(director).vote(id, true);
      await aao.connect(wren).vote(id, false);

      const { executed, waiting } = await sweep();
      expect(executed.map((e) => e.id)).to.not.contain(id);
      expect(Number((await aao.getProposal(id)).status), "still open").to.equal(0);

      const held = waiting.filter((w) => w.id === id)[0];
      expect(held, "silence would look like nothing to decide").to.not.equal(undefined);
      expect(held.reason).to.contain("Casting vote");
    });

    it("does not execute without the Director's vote, decisive or not", async function () {
      const id = await submit(mainId, director, doc("Wren voted; the Director has not"));
      await aao.connect(wren).vote(id, true);

      const before = await readOne(mainId, id);
      expect(before.forVotes, "decisive on the numbers alone").to.equal(1);
      expect(before.againstVotes).to.equal(0);

      const { executed } = await sweep();
      expect(executed.map((e) => e.id)).to.not.contain(id);
      expect(Number((await aao.getProposal(id)).status), "still open").to.equal(0);

      const rules = R.rulesFor({ topic: "trilogy widget" });
      expect(R.autoExecuteState(rules, before).reason).to.contain("The Director has not voted");
    });
  });
});
