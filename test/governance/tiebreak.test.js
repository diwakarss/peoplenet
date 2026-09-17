// The tie-break rule behind the governance page (spec section 24, WP17d).
//
// AAOFacet is one member, one vote, and executeProposal passes a proposal only
// on forVotes > againstVotes -- so a 1-1 tie rejects. The tie-break is therefore
// membership, not a contract change: a third member, the Director's casting
// vote, whose vote the page offers only when the two ordinary members are tied.
//
// These tests pin down both halves of that: what the chain does (the casting
// vote is the whole difference between a tie rejecting and passing), and what
// the page's rule does (castingVoteState, shared with governance/app.js, refuses
// to offer the casting vote when there is no tie).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const { getSelectors, FacetCutAction } = require("../helpers/diamond");
const R = require("../../governance/read.js");

describe("governance tie-break", function () {
  let aao;            // AAOFacet, called through the diamond
  let director;       // account 0: deployer, AAO creator
  let wren;           // account 1: the architect session's ordinary vote
  let casting;        // account 2: the Director's casting vote
  let outsider;       // account 5: never a member of anything
  // Accounts 3 and 4 are the builder and the widget, and they belong to the
  // widget-builder sub-AAO below -- so the outsider cannot be one of them.
  let aaoId;
  let tieProposal;    // votes 1-1
  let clearProposal;  // votes 2-0
  let roleOptions;    // address overrides for read.js's tie rule

  const ACTIVE = 0;
  const EXECUTED = 1;
  const REJECTED = 2;

  async function submit(text) {
    const tx = await aao.connect(director).submitProposal(aaoId, text);
    const receipt = await tx.wait();
    const log = receipt.logs
      .map((l) => { try { return aao.interface.parseLog(l); } catch (e) { return null; } })
      .find((p) => p && p.name === "ProposalSubmitted");
    return Number(log.args.proposalId);
  }

  before(async function () {
    const signers = await ethers.getSigners();
    director = signers[0];
    wren = signers[1];
    casting = signers[2];
    outsider = signers[5];

    // Fresh diamond with just the AAO facet on it.
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

    roleOptions = {
      director: director.address,
      wren: wren.address,
      casting: casting.address
    };

    // Seed: one AAO, three members, two proposals.
    const createTx = await aao.connect(director).createAAO("trilogy widget (test)", 3600);
    const createReceipt = await createTx.wait();
    const created = createReceipt.logs
      .map((l) => { try { return aao.interface.parseLog(l); } catch (e) { return null; } })
      .find((p) => p && p.name === "AAOCreated");
    aaoId = Number(created.args.aaoId);

    await aao.connect(wren).joinAAO(aaoId);
    await aao.connect(casting).joinAAO(aaoId);

    tieProposal = await submit("Tie me: the one the ordinary members split on.");
    clearProposal = await submit("Clear me: the one both ordinary members back.");
  });

  it("seeds the AAO with exactly the three governance roles", async function () {
    const members = await aao.getMembers(aaoId);
    expect(members.length).to.equal(3);
    expect(members[0]).to.equal(director.address); // the creator is the first member
    expect(members).to.include(wren.address);
    expect(members).to.include(casting.address);
    expect(await aao.isMember(aaoId, outsider.address)).to.equal(false);
  });

  it("files two proposals, both open", async function () {
    for (const id of [tieProposal, clearProposal]) {
      const p = await aao.getProposal(id);
      expect(Number(p.aaoId)).to.equal(aaoId);
      expect(Number(p.status)).to.equal(ACTIVE);
      expect(p.proposer).to.equal(director.address);
    }
  });

  describe("a 1-1 tie", function () {
    let snapshot;

    before(async function () {
      // The Director for, Wren against: one member, one vote, dead level.
      await aao.connect(director).vote(tieProposal, true);
      await aao.connect(wren).vote(tieProposal, false);

      const p = await aao.getProposal(tieProposal);
      expect(Number(p.forVotes)).to.equal(1);
      expect(Number(p.againstVotes)).to.equal(1);

      // Everything below runs from this exact tie, so the casting vote is the
      // only difference between the two outcomes.
      snapshot = await takeSnapshot();
    });

    afterEach(async function () {
      await snapshot.restore();
    });

    it("rejects on execute when nobody breaks it", async function () {
      await expect(aao.connect(director).executeProposal(tieProposal))
        .to.emit(aao, "ProposalExecuted")
        .withArgs(aaoId, tieProposal, false);

      const p = await aao.getProposal(tieProposal);
      expect(Number(p.status)).to.equal(REJECTED);
    });

    it("passes on execute once the casting vote is cast for it", async function () {
      await aao.connect(casting).vote(tieProposal, true);

      const p = await aao.getProposal(tieProposal);
      expect(Number(p.forVotes)).to.equal(2);
      expect(Number(p.againstVotes)).to.equal(1);

      await expect(aao.connect(director).executeProposal(tieProposal))
        .to.emit(aao, "ProposalExecuted")
        .withArgs(aaoId, tieProposal, true);

      expect(Number((await aao.getProposal(tieProposal)).status)).to.equal(EXECUTED);
    });

    it("stays rejected if the casting vote is cast against it", async function () {
      await aao.connect(casting).vote(tieProposal, false);
      await expect(aao.connect(director).executeProposal(tieProposal))
        .to.emit(aao, "ProposalExecuted")
        .withArgs(aaoId, tieProposal, false);
      expect(Number((await aao.getProposal(tieProposal)).status)).to.equal(REJECTED);
    });

    it("is offered the casting vote by the page's rule", async function () {
      const [p] = (await R.readProposals(aao, aaoId)).filter((x) => x.id === tieProposal);
      const state = R.castingVoteState(p, roleOptions);
      expect(state.allowed).to.equal(true);
      expect(state.reason).to.contain("casting vote decides");
    });

    it("withdraws the offer once the casting vote has been used", async function () {
      await aao.connect(casting).vote(tieProposal, true);
      const [p] = (await R.readProposals(aao, aaoId)).filter((x) => x.id === tieProposal);
      expect(R.castingVoteState(p, roleOptions).allowed).to.equal(false);
    });
  });

  describe("a proposal with no tie", function () {
    before(async function () {
      // Both ordinary members for: 2-0, nothing to break.
      await aao.connect(director).vote(clearProposal, true);
      await aao.connect(wren).vote(clearProposal, true);
    });

    it("is not offered the casting vote by the page's rule", async function () {
      const [p] = (await R.readProposals(aao, aaoId)).filter((x) => x.id === clearProposal);
      expect(p.forVotes).to.equal(2);
      expect(p.againstVotes).to.equal(0);
      const state = R.castingVoteState(p, roleOptions);
      expect(state.allowed).to.equal(false);
      expect(state.reason).to.contain("No tie to break");
    });

    it("cannot be flipped by the casting account: it gets one vote, like everyone else", async function () {
      await aao.connect(casting).vote(clearProposal, false);

      const after = await aao.getProposal(clearProposal);
      expect(Number(after.forVotes)).to.equal(2);
      expect(Number(after.againstVotes)).to.equal(1);

      // A second vote is refused by the contract -- no double weight for the
      // casting account, so 2-0 cannot become 2-2.
      await expect(aao.connect(casting).vote(clearProposal, false))
        .to.be.revertedWith("AAOFacet: Already voted");

      // And the outcome is unchanged: still a pass.
      await expect(aao.connect(director).executeProposal(clearProposal))
        .to.emit(aao, "ProposalExecuted")
        .withArgs(aaoId, clearProposal, true);
      expect(Number((await aao.getProposal(clearProposal)).status)).to.equal(EXECUTED);
    });
  });

  // The chain half of 27.4. The message stream is files, and governance/check.js
  // covers that; what belongs here is who is on the sub-AAO and what that
  // membership lets them do.
  describe("the widget-builder sub-AAO", function () {
    let subId;
    let builder;
    let widget;

    before(async function () {
      const signers = await ethers.getSigners();
      builder = signers[3];
      widget = signers[4];

      const tx = await aao.connect(director).createAAO("widget-builder", 3600);
      const receipt = await tx.wait();
      const created = receipt.logs
        .map((l) => { try { return aao.interface.parseLog(l); } catch (e) { return null; } })
        .find((p) => p && p.name === "AAOCreated");
      subId = Number(created.args.aaoId);

      // joinAAO is open, so each account joins for itself.
      await aao.connect(wren).joinAAO(subId);
      await aao.connect(builder).joinAAO(subId);
      await aao.connect(widget).joinAAO(subId);
    });

    it("has the four members 27.4 names, and nobody else", async function () {
      const members = await aao.getMembers(subId);
      expect(members.length).to.equal(4);
      expect(members[0]).to.equal(director.address); // the creator is first
      expect(members).to.include(wren.address);
      expect(members).to.include(builder.address);
      expect(members).to.include(widget.address);
      expect(await aao.isMember(subId, outsider.address)).to.equal(false);
    });

    it("is a separate organisation: membership does not leak either way", async function () {
      expect(await aao.isMember(subId, casting.address)).to.equal(false);
      expect(await aao.isMember(aaoId, builder.address)).to.equal(false);
      expect(await aao.isMember(aaoId, widget.address)).to.equal(false);
    });

    it("lets the widget file and vote on a proposal about its own behaviour", async function () {
      const tx = await aao.connect(widget).submitProposal(
        subId,
        JSON.stringify({
          title: "Stop answering while the citation cache is stale",
          summary: "When a source file changes mid-turn the widget should re-read it rather than quote the copy it cached.",
          why: "It quoted text that no longer existed, which a person then read as current.",
          from: "widget"
        })
      );
      const receipt = await tx.wait();
      const log = receipt.logs
        .map((l) => { try { return aao.interface.parseLog(l); } catch (e) { return null; } })
        .find((p) => p && p.name === "ProposalSubmitted");
      const id = Number(log.args.proposalId);

      const filed = await aao.getProposal(id);
      expect(Number(filed.aaoId)).to.equal(subId);
      expect(filed.proposer).to.equal(widget.address);

      await aao.connect(widget).vote(id, true);
      await aao.connect(builder).vote(id, true);
      expect(Number((await aao.getProposal(id)).forVotes)).to.equal(2);
    });

    it("refuses a proposal from someone who is not on it", async function () {
      await expect(aao.connect(casting).submitProposal(subId, "not a member here"))
        .to.be.revertedWith("AAOFacet: Not a member");
    });

    it("reads back through the page's data layer with the right labels", async function () {
      const sub = await R.readAAO(aao, subId);
      expect(sub.topic).to.equal("widget-builder");
      const labels = sub.members.map((m) => m.label).sort();
      expect(labels).to.deep.equal(["Builder", "Director", "Widget", "Wren"]);
      expect(R.AAO_NOTES[sub.topic]).to.be.a("string");

      // The page lists both organisations, in id order.
      const all = await R.readAAOs(aao);
      expect(all.map((a) => a.topic)).to.include("widget-builder");
      expect(all.map((a) => a.id)).to.deep.equal(all.map((a, i) => i));
    });

    it("keeps the widget's proposal in the 27.1 format the page can render", async function () {
      const proposals = await R.readProposals(aao, subId);
      expect(proposals.length).to.be.greaterThan(0);
      const mine = proposals.filter((p) => R.sameAddress(p.proposer, widget.address))[0];
      expect(mine, "the widget's proposal").to.exist;
      expect(mine.format.legacy).to.equal(false);
      expect(mine.format.valid.ok).to.equal(true);
      expect(R.proposalHeadline(mine)).to.equal("Stop answering while the citation cache is stale");
      expect(mine.proposerLabel).to.equal("Widget");
    });
  });

  describe("who may act at all", function () {
    it("refuses a vote from a non-member", async function () {
      const id = await submit("An outsider should not be able to touch this.");
      await expect(aao.connect(outsider).vote(id, true))
        .to.be.revertedWith("AAOFacet: Not a member");
    });

    it("refuses execution from a non-member", async function () {
      const id = await submit("Nor execute it.");
      await expect(aao.connect(outsider).executeProposal(id))
        .to.be.revertedWith("AAOFacet: Not a member");
    });

    it("refuses a second execution", async function () {
      const id = await submit("Executed once is executed for good.");
      await aao.connect(director).vote(id, true);
      await aao.connect(director).executeProposal(id);
      await expect(aao.connect(director).executeProposal(id))
        .to.be.revertedWith("AAOFacet: Proposal not active");
    });
  });
});
