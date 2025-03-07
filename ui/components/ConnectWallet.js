import { Button, Menu, MenuButton, MenuList, MenuItem, Text, Flex, Box } from '@chakra-ui/react';
import { ChevronDownIcon } from '@chakra-ui/icons';
import { useWeb3 } from '../contexts/Web3Context';

const ConnectWallet = () => {
  const { account, isConnected, isConnecting, connectWallet, disconnectWallet, error } = useWeb3();

  // Format address for display
  const formatAddress = (address) => {
    if (!address) return '';
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
  };

  // Copy address to clipboard
  const copyAddress = () => {
    if (account) {
      navigator.clipboard.writeText(account);
    }
  };

  // View on Etherscan
  const viewOnEtherscan = () => {
    if (account) {
      const baseUrl = process.env.NEXT_PUBLIC_CHAIN_ID === '1' 
        ? 'https://etherscan.io/address/' 
        : 'https://sepolia.etherscan.io/address/';
      window.open(`${baseUrl}${account}`, '_blank');
    }
  };

  if (!isConnected) {
    return (
      <Button 
        colorScheme="whiteAlpha" 
        onClick={connectWallet} 
        isLoading={isConnecting}
        loadingText="Connecting"
      >
        Connect Wallet
      </Button>
    );
  }

  return (
    <Menu>
      <MenuButton as={Button} rightIcon={<ChevronDownIcon />} colorScheme="whiteAlpha">
        {formatAddress(account)}
      </MenuButton>
      <MenuList>
        <MenuItem onClick={copyAddress}>Copy Address</MenuItem>
        <MenuItem onClick={viewOnEtherscan}>View on Etherscan</MenuItem>
        <MenuItem onClick={disconnectWallet}>Disconnect</MenuItem>
      </MenuList>
    </Menu>
  );
};

export default ConnectWallet; 