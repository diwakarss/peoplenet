// Puts the three governance roles on AAO 0 (spec section 24, WP17d).
//
//   Director      Hardhat account 0 -- deployer, AAO creator, already a member
//   Wren          Hardhat account 1 -- the architect session's ordinary vote
//   Casting vote  Hardhat account 2 -- the Director's tie-break, only used on a 1-1 tie
//
// AAOFacet.joinAAO is open: LibAAO.joinAAO only requires the AAO to be active
// and the caller not to be a member already, so each account joins for itself
// and the creator has nothing to approve. The script is idempotent -- accounts
// that are already members are left alone.
//
// Usage:
//   npx hardhat run scripts/setup-governance-members.js --network localhost

const { ethers } = require("hardhat");
const { DIAMOND, AAO_ID, labelFor } = require("../governance/read.js");

async function main() {
  const signers = await ethers.getSigners();
  const [director, wren, casting] = signers;
  if (!wren || !casting) {
    throw new Error("Need at least three accounts on this network (Hardhat defaults 0, 1, 2).");
  }

  const aaoFacet = await ethers.getContractAt("AAOFacet", DIAMOND);
  const aao = await aaoFacet.getAAO(AAO_ID);
  if (!aao.active) throw new Error(`AAO ${AAO_ID} is not active.`);

  console.log(`AAO ${AAO_ID}: "${aao.topic}"`);
  console.log(`creator:      ${aao.owner} (${labelFor(aao.owner)})`);
  console.log(`diamond:      ${DIAMOND}`);
  console.log("");

  const wanted = [
    { signer: director, label: "Director" },
    { signer: wren, label: "Wren" },
    { signer: casting, label: "Casting vote" }
  ];

  for (const { signer, label } of wanted) {
    const already = await aaoFacet.isMember(AAO_ID, signer.address);
    if (already) {
      console.log(`already a member  ${label.padEnd(12)} ${signer.address}`);
      continue;
    }
    const tx = await aaoFacet.connect(signer).joinAAO(AAO_ID);
    const receipt = await tx.wait();
    console.log(`joined            ${label.padEnd(12)} ${signer.address}  (block ${receipt.blockNumber})`);
  }

  console.log("");
  const members = await aaoFacet.getMembers(AAO_ID);
  console.log(`members of AAO ${AAO_ID} (${members.length}):`);
  for (const address of members) {
    const isCreator = address.toLowerCase() === aao.owner.toLowerCase();
    console.log(`  ${labelFor(address).padEnd(12)} ${address}${isCreator ? "  [creator]" : ""}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
