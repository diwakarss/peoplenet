const deployDiamond = require('./00-deploy-diamond');
const deployTokenFacet = require('./01-deploy-token-facet');
const deployAAOFacet = require('./02-deploy-aao-facet');
const deployAAOFactories = require('./03-deploy-aao-factories');

async function deployAll() {
    console.log('Starting deployment...');

    try {
        // Deploy Diamond and core facets
        const { diamond } = await deployDiamond();
        console.log('Diamond deployment completed');

        // Deploy TokenFacet
        await deployTokenFacet(diamond.target);
        console.log('TokenFacet deployment completed');

        // Deploy AAOFacet and add it to the Diamond
        const { libAAO, aaoFacet } = await deployAAOFacet(diamond.target);
        console.log('AAOFacet deployment completed');

        // Deploy AAO Factories
        const { macroFactory, microFactory } = await deployAAOFactories(diamond.target);
        console.log('AAO Factories deployment completed');

        console.log('All deployments completed successfully');
        console.log('Diamond address:', diamond.target);
        console.log('LibAAO address:', libAAO.target);
        console.log('AAOFacet address:', aaoFacet.target);
        console.log('MacroAAOFactory address:', macroFactory.target);
        console.log('MicroAAOFactory address:', microFactory.target);

        return {
            diamond: diamond.target,
            libAAO: libAAO.target,
            aaoFacet: aaoFacet.target,
            macroFactory: macroFactory.target,
            microFactory: microFactory.target
        };
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
