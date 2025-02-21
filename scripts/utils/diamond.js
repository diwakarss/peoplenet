const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };

function getSelectors(contract) {
    const signatures = Object.keys(contract.interface.functions);
    const selectors = signatures.reduce((acc, val) => {
        if (val !== 'init(bytes)') {
            acc.push(contract.interface.getSighash(val));
        }
        return acc;
    }, []);
    return selectors;
}

function getSelector(func) {
    const abiInterface = new ethers.utils.Interface([func]);
    return abiInterface.getSighash(Object.keys(abiInterface.functions)[0]);
}

module.exports = {
    FacetCutAction,
    getSelectors,
    getSelector
};