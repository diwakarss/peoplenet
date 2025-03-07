const { ethers } = require("hardhat");

const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };

function getSelectors(contract) {
    const signatures = Object.keys(contract.interface.fragments)
        .filter(key => contract.interface.fragments[key].type === 'function')
        .map(key => contract.interface.fragments[key].format());
    
    const selectors = signatures.map(signature => 
        contract.interface.getFunction(signature).selector
    );
    
    return selectors;
}

function getSelector(func) {
    const abiInterface = new ethers.Interface([func]);
    return abiInterface.getFunction(func.split('(')[0]).selector;
}

module.exports = {
    FacetCutAction,
    getSelectors,
    getSelector
};
