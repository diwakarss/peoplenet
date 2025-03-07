const { getSelectors, FacetCutAction } = require("../utils/diamond");

async function deployAAOFacet() {
  const accounts = await ethers.getSigners();
  const contractOwner = accounts[0];

  // Deploy LibAAO
  const LibAAO = await ethers.getContractFactory("LibAAO");
  const libAAO = await LibAAO.deploy();
  await libAAO.deployed();
  console.log("LibAAO deployed:", libAAO.address);
}

module.exports = deployAAOFacet;
  