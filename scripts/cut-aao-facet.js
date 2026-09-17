// Replace the AAOFacet on the live Diamond, and nothing else.
//
// The Diamond at 0xe7f1725E... holds the whole governance record: two AAOs and
// thirty-three proposals. A redeploy would throw that away. A diamondCut does
// not: it repoints the Diamond's selectors at a newly deployed facet, and the
// state stays exactly where it is, because the state was never in the facet.
//
// The facet's storage is LibAAO's diamond storage at a fixed slot, and the new
// facet declares no new variables, so the layout is unchanged and every
// selector already exists -- which makes this a pure Replace, no Add, no Remove.
// The script refuses if that is not true, because an Add hiding among Replaces
// is how a facet swap turns into a migration nobody planned.
//
// Usage:
//   node scripts/cut-aao-facet.js --dry-run      # print the cut, send nothing
//   node scripts/cut-aao-facet.js                # deploy and cut
process.env.HARDHAT_NETWORK = process.env.HARDHAT_NETWORK || "localhost";

const { ethers } = require("hardhat");
const R = require("../governance/read.js");

const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };

function selectorsOf(contract) {
  const fragments = contract.interface.fragments.filter((f) => f.type === "function");
  return fragments.map((f) => ({
    selector: contract.interface.getFunction(f.format()).selector,
    signature: f.format()
  }));
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const [deployer] = await ethers.getSigners();

  const loupe = await ethers.getContractAt("IDiamondLoupe", R.DIAMOND);

  // What the Diamond points at today.
  const before = new Map();
  let facets;
  try {
    facets = await loupe.facets();
  } catch (e) {
    throw new Error(
      "The Diamond has no loupe, so the current selectors cannot be read. " +
      "Refusing to cut blind."
    );
  }
  for (const f of facets) {
    for (const s of f.functionSelectors) before.set(s.toLowerCase(), f.facetAddress);
  }

  // Compile-time view of the new facet, before spending anything on it.
  const AAOFacet = await ethers.getContractFactory("AAOFacet");
  const planned = selectorsOf(AAOFacet.attach(ethers.ZeroAddress));

  const replace = [];
  const add = [];
  for (const { selector, signature } of planned) {
    if (before.has(selector.toLowerCase())) replace.push({ selector, signature });
    else add.push({ selector, signature });
  }

  console.log(`Diamond        ${R.DIAMOND}`);
  console.log(`cutting as     ${deployer.address} (${R.labelFor(deployer.address)})`);
  console.log(`facets on it   ${facets.length}`);
  console.log(`selectors      ${planned.length} on the new AAOFacet`);
  console.log(`  replace      ${replace.length}`);
  console.log(`  add          ${add.length}`);

  if (add.length) {
    console.log("");
    add.forEach((a) => console.log(`  NEW  ${a.selector}  ${a.signature}`));
    throw new Error(
      "This facet introduces new selectors. That is a bigger change than a guard, " +
      "and it is not what this script is for. Cut it deliberately, not here."
    );
  }

  // Which facet address the selectors currently live on -- all one address, or
  // the Diamond is stranger than we think.
  const currentAddresses = new Set(replace.map((r) => before.get(r.selector.toLowerCase())));
  console.log(`currently at   ${[...currentAddresses].join(", ")}`);
  if (currentAddresses.size !== 1) {
    throw new Error("The AAOFacet selectors are spread over more than one facet address.");
  }
  const oldFacet = [...currentAddresses][0];

  if (dryRun) {
    console.log("");
    console.log("--dry-run: nothing deployed, nothing cut.");
    return;
  }

  console.log("");
  console.log("1. deploying the new AAOFacet");
  const facet = await AAOFacet.deploy();
  await facet.waitForDeployment();
  const newFacet = await facet.getAddress();
  console.log(`   deployed at ${newFacet}`);

  console.log("2. cutting: Replace every AAOFacet selector onto it");
  const diamondCut = await ethers.getContractAt("IDiamondCut", R.DIAMOND);
  const cut = [{
    facetAddress: newFacet,
    action: FacetCutAction.Replace,
    functionSelectors: replace.map((r) => r.selector)
  }];
  const tx = await diamondCut.diamondCut(cut, ethers.ZeroAddress, "0x");
  const receipt = await tx.wait();
  console.log(`   tx ${receipt.hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);

  console.log("3. verifying the Diamond now points at it");
  const after = await loupe.facets();
  const moved = [];
  for (const f of after) {
    for (const s of f.functionSelectors) {
      if (replace.some((r) => r.selector.toLowerCase() === s.toLowerCase())) {
        moved.push({ selector: s, at: f.facetAddress });
      }
    }
  }
  const wrong = moved.filter((m) => m.at.toLowerCase() !== newFacet.toLowerCase());
  if (wrong.length) throw new Error(`${wrong.length} selector(s) did not move.`);
  console.log(`   ${moved.length} selector(s) now on ${newFacet}`);

  console.log("4. checking the guard is live");
  const aaoFacet = await ethers.getContractAt("AAOFacet", R.DIAMOND);
  let guarded = false;
  try {
    await aaoFacet.vote.staticCall(99999, true);
  } catch (e) {
    guarded = /Proposal does not exist/.test(e.message || "");
  }
  console.log(`   vote on an unfiled id: ${guarded ? "refused" : "NOT REFUSED"}`);
  if (!guarded) throw new Error("The guard is not live after the cut.");

  console.log("");
  console.log(`old facet ${oldFacet}`);
  console.log(`new facet ${newFacet}`);
  console.log("Nothing else was deployed and no state was touched.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
