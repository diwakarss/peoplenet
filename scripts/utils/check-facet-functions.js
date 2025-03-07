const { ethers } = require("hardhat");

async function main() {
  try {
    // Get the Diamond contract address
    const diamondAddress = "0xCD8a1C3ba11CF5ECfa6267617243239504a98d90";
    
    // Get the DiamondLoupeFacet to check the facets
    const diamondLoupe = await ethers.getContractAt("DiamondLoupeFacet", diamondAddress);
    
    // Get all facets
    const facets = await diamondLoupe.facets();
    console.log("Facets:", facets.length);
    
    // Loop through each facet
    for (let i = 0; i < facets.length; i++) {
      const facet = facets[i];
      console.log(`\nFacet ${i + 1}:`);
      console.log(`Address: ${facet.facetAddress}`);
      console.log(`Function selectors (${facet.functionSelectors.length}):`);
      
      // Get the function selectors for this facet
      for (let j = 0; j < facet.functionSelectors.length; j++) {
        const selector = facet.functionSelectors[j];
        console.log(`  ${j + 1}. ${selector}`);
      }
    }
    
    // Check if the AAOFacet functions are available
    console.log("\nChecking for AAOFacet functions:");
    
    // Try to get the AAOFacet contract
    const aaoFacet = await ethers.getContractAt("AAOFacet", diamondAddress);
    
    // Check if the getAAOsByCreator function exists
    try {
      const functionSelector = aaoFacet.interface.getFunction("getAAOsByCreator").selector;
      console.log(`getAAOsByCreator selector: ${functionSelector}`);
      
      // Check if this selector is in any facet
      let found = false;
      for (let i = 0; i < facets.length; i++) {
        const facet = facets[i];
        if (facet.functionSelectors.includes(functionSelector)) {
          console.log(`Found in facet ${i + 1} at address ${facet.facetAddress}`);
          found = true;
          break;
        }
      }
      
      if (!found) {
        console.log("getAAOsByCreator selector not found in any facet");
      }
    } catch (error) {
      console.error("Error checking getAAOsByCreator:", error.message);
    }
    
  } catch (error) {
    console.error("Error:", error);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  }); 