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
  let outsider;       // account 3: never a member
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
    [director, wren, casting, outsider] = await ethers.getSigners();

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
