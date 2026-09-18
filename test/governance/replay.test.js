// The replay script (proposal 50): the record moves from one diamond to
// another with every id, tally and status identical, and a second run sends
// nothing.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { getSelectors, FacetCutAction } = require("../helpers/diamond");
const Replay = require("../../scripts/replay-chain.js");

async function freshDiamond(owner) {
  const DiamondCutFacet = await ethers.getContractFactory("DiamondCutFacet");
  const cut = await DiamondCutFacet.deploy();
  const Diamond = await ethers.getContractFactory("DiamondController");
  const diamond = await Diamond.deploy(owner.address, await cut.getAddress());
  const AAOFacet = await ethers.getContractFactory("AAOFacet");
  const facet = await AAOFacet.deploy();
  const address = await diamond.getAddress();
  const diamondCut = await ethers.getContractAt("IDiamondCut", address);
  // As the owner: LibDiamond lets nobody else cut, and the tests below need a
  // diamond whose owner is not account 0.
  await diamondCut.connect(owner).diamondCut(
    [{ facetAddress: await facet.getAddress(), action: FacetCutAction.Add, functionSelectors: getSelectors(facet) }],
    ethers.ZeroAddress, "0x");
  return ethers.getContractAt("AAOFacet", address);
}

describe("replay-chain: the record moves intact", function () {
  let signers, source, target, data;

  before(async function () {
    signers = await ethers.getSigners();
    const [director, wren, casting, , , kural] = signers;
    source = await freshDiamond(director);

    // Two organisations, a member who leaves, four proposals in every state.
    await source.connect(director).createAAO("trilogy widget", 3600);
    await source.connect(wren).joinAAO(0);
    await source.connect(casting).joinAAO(0);
    await source.connect(director).createAAO("JD", 7200);
    await source.connect(wren).joinAAO(1);
    await source.connect(kural).joinAAO(1);
    await source.connect(wren).leaveAAO(1);

    await source.connect(director).submitProposal(0, JSON.stringify({ title: "p0 passes", summary: "s", why: "w" }));
    await source.connect(wren).submitProposal(0, JSON.stringify({ title: "p1 rejected on a tie", summary: "s", why: "w" }));
    await source.connect(kural).submitProposal(1, JSON.stringify({ title: "p2 open", summary: "s", why: "w" }));
    await source.connect(director).submitProposal(1, JSON.stringify({ title: "p3 passes on JD", summary: "s", why: "w" }));

    await source.connect(director).vote(0, true);
    await source.connect(wren).vote(0, true);
    await source.connect(director).executeProposal(0);
    await source.connect(director).vote(1, true);
    await source.connect(wren).vote(1, false);
    await source.connect(director).executeProposal(1);
    await source.connect(kural).vote(2, true);
    await source.connect(kural).vote(3, true);
    await source.connect(director).vote(3, true);
    await source.connect(director).executeProposal(3);

    data = await Replay.exportEvents(source, ethers.provider, signers);
    target = await freshDiamond(director);
  });

  it("exports every governance event in chain order with its actor's account index", function () {
    const names = data.events.map((e) => e.name);
    expect(names[0]).to.equal("AAOCreated");
    expect(names).to.include("AAOMemberLeft");
    expect(names.filter((n) => n === "ProposalExecuted")).to.have.length(3);
    const left = data.events.find((e) => e.name === "AAOMemberLeft");
    expect(left.account).to.equal(1);
    const jd = data.events.find((e) => e.name === "ProposalSubmitted" && e.args.aaoId === "1");
    expect(jd.account).to.equal(5);
    for (let i = 1; i < data.events.length; i++) {
      const a = data.events[i - 1], b = data.events[i];
      expect(a.block < b.block || (a.block === b.block && a.logIndex < b.logIndex)).to.equal(true);
    }
  });

  it("rehearses without sending anything", async function () {
    const r = await Replay.replayEvents(data, target, signers, { send: false });
    expect(r.sent).to.equal(data.events.length);
    expect(Number(await target.aaoCount())).to.equal(0);
  });

  it("replays onto a fresh diamond with identical ids, tallies and statuses", async function () {
    const r = await Replay.replayEvents(data, target, signers, { send: true });
    expect(r.mismatches).to.deep.equal([]);
    expect(r.sent).to.equal(data.events.length);
    const v = await Replay.verifyState(data, target, signers);
    expect(v.problems).to.deep.equal([]);
    expect(v.ok).to.equal(true);
    const p1 = await target.getProposal(1);
    expect(Number(p1.status)).to.equal(2);
    const p2 = await target.getProposal(2);
    expect(Number(p2.status)).to.equal(0);
    expect(p2.forVotes.toString()).to.equal("1");
    expect(await target.isMember(1, signers[1].address)).to.equal(false);
    expect(await target.isMember(1, signers[5].address)).to.equal(true);
  });

  it("is idempotent: a second replay sends nothing", async function () {
    const r = await Replay.replayEvents(data, target, signers, { send: true });
    expect(r.sent).to.equal(0);
    expect(r.skipped).to.equal(data.events.length);
    expect(r.mismatches).to.deep.equal([]);
  });

  it("stops on the first id that would not match", async function () {
    const other = await freshDiamond(signers[0]);
    await other.connect(signers[0]).createAAO("something else", 10);
    const r = await Replay.replayEvents(data, other, signers, { send: true });
    expect(r.mismatches.length).to.be.greaterThan(0);
    const v = await Replay.verifyState(data, other, signers);
    expect(v.ok).to.equal(false);
  });

  it("stops when a proposal id the record uses already holds different text", async function () {
    const other = await freshDiamond(signers[0]);
    await other.connect(signers[0]).createAAO("trilogy widget", 3600);
    await other.connect(signers[1]).joinAAO(0);
    await other.connect(signers[2]).joinAAO(0);
    await other.connect(signers[0]).submitProposal(0, "a different proposal 0");
    const r = await Replay.replayEvents(data, other, signers, { send: true });
    expect(r.mismatches).to.deep.equal(["proposal 0 exists with different text"]);
  });

  it("verify reports an AAO whose owner is not the record's", async function () {
    const other = await freshDiamond(signers[1]);
    await other.connect(signers[1]).createAAO("trilogy widget", 3600);
    const v = await Replay.verifyState(data, other, signers);
    expect(v.ok).to.equal(false);
    expect(v.problems.filter((x) => /^AAO 0 owner /.test(x))).to.have.length(1);
    expect(v.problems.filter((x) => /^AAO 0 topic /.test(x))).to.have.length(0);
  });

  // The live record carries three of these: a vote the old facet accepted on a
  // proposal id that had not been filed. The current facet refuses it, so the
  // replay must name it and carry on, or the record cannot move at all.
  it("refuses a vote cast before its proposal was filed, and moves the rest", async function () {
    const other = await freshDiamond(signers[0]);
    const at = data.events.findIndex((e) => e.name === "ProposalSubmitted" && e.args.proposalId === "3");
    const stray = {
      name: "VoteCast", block: data.events[at].block, logIndex: 0,
      actor: signers[1].address, account: 1,
      args: { aaoId: "1", proposalId: "3", voter: signers[1].address, support: true }
    };
    const doctored = Object.assign({}, data, {
      events: data.events.slice(0, at).concat([stray], data.events.slice(at))
    });

    const r = await Replay.replayEvents(doctored, other, signers, { send: true });
    expect(r.refused).to.have.length(1);
    expect(r.refused[0]).to.match(/^VoteCast on proposal 3 by account 1 /);
    expect(r.mismatches).to.deep.equal([]);
    expect(r.sent).to.equal(data.events.length);

    // Verify is the proof that the refused event changed nothing the record shows.
    const v = await Replay.verifyState(data, other, signers);
    expect(v.problems).to.deep.equal([]);

    // And the refusal is the same on every run, so the replay stays idempotent.
    const again = await Replay.replayEvents(doctored, other, signers, { send: true });
    expect(again.sent).to.equal(0);
    expect(again.refused).to.have.length(1);
  });

  // Last: it writes to the source, which every test above reads.
  it("exports one block height, so the events and the state cannot disagree", async function () {
    expect(data.events.every((e) => e.block <= data.blockNumber)).to.equal(true);
    await source.connect(signers[0]).createAAO("filed after the export", 60);
    const pinned = await Replay.snapshot(source, data.blockNumber);
    expect(JSON.stringify(pinned)).to.equal(JSON.stringify(data.state));
    const head = await Replay.snapshot(source);
    expect(head.aaoCount).to.equal(data.state.aaoCount + 1);
  });
});
