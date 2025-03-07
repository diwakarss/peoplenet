import { createContext, useContext, useState, useEffect } from 'react';
import { BrowserProvider } from 'ethers';

const Web3Context = createContext();

export function Web3Provider({ children }) {
  const [account, setAccount] = useState(null);
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState(null);

  // Initialize provider from window.ethereum if available
  useEffect(() => {
    if (typeof window !== 'undefined' && window.ethereum) {
      const ethersProvider = new BrowserProvider(window.ethereum);
      setProvider(ethersProvider);

      // Check if already connected
      ethersProvider.listAccounts().then(accounts => {
        if (accounts.length > 0) {
          setAccount(accounts[0].address);
          setIsConnected(true);
          ethersProvider.getSigner().then(signerInstance => {
            setSigner(signerInstance);
          });
          
          // Get chain ID
          ethersProvider.getNetwork().then(network => {
            setChainId(network.chainId);
          });
        }
      });

      // Listen for account changes
      window.ethereum.on('accountsChanged', async (accounts) => {
        if (accounts.length > 0) {
          setAccount(accounts[0]);
          setIsConnected(true);
          const signerInstance = await ethersProvider.getSigner();
          setSigner(signerInstance);
        } else {
          setAccount(null);
          setIsConnected(false);
          setSigner(null);
        }
      });

      // Listen for chain changes
      window.ethereum.on('chainChanged', async (chainIdHex) => {
        const newChainId = parseInt(chainIdHex, 16);
        setChainId(newChainId);
        
        // Refresh provider on chain change
        const updatedProvider = new BrowserProvider(window.ethereum);
        setProvider(updatedProvider);
        if (isConnected) {
          const signerInstance = await updatedProvider.getSigner();
          setSigner(signerInstance);
        }
      });
    }
  }, []);

  // Connect wallet function
  const connectWallet = async () => {
    if (!provider) {
      setError('No Ethereum wallet found. Please install MetaMask.');
      return;
    }

    try {
      setIsConnecting(true);
      setError(null);
      
      // Request account access
      const accounts = await window.ethereum.request({ 
        method: 'eth_requestAccounts' 
      });
      
      setAccount(accounts[0]);
      setIsConnected(true);
      const signerInstance = await provider.getSigner();
      setSigner(signerInstance);
      
      // Get chain ID
      const network = await provider.getNetwork();
      setChainId(network.chainId);
    } catch (err) {
      console.error('Error connecting wallet:', err);
      setError(err.message || 'Failed to connect wallet');
    } finally {
      setIsConnecting(false);
    }
  };

  // Disconnect wallet function
  const disconnectWallet = () => {
    setAccount(null);
    setIsConnected(false);
    setSigner(null);
  };

  // Switch network function
  const switchNetwork = async (targetChainId) => {
    if (!provider) return;
    
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${targetChainId.toString(16)}` }],
      });
    } catch (error) {
      // This error code indicates that the chain has not been added to MetaMask
      if (error.code === 4902) {
        // Add the network
        // This would need network-specific parameters
      }
      console.error('Error switching network:', error);
      setError(error.message || 'Failed to switch network');
    }
  };

  const value = {
    account,
    provider,
    signer,
    chainId,
    isConnected,
    isConnecting,
    error,
    connectWallet,
    disconnectWallet,
    switchNetwork
  };

  return (
    <Web3Context.Provider value={value}>
      {children}
    </Web3Context.Provider>
  );
}

export function useWeb3() {
  return useContext(Web3Context);
} 