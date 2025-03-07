const { ethers } = require("hardhat");
const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };

function getSelectors(contract) {
    if (!contract || !contract.interface || !contract.interface.fragments) {
        console.error('Invalid contract object:', contract);
        throw new Error('Invalid contract object provided to getSelectors');
    }
    
    // In ethers v6, we need to use fragments instead of functions
    const selectors = contract.interface.fragments
        .filter(fragment => fragment.type === 'function' && fragment.name !== 'init')
        .map(fragment => contract.interface.getFunction(fragment.name).selector);
    
    return selectors;
}

function getSelector(func) {
    const abiInterface = new ethers.Interface([func]);
    // In ethers v6, we need to use fragments instead of functions
    const fragment = abiInterface.fragments[0];
    return abiInterface.getFunction(fragment.name).selector;
}

module.exports = {
    FacetCutAction,
    getSelectors,
    getSelector
};