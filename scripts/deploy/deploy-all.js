const deployDiamond = require('./00-deploy-diamond');
const deployTokenFacet = require('./01-deploy-token-facet');

async function deployAll() {
    console.log('Starting deployment...');

    try {
        // Deploy Diamond and core facets
        const { diamond } = await deployDiamond();
        console.log('Diamond deployment completed');

        // Deploy TokenFacet
        await deployTokenFacet(diamond.address);
        console.log('TokenFacet deployment completed');

        console.log('All deployments completed successfully');
        return diamond.address;
    } catch (error) {
        console.error('Deployment failed:', error);
        throw error;
    }
}

if (require.main === module) {
    deployAll()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(error);
            process.exit(1);
        });
}

module.exports = deployAll;
