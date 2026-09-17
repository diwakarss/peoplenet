// Prove a diamondCut moved no state.
//
// Comparing two snapshots is weak when other sessions are voting: a real vote
// between the two reads looks exactly like damage. So this checks an invariant
// instead, one that cannot hold by accident if state were lost:
//
//   every proposal's tally equals the VoteCast events on it,
//   every proposal's status equals its last ProposalExecuted event (or Active),
//   every proposal's text equals the text in its ProposalSubmitted event,
//   every AAO's member list equals its creator plus its AAOMemberJoined events.
//
// The events are the chain's own history and the storage is what the facet
// reads; if the facet swap had disturbed the storage, they would disagree.
//
// Usage:
//   node scripts/verify-after-cut.js
process.env.HARDHAT_NETWORK = process.env.HARDHAT_NETWORK || "localhost";

const { ethers } = require("hardhat");
const R = require("../governance/read.js");

async function main() {
  const A = await ethers.getContractAt("AAOFacet", R.DIAMOND);
  const problems = [];
  const ok = [];
  const phantomVotes = [];

  const aaoCount = Number(await A.aaoCount());
  console.log(`Diamond ${R.DIAMOND}`);
  console.log(`block   ${await ethers.provider.getBlockNumber()}`);
  console.log(`AAOs    ${aaoCount}`);

  const submitted = await A.queryFilter(A.filters.ProposalSubmitted(), 0, "latest");
  const votes = await A.queryFilter(A.filters.VoteCast(), 0, "latest");
  const executed = await A.queryFilter(A.filters.ProposalExecuted(), 0, "latest");
  const joined = await A.queryFilter(A.filters.AAOMemberJoined(), 0, "latest");
  const created = await A.queryFilter(A.filters.AAOCreated(), 0, "latest");

  console.log(`events  ${submitted.length} submitted, ${votes.length} votes, ${executed.length} executed, ${joined.length} joins`);
  console.log("");

  // --- every AAO ---
  for (let id = 0; id < aaoCount; id++) {
    const aao = await A.getAAO(id);
    const createdEvent = created.filter((e) => Number(e.args.aaoId) === id)[0];
    if (!createdEvent) {
      problems.push(`AAO ${id} has no AAOCreated event`);
      continue;
    }
    if (aao.topic !== createdEvent.args.topic) {
      problems.push(`AAO ${id} topic is "${aao.topic}", the event said "${createdEvent.args.topic}"`);
    }
    const expectedMembers = [aao.owner.toLowerCase()].concat(
      joined.filter((e) => Number(e.args.aaoId) === id).map((e) => e.args.member.toLowerCase())
    );
    const actualMembers = (aao.members || []).map((m) => m.toLowerCase());
    if (JSON.stringify(expectedMembers) !== JSON.stringify(actualMembers)) {
      problems.push(
        `AAO ${id} members are [${actualMembers.join(", ")}], the events say [${expectedMembers.join(", ")}]`
      );
    } else {
      ok.push(`AAO ${id} "${aao.topic}": ${actualMembers.length} members match the events`);
    }
  }

  // --- every proposal ---
  const ids = submitted.map((e) => Number(e.args.proposalId)).sort((a, b) => a - b);
  for (const id of ids) {
    const p = await A.getProposal(id);
    const filedEvent = submitted.filter((e) => Number(e.args.proposalId) === id)[0];

    if (p.text !== filedEvent.args.text) {
      problems.push(`proposal ${id} text differs from its ProposalSubmitted event`);
    }
    if (p.proposer.toLowerCase() !== filedEvent.args.proposer.toLowerCase()) {
      problems.push(`proposal ${id} proposer differs from its event`);
    }
    if (Number(p.aaoId) !== Number(filedEvent.args.aaoId)) {
      problems.push(`proposal ${id} aaoId differs from its event`);
    }
    if (Number(p.createdAt) === 0) {
      problems.push(`proposal ${id} was filed but has createdAt 0`);
    }

    // Only votes cast at or after the proposal was filed count. A vote on an id
    // before it was filed hit the zero struct, emitted a VoteCast, and was then
    // wiped when submitProposal overwrote the struct -- while hasVoted survived,
    // which is the damage the new guard prevents. Those phantom events are
    // reported separately rather than counted as a mismatch.
    const mine = votes.filter((e) => Number(e.args.proposalId) === id);
    const real = mine.filter((e) => e.blockNumber >= filedEvent.blockNumber);
    const phantom = mine.filter((e) => e.blockNumber < filedEvent.blockNumber);
    const forVotes = real.filter((e) => e.args.support).length;
    const againstVotes = real.filter((e) => !e.args.support).length;
    if (Number(p.forVotes) !== forVotes || Number(p.againstVotes) !== againstVotes) {
      problems.push(
        `proposal ${id} tally is ${p.forVotes}-${p.againstVotes}, the events say ${forVotes}-${againstVotes}`
      );
    }
    phantom.forEach((e) => {
      phantomVotes.push(
        `proposal ${id}: ${R.labelFor(e.args.voter)} voted at block ${e.blockNumber}, ` +
        `before it was filed at block ${filedEvent.blockNumber}`
      );
    });

    const closings = executed.filter((e) => Number(e.args.proposalId) === id);
    const expectedStatus = closings.length
      ? (closings[closings.length - 1].args.passed ? 1 : 2)
      : 0;
    if (Number(p.status) !== expectedStatus) {
      problems.push(
        `proposal ${id} status is ${R.STATUS[Number(p.status)]}, the events say ${R.STATUS[expectedStatus]}`
      );
    }
  }
  ok.push(`${ids.length} proposals (ids ${ids[0]} to ${ids[ids.length - 1]}): text, proposer, tally and status all match the events`);

  // --- the guard is live ---
  let guarded = false;
  try {
    await A.vote.staticCall(99999, true);
  } catch (e) {
    guarded = /Proposal does not exist/.test(e.message || "");
  }
  if (!guarded) problems.push("a vote on an unfiled id is not refused: the guard is not live");
  else ok.push("a vote on an unfiled id is refused: the guard is live");

  let execGuarded = false;
  try {
    await A.executeProposal.staticCall(99999);
  } catch (e) {
    execGuarded = /Proposal does not exist/.test(e.message || "");
  }
  if (!execGuarded) problems.push("executing an unfiled id is not refused");
  else ok.push("executing an unfiled id is refused");

  ok.forEach((line) => console.log(`  ok  ${line}`));

  if (phantomVotes.length) {
    console.log("");
    console.log(`${phantomVotes.length} vote(s) were cast on an id before it was filed. Those are the`);
    console.log("lost votes the new guard prevents; they are history, not damage from the cut:");
    phantomVotes.forEach((line) => console.log(`  --  ${line}`));
  }
  if (problems.length) {
    console.log("");
    problems.forEach((line) => console.error(`  FAIL  ${line}`));
    process.exit(1);
  }
  console.log("");
  console.log("The facet was replaced and the state is exactly what the chain's own events say it should be.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
