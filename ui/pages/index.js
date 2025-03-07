import { useEffect, useState } from 'react';
import { 
  Box, 
  Container, 
  Heading, 
  Text, 
  Button, 
  Flex, 
  Tabs, 
  TabList, 
  TabPanels, 
  Tab, 
  TabPanel,
  useToast
} from '@chakra-ui/react';
import { ethers } from 'ethers';
import Head from 'next/head';
import ConnectWallet from '../components/ConnectWallet';
import CreateAAO from '../components/CreateAAO';
import AAOList from '../components/AAOList';
import AAODetails from '../components/AAODetails';
import { useWeb3 } from '../contexts/Web3Context';

export default function Home() {
  const { account, provider, isConnected } = useWeb3();
  const [selectedAAO, setSelectedAAO] = useState(null);
  const toast = useToast();

  const handleSelectAAO = (aao) => {
    setSelectedAAO(aao);
  };

  const handleCreateSuccess = () => {
    toast({
      title: 'AAO Created',
      description: 'Your AAO has been created successfully',
      status: 'success',
      duration: 5000,
      isClosable: true,
    });
  };

  return (
    <Box minH="100vh" bg="gray.50">
      <Head>
        <title>PeopleNet - AAO Dashboard</title>
        <meta name="description" content="PeopleNet AAO Dashboard" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <Box as="header" bg="blue.600" color="white" py={4} px={6}>
        <Container maxW="container.xl">
          <Flex justify="space-between" align="center">
            <Heading as="h1" size="lg">PeopleNet</Heading>
            <ConnectWallet />
          </Flex>
        </Container>
      </Box>

      <Container maxW="container.xl" py={8}>
        {!isConnected ? (
          <Box textAlign="center" py={10}>
            <Heading mb={4}>Welcome to PeopleNet</Heading>
            <Text fontSize="xl" mb={6}>
              Connect your wallet to start interacting with Acentric Autonomous Organizations
            </Text>
          </Box>
        ) : (
          <Tabs variant="enclosed" colorScheme="blue">
            <TabList>
              <Tab>Dashboard</Tab>
              <Tab>Create AAO</Tab>
              {selectedAAO && <Tab>AAO Details</Tab>}
            </TabList>
            <TabPanels>
              <TabPanel>
                <AAOList onSelectAAO={handleSelectAAO} />
              </TabPanel>
              <TabPanel>
                <CreateAAO onSuccess={handleCreateSuccess} />
              </TabPanel>
              {selectedAAO && (
                <TabPanel>
                  <AAODetails aao={selectedAAO} />
                </TabPanel>
              )}
            </TabPanels>
          </Tabs>
        )}
      </Container>

      <Box as="footer" bg="gray.100" py={4} px={6} mt="auto">
        <Container maxW="container.xl">
          <Text textAlign="center" color="gray.500">
            PeopleNet &copy; {new Date().getFullYear()} - A Decentralized Digital Society
          </Text>
        </Container>
      </Box>
    </Box>
  );
} 