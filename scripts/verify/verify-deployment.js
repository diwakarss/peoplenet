const { ethers } = require("hardhat");

async function verifyDeployment(diamondAddress) {
    console.log('Verifying deployment at:', diamondAddress);

    // Get contract instances
    const diamondLoupe = await ethers.getContractAt("IDiamondLoupe", diamondAddress);
    const tokenFacet = await ethers.getContractAt("TokenFacet", diamondAddress);

    // Verify facets
    const facets = await diamondLoupe.facets();
    console.log('Deployed facets:', facets.length);
    
    for (const facet of facets) {
        console.log('Facet:', facet.facetAddress);
        console.log('Function selectors:', facet.functionSelectors.length);
    }

    // Verify interfaces
    const erc165Id = "0x01ffc9a7";
    const tokenFacetId = tokenFacet.interface.getSighash('registerToken');
    
    console.log('Verifying interfaces...');
    const supportsERC165 = await tokenFacet.supportsInterface(erc165Id);
    const supportsTokenFacet = await tokenFacet.supportsInterface(tokenFacetId);

    console.log('ERC165 support:', supportsERC165);
    console.log('TokenFacet support:', supportsTokenFacet);

    return true;
}

if (require.main === module) {
    // Get diamond address from command line or environment
    const diamondAddress = process.argv[2] || process.env.DIAMOND_ADDRESS;
    if (!diamondAddress) {
        console.error('Please provide diamond address');
        process.exit(1);
    }

    verifyDeployment(diamondAddress)
        .then(() => process.exit(0))
        .catch(error => {
            console.error(error);
            process.exit(1);
        });
}

module.exports = verifyDeployment;
