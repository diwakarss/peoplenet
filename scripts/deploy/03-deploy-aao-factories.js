const { ethers } = require("hardhat");

async function deployAAOFactories(diamondAddress) {
    console.log('Deploying AAO Factory contracts...');

    try {
        // Deploy MacroAAOFactory
        const MacroAAOFactory = await ethers.getContractFactory("MacroAAOFactory");
        console.log('Deploying MacroAAOFactory...');
        const macroFactory = await MacroAAOFactory.deploy(diamondAddress);
        const macroFactoryTx = await macroFactory.deploymentTransaction().wait();
        console.log('MacroAAOFactory deployed:', macroFactory.target);

        // Deploy MicroAAOFactory
        const MicroAAOFactory = await ethers.getContractFactory("MicroAAOFactory");
        console.log('Deploying MicroAAOFactory...');
        const microFactory = await MicroAAOFactory.deploy(diamondAddress, macroFactory.target);
        const microFactoryTx = await microFactory.deploymentTransaction().wait();
        console.log('MicroAAOFactory deployed:', microFactory.target);

        return {
            macroFactory,
            microFactory
        };
    } catch (error) {
        console.error('Error in deployAAOFactories:', error);
        throw error;
    }
}

module.exports = deployAAOFactories; 