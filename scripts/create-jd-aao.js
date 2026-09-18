// Creates the "JD" AAO, the working room for every task from 2026-09-19 on, and
// puts its members on it. Same shape as create-widget-builder-aao.js: idempotent,
// each account joins for itself, the creator approves nothing.
//
//   Director       Hardhat account 0 -- the only human; main-AAO vote and veto
//   Wren           Hardhat account 1 -- architect
//   Casting vote   Hardhat account 2 -- the Director's tie-break, on a tie only
//   Kural          Hardhat account 5 -- architect
//
// Usage:
//   npx hardhat run scripts/create-jd-aao.js --network localhost

const { ethers } = require("hardhat");

const DIAMOND = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const TOPIC = "JD";
const TEN_YEARS = 10 * 365 * 24 * 3600;

const MEMBERS = [
  { index: 0, label: "Director" },
  { index: 1, label: "Wren" },
  { index: 2, label: "Casting" },
  { index: 5, label: "Kural" }
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

  for (const { index, label } of MEMBERS) {
    const signer = signers[index];
    if (await aaoFacet.isMember(aaoId, signer.address)) {
      console.log(`already a member  ${label.padEnd(9)} account ${index}  ${signer.address}`);
      continue;
    }
    const tx = await aaoFacet.connect(signer).joinAAO(aaoId);
    await tx.wait();
    console.log(`joined            ${label.padEnd(9)} account ${index}  ${signer.address}`);
  }
  console.log(`\nJD AAO id: ${aaoId}`);
  console.log(`File here with:  node scripts/propose.js --aao ${aaoId} --account <0|1|5> --title ... --summary ... --why ... --send`);
}

main().catch(e => { console.error(e); process.exit(1); });
