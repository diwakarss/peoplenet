import { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import {
  Box,
  Heading,
  Text,
  Button,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  Badge,
  Flex,
  Spinner,
  Alert,
  AlertIcon,
  Tabs,
  TabList,
  TabPanels,
  Tab,
  TabPanel,
  useToast,
  HStack
} from '@chakra-ui/react';
import { useWeb3 } from '../contexts/Web3Context';
import { getAAOFacet } from '../utils/contracts';

const AAOList = forwardRef(({ onSelectAAO }, ref) => {
  const { account, provider, signer, isConnected } = useWeb3();
  const [isLoading, setIsLoading] = useState(false);
  const [myAAOs, setMyAAOs] = useState([]);
  const [joinedAAOs, setJoinedAAOs] = useState([]);
  const [error, setError] = useState(null);
  const toast = useToast();

  // Load AAOs
  const loadAAOs = async () => {
    if (!isConnected || !provider || !account) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const aaoFacet = getAAOFacet(signer || provider);
      
      // Check if the required functions exist
      if (typeof aaoFacet.getAAOsByCreator !== 'function') {
        console.error('Function getAAOsByCreator not found on AAOFacet');
        setError('AAO functionality not available. The contract might not be properly deployed or initialized.');
        setIsLoading(false);
        return;
      }
      
      // Get AAOs created by the user
      const userAAOs = await aaoFacet.getAAOsByCreator(account);
      
      // Get AAOs where the user is a member
      const memberAAOs = await aaoFacet.getAAOsByMember(account);
      
      // Filter out AAOs that the user created from the member list
      const onlyJoinedAAOs = memberAAOs.filter(
        id => !userAAOs.includes(id)
      );
      
      // Fetch details for created AAOs
      const createdAAODetails = await Promise.all(
        userAAOs.map(async (aaoId) => {
          const aao = await aaoFacet.getAAO(aaoId);
          return {
            id: aaoId.toString(),
            topic: aao.topic,
            isMacro: aao.isMacro,
            active: aao.active,
            membersCount: (await aaoFacet.getMembersCount(aaoId)).toString(),
            owner: aao.owner
          };
        })
      );
      
      // Fetch details for joined AAOs
      const joinedAAODetails = await Promise.all(
        onlyJoinedAAOs.map(async (aaoId) => {
          const aao = await aaoFacet.getAAO(aaoId);
          return {
            id: aaoId.toString(),
            topic: aao.topic,
            isMacro: aao.isMacro,
            active: aao.active,
            membersCount: (await aaoFacet.getMembersCount(aaoId)).toString(),
            owner: aao.owner
          };
        })
      );
      
      setMyAAOs(createdAAODetails);
      setJoinedAAOs(joinedAAODetails);
    } catch (err) {
      console.error('Error loading AAOs:', err);
      setError(err.message || 'Failed to load AAOs');
    } finally {
      setIsLoading(false);
    }
  };

  // Expose loadAAOs function via ref
  useImperativeHandle(ref, () => ({
    loadAAOs
  }));

  // Load AAOs on component mount and when account changes
  useEffect(() => {
    loadAAOs();
  }, [isConnected, provider, account, signer]);

  // Handle joining an AAO
  const handleJoinAAO = async (aaoId) => {
    if (!isConnected || !signer) return;
    
    try {
      const aaoFacet = getAAOFacet(signer);
      const tx = await aaoFacet.joinAAO(aaoId);
      await tx.wait();
      
      toast({
        title: 'Joined AAO',
        description: 'You have successfully joined the AAO',
        status: 'success',
        duration: 5000,
        isClosable: true,
      });
      
      // Reload AAOs
      loadAAOs();
    } catch (err) {
      console.error('Error joining AAO:', err);
      toast({
        title: 'Error',
        description: err.message || 'Failed to join AAO',
        status: 'error',
        duration: 5000,
        isClosable: true,
      });
    }
  };

  // Handle leaving an AAO
  const handleLeaveAAO = async (aaoId) => {
    if (!isConnected || !signer) return;
    
    try {
      const aaoFacet = getAAOFacet(signer);
      const tx = await aaoFacet.leaveAAO(aaoId);
      await tx.wait();
      
      toast({
        title: 'Left AAO',
        description: 'You have successfully left the AAO',
        status: 'success',
        duration: 5000,
        isClosable: true,
      });
      
      // Reload AAOs
      loadAAOs();
    } catch (err) {
      console.error('Error leaving AAO:', err);
      toast({
        title: 'Error',
        description: err.message || 'Failed to leave AAO',
        status: 'error',
        duration: 5000,
        isClosable: true,
      });
    }
  };

  // Handle viewing AAO details
  const handleViewAAO = async (aaoId) => {
    if (!isConnected) return;
    
    try {
      const aaoFacet = getAAOFacet(provider);
      const aao = await aaoFacet.getAAO(aaoId);
      
      // Get additional details
      const membersCount = await aaoFacet.getMembersCount(aaoId);
      const isAdmin = await aaoFacet.isAdmin(aaoId, account);
      const isMember = await aaoFacet.isMember(aaoId, account);
      
      // If it's a micro AAO, get the parent macro AAO
      let parentId = null;
      if (!aao.isMacro) {
        parentId = await aaoFacet.getMacroAAOId(aaoId);
      }
      
      // Prepare AAO details object
      const aaoDetails = {
        id: aaoId,
        topic: aao.topic,
        isMacro: aao.isMacro,
        active: aao.active,
        owner: aao.owner,
        duration: aao.duration.toString(),
        membersCount: membersCount.toString(),
        isAdmin,
        isMember,
        parentId: parentId ? parentId.toString() : null
      };
      
      // Call the onSelectAAO callback with the AAO details
      if (onSelectAAO) {
        onSelectAAO(aaoDetails);
      }
    } catch (err) {
      console.error('Error getting AAO details:', err);
      toast({
        title: 'Error',
        description: err.message || 'Failed to get AAO details',
        status: 'error',
        duration: 5000,
        isClosable: true,
      });
    }
  };

  if (!isConnected) {
    return (
      <Alert status="warning">
        <AlertIcon />
        Please connect your wallet to view AAOs
      </Alert>
    );
  }

  if (isLoading) {
    return (
      <Flex justify="center" align="center" direction="column" py={10}>
        <Spinner size="xl" mb={4} />
        <Text>Loading AAOs...</Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Alert status="error">
        <AlertIcon />
        {error}
      </Alert>
    );
  }

  return (
    <Box>
      <Heading size="lg" mb={6}>AAO Dashboard</Heading>
      
      {error && (
        <Alert status="error" mb={4}>
          <AlertIcon />
          {error}
        </Alert>
      )}
      
      {isLoading ? (
        <Flex justify="center" align="center" py={10}>
          <Spinner size="xl" />
        </Flex>
      ) : (
        <Tabs variant="enclosed" colorScheme="blue">
          <TabList>
            <Tab>My AAOs</Tab>
            <Tab>Joined AAOs</Tab>
          </TabList>
          <TabPanels>
            <TabPanel>
              {myAAOs.length === 0 ? (
                <Text>You haven't created any AAOs yet.</Text>
              ) : (
                <Table variant="simple">
                  <Thead>
                    <Tr>
                      <Th>ID</Th>
                      <Th>Topic</Th>
                      <Th>Type</Th>
                      <Th>Status</Th>
                      <Th>Members</Th>
                      <Th>Actions</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {myAAOs.map((aao) => (
                      <Tr key={aao.id}>
                        <Td>{aao.id}</Td>
                        <Td>{aao.topic}</Td>
                        <Td>
                          <Badge colorScheme={aao.isMacro ? "blue" : "purple"}>
                            {aao.isMacro ? "Macro" : "Micro"}
                          </Badge>
                        </Td>
                        <Td>
                          <Badge colorScheme={aao.active ? "green" : "red"}>
                            {aao.active ? "Active" : "Inactive"}
                          </Badge>
                        </Td>
                        <Td>{aao.membersCount}</Td>
                        <Td>
                          <Button 
                            size="sm" 
                            colorScheme="blue" 
                            onClick={() => onSelectAAO(aao)}
                          >
                            View
                          </Button>
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              )}
            </TabPanel>
            <TabPanel>
              {joinedAAOs.length === 0 ? (
                <Text>You haven't joined any AAOs yet.</Text>
              ) : (
                <Table variant="simple">
                  <Thead>
                    <Tr>
                      <Th>ID</Th>
                      <Th>Topic</Th>
                      <Th>Type</Th>
                      <Th>Status</Th>
                      <Th>Members</Th>
                      <Th>Actions</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {joinedAAOs.map((aao) => (
                      <Tr key={aao.id}>
                        <Td>{aao.id}</Td>
                        <Td>{aao.topic}</Td>
                        <Td>
                          <Badge colorScheme={aao.isMacro ? "blue" : "purple"}>
                            {aao.isMacro ? "Macro" : "Micro"}
                          </Badge>
                        </Td>
                        <Td>
                          <Badge colorScheme={aao.active ? "green" : "red"}>
                            {aao.active ? "Active" : "Inactive"}
                          </Badge>
                        </Td>
                        <Td>{aao.membersCount}</Td>
                        <Td>
                          <HStack spacing={2}>
                            <Button 
                              size="sm" 
                              colorScheme="blue" 
                              onClick={() => onSelectAAO(aao)}
                            >
                              View
                            </Button>
                            <Button 
                              size="sm" 
                              colorScheme="red" 
                              onClick={() => handleLeaveAAO(aao.id)}
                            >
                              Leave
                            </Button>
                          </HStack>
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              )}
            </TabPanel>
          </TabPanels>
        </Tabs>
      )}
    </Box>
  );
});

export default AAOList; 