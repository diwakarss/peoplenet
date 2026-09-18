// Creates the "JD-build" sub-AAO and puts its members on it (proposal 51).
//
// JD is where the Director and Kural decide what to do. THIS is where Kural's
// builders build it. Builders never join JD; they work here, and the Director
// watches without voting.
//
//   Kural   Hardhat account 5 -- the architect, breaks a level tally
//   Kalam   Hardhat account 6 -- the builder, votes
//
// The Director creates the AAO and is its owner, which makes the Director a
// member by the contract's own rule; the rule set in governance/read.js is what
// says the Director watches here and never votes.
//
// AAOFacet.joinAAO is open, so each account joins for itself and the creator
// approves nobody. Idempotent: an existing AAO is reused and members already on
// it are left alone.
//
// Usage:
//   npx hardhat run scripts/create-jd-build-aao.js --network localhost

const { ethers } = require("hardhat");

const DIAMOND = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const TOPIC = "JD-build";
const TEN_YEARS = 10 * 365 * 24 * 3600;

const MEMBERS = [
  { index: 5, label: "Kural" },
  { index: 6, label: "Kalam" }
];

async function findAAO(aaoFacet, creator) {
  const existing = await aaoFacet.getAAOsByCreator(creator);
  for (const id of existing) {
    const a = await aaoFacet.getAAO(id);
    if (a.topic === TOPIC) return ethers.toNumber(id);
  }
  return null;
}

async function main() {
  const signers = await ethers.getSigners();
  const needed = Math.max(...MEMBERS.map(m => m.index));
  if (signers.length <= needed) throw new Error(`Need ${needed + 1} accounts; got ${signers.length}.`);
  const deployer = signers[0];
  const aaoFacet = await ethers.getContractAt("AAOFacet", DIAMOND);

  let aaoId = await findAAO(aaoFacet, deployer.address);
  if (aaoId === null) {
    const tx = await aaoFacet.createAAO(TOPIC, TEN_YEARS);
    const receipt = await tx.wait();
    const ev = receipt.logs.find(l => l.topics[0] === ethers.id("AAOCreated(uint256,string,address,uint256)"));
    aaoId = ev ? ethers.toNumber(ev.topics[1]) : null;
    console.log(`created AAO ${aaoId}: "${TOPIC}"  tx ${receipt.hash} block ${receipt.blockNumber}`);
  } else {
    console.log(`AAO ${aaoId} already exists: "${TOPIC}"`);
  }
  if (aaoId === null) throw new Error("the AAO id could not be read from the receipt");

  const aao = await aaoFacet.getAAO(aaoId);
  if (!aao.active) throw new Error(`AAO ${aaoId} is not active.`);

  for (const { index, label } of MEMBERS) {
    const signer = signers[index];
    if (await aaoFacet.isMember(aaoId, signer.address)) {
      console.log(`already a member  ${label.padEnd(7)} account ${index}  ${signer.address}`);
      continue;
    }
    const tx = await aaoFacet.connect(signer).joinAAO(aaoId);
    const receipt = await tx.wait();
    console.log(`joined            ${label.padEnd(7)} account ${index}  ${signer.address}  tx ${receipt.hash} block ${receipt.blockNumber}`);
  }

  console.log(`\nJD-build AAO id: ${aaoId}`);
  console.log(`File here with:  node scripts/propose.js --aao ${aaoId} --account <5|6> --title ... --summary ... --why ... --send`);
}

main().catch(e => { console.error(e); process.exit(1); });
