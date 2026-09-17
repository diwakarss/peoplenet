// Creates the "widget-builder" sub-AAO and puts its four members on it
// (learning-assist spec sections 25 and 27.4, WP20).
//
// This is the room where the widget, its builder and Wren talk. The trilogy widget AAO
// (topic "trilogy widget", created by scripts/create-trilogy-widget-aao.js) is where the
// operator votes on what the widget should become; THIS one is where the three agents
// work out what to propose in the first place.
//
//   Director   Hardhat account 0 -- may vote, is never blocked on
//   Wren       Hardhat account 1 -- the assistant director, the channel watcher
//   Builder    Hardhat account 3 -- the standing builder, files when it is unsure
//   Widget     Hardhat account 4 -- votes through the optional add-on, on proposals
//                                   that touch its own behaviour (27.8)
//
// AAOFacet.joinAAO is open (LibAAO only requires an active AAO and a caller who is not
// already a member), so each account joins for itself and the creator approves nothing.
// The script is idempotent: an existing AAO is reused and members already on it are left
// alone, so running it twice is safe.
//
// Usage:
//   npx hardhat run scripts/create-widget-builder-aao.js --network localhost

const { ethers } = require("hardhat");

const DIAMOND = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const TOPIC = "widget-builder";
const TEN_YEARS = 10 * 365 * 24 * 3600;

//: account index -> what that account IS in this room.
const MEMBERS = [
  { index: 0, label: "Director" },
  { index: 1, label: "Wren" },
  { index: 3, label: "Builder" },
  { index: 4, label: "Widget" }
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
  if (signers.length <= needed) {
    throw new Error(`Need at least ${needed + 1} accounts on this network; got ${signers.length}.`);
  }
  const deployer = signers[0];
  const aaoFacet = await ethers.getContractAt("AAOFacet", DIAMOND);

  let aaoId = await findAAO(aaoFacet, deployer.address);
  if (aaoId === null) {
    const tx = await aaoFacet.createAAO(TOPIC, TEN_YEARS);
    const receipt = await tx.wait();
    const ev = receipt.logs.find(
      l => l.topics[0] === ethers.id("AAOCreated(uint256,string,address,uint256)"));
    aaoId = ev ? ethers.toNumber(ev.topics[1]) : null;
    console.log(`created AAO ${aaoId}: "${TOPIC}"`);
  } else {
    console.log(`AAO ${aaoId} already exists: "${TOPIC}"`);
  }
  if (aaoId === null) throw new Error("the AAO id could not be read from the receipt");

  const aao = await aaoFacet.getAAO(aaoId);
  if (!aao.active) throw new Error(`AAO ${aaoId} is not active.`);
  console.log(`diamond: ${DIAMOND}`);
  console.log("");

  for (const { index, label } of MEMBERS) {
    const signer = signers[index];
    const already = await aaoFacet.isMember(aaoId, signer.address);
    if (already) {
      console.log(`already a member  ${label.padEnd(9)} account ${index}  ${signer.address}`);
      continue;
    }
    const tx = await aaoFacet.connect(signer).joinAAO(aaoId);
    await tx.wait();
    console.log(`joined            ${label.padEnd(9)} account ${index}  ${signer.address}`);
  }

  console.log("");
  console.log(`widget-builder AAO id: ${aaoId}`);
  console.log("File a proposal here with:  node scripts/builder-propose.js \"<text>\"");
}

main().catch(e => { console.error(e); process.exit(1); });
