import { useState, useEffect } from 'react';
import {
  Box,
  Heading,
  Text,
  Button,
  Flex,
  Badge,
  Divider,
  Stat,
  StatLabel,
  StatNumber,
  StatGroup,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  Tabs,
  TabList,
  TabPanels,
  Tab,
  TabPanel,
  Input,
  FormControl,
  FormLabel,
  useToast,
  Spinner,
  Alert,
  AlertIcon,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalFooter,
  ModalBody,
  ModalCloseButton,
  useDisclosure
} from '@chakra-ui/react';
import { useWeb3 } from '../contexts/Web3Context';
import { getAAOFacet } from '../utils/contracts';

const AAODetails = ({ aao }) => {
  const { account, provider, isConnected } = useWeb3();
  const [isLoading, setIsLoading] = useState(false);
  const [members, setMembers] = useState([]);
  const [newAdminAddress, setNewAdminAddress] = useState('');
  const [isOwner, setIsOwner] = useState(false);
  const [parentAAO, setParentAAO] = useState(null);
  const [childAAOs, setChildAAOs] = useState([]);
  const { isOpen, onOpen, onClose } = useDisclosure();
  const toast = useToast();

  // Check if current user is the owner
  useEffect(() => {
    if (aao && account) {
      setIsOwner(aao.owner.toLowerCase() === account.toLowerCase());
    }
  }, [aao, account]);

  // Load members
  useEffect(() => {
    const loadMembers = async () => {
      if (!aao || !provider) return;
      
      setIsLoading(true);
      
      try {
        const aaoFacet = getAAOFacet(provider);
        const memberAddresses = await aaoFacet.getMembers(aao.id);
        
        // Get admin status for each member
        const membersWithStatus = await Promise.all(
          memberAddresses.map(async (address) => {
            const isAdmin = await aaoFacet.isAdmin(aao.id, address);
            return {
              address,
              isAdmin,
              isOwner: address.toLowerCase() === aao.owner.toLowerCase()
            };
          })
        );
        
        setMembers(membersWithStatus);
      } catch (error) {
        console.error('Error loading members:', error);
        toast({
          title: 'Error',
          description: 'Failed to load members',
          status: 'error',
          duration: 5000,
          isClosable: true,
        });
      } finally {
        setIsLoading(false);
      }
    };
    
    loadMembers();
  }, [aao, provider]);

  // Load parent AAO if this is a micro AAO
  useEffect(() => {
    const loadParentAAO = async () => {
      if (!aao || !provider || aao.isMacro || !aao.parentId) return;
      
      try {
        const aaoFacet = getAAOFacet(provider);
        const parentAAOData = await aaoFacet.getAAO(aao.parentId);
        
        setParentAAO({
          id: aao.parentId,
          topic: parentAAOData.topic,
          owner: parentAAOData.owner,
          active: parentAAOData.active
        });
      } catch (error) {
        console.error('Error loading parent AAO:', error);
      }
    };
    
    loadParentAAO();
  }, [aao, provider]);

  // Load child AAOs if this is a macro AAO
  useEffect(() => {
    const loadChildAAOs = async () => {
      if (!aao || !provider || !aao.isMacro) return;
      
      try {
        const aaoFacet = getAAOFacet(provider);
        const childIds = await aaoFacet.getMicroAAOIds(aao.id);
        
        if (childIds.length === 0) {
          setChildAAOs([]);
          return;
        }
        
        const childAAOsData = await Promise.all(
          childIds.map(async (childId) => {
            const childData = await aaoFacet.getAAO(childId);
            return {
              id: childId.toString(),
              topic: childData.topic,
              active: childData.active,
              owner: childData.owner
            };
          })
        );
        
        setChildAAOs(childAAOsData);
      } catch (error) {
        console.error('Error loading child AAOs:', error);
      }
    };
    
    loadChildAAOs();
  }, [aao, provider]);

  // Handle assigning admin role
  const handleAssignAdmin = async () => {
    if (!isConnected || !aao || !newAdminAddress) return;
    
    try {
      const aaoFacet = getAAOFacet(provider.getSigner());
      const tx = await aaoFacet.assignAdminRole(aao.id, newAdminAddress);
      await tx.wait();
      
      toast({
        title: 'Admin role assigned',
        description: `Admin role assigned to ${newAdminAddress}`,
        status: 'success',
        duration: 5000,
        isClosable: true,
      });
      
      // Reload members
      const memberAddresses = await aaoFacet.getMembers(aao.id);
      const membersWithStatus = await Promise.all(
        memberAddresses.map(async (address) => {
          const isAdmin = await aaoFacet.isAdmin(aao.id, address);
          return {
            address,
            isAdmin,
            isOwner: address.toLowerCase() === aao.owner.toLowerCase()
          };
        })
      );
      
      setMembers(membersWithStatus);
      setNewAdminAddress('');
      onClose();
    } catch (error) {
      console.error('Error assigning admin role:', error);
      toast({
        title: 'Error',
        description: error.message || 'Failed to assign admin role',
        status: 'error',
        duration: 5000,
        isClosable: true,
      });
    }
  };

  // Handle revoking admin role
  const handleRevokeAdmin = async (address) => {
    if (!isConnected || !aao) return;
    
    try {
      const aaoFacet = getAAOFacet(provider.getSigner());
      const tx = await aaoFacet.revokeAdminRole(aao.id, address);
      await tx.wait();
      
      toast({
        title: 'Admin role revoked',
        description: `Admin role revoked from ${address}`,
        status: 'success',
        duration: 5000,
        isClosable: true,
      });
      
      // Update member status
      setMembers(members.map(member => 
        member.address === address 
          ? { ...member, isAdmin: false } 
          : member
      ));
    } catch (error) {
      console.error('Error revoking admin role:', error);
      toast({
        title: 'Error',
        description: error.message || 'Failed to revoke admin role',
        status: 'error',
        duration: 5000,
        isClosable: true,
      });
    }
  };

  // Handle terminating AAO
  const handleTerminateAAO = async () => {
    if (!isConnected || !aao) return;
    
    if (!window.confirm('Are you sure you want to terminate this AAO? This action cannot be undone.')) {
      return;
    }
    
    try {
      const aaoFacet = getAAOFacet(provider.getSigner());
      const tx = await aaoFacet.terminateAAO(aao.id);
      await tx.wait();
      
      toast({
        title: 'AAO terminated',
        description: `AAO #${aao.id} has been terminated`,
        status: 'success',
        duration: 5000,
        isClosable: true,
      });
    } catch (error) {
      console.error('Error terminating AAO:', error);
      toast({
        title: 'Error',
        description: error.message || 'Failed to terminate AAO',
        status: 'error',
        duration: 5000,
        isClosable: true,
      });
    }
  };

  if (!aao) {
    return (
      <Alert status="info">
        <AlertIcon />
        Select an AAO to view its details
      </Alert>
    );
  }

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={6}>
        <Heading size="lg">{aao.topic}</Heading>
        <Badge 
          colorScheme={aao.isMacro ? "purple" : "teal"} 
          fontSize="md" 
          py={1} 
          px={3}
        >
          {aao.isMacro ? "Macro AAO" : "Micro AAO"}
        </Badge>
      </Flex>
      
      <StatGroup mb={6}>
        <Stat>
          <StatLabel>ID</StatLabel>
          <StatNumber>{aao.id}</StatNumber>
        </Stat>
        <Stat>
          <StatLabel>Status</StatLabel>
          <StatNumber>
            <Badge colorScheme={aao.active ? "green" : "red"}>
              {aao.active ? "Active" : "Inactive"}
            </Badge>
          </StatNumber>
        </Stat>
        <Stat>
          <StatLabel>Members</StatLabel>
          <StatNumber>{aao.membersCount}</StatNumber>
        </Stat>
        <Stat>
          <StatLabel>Duration</StatLabel>
          <StatNumber>{Math.floor(aao.duration / (24 * 60 * 60))} days</StatNumber>
        </Stat>
      </StatGroup>
      
      {/* Parent AAO info for Micro AAOs */}
      {!aao.isMacro && parentAAO && (
        <Box mb={6} p={4} borderWidth={1} borderRadius="md">
          <Heading size="sm" mb={2}>Parent Macro AAO</Heading>
          <Flex>
            <Text fontWeight="bold" mr={2}>ID:</Text>
            <Text>{aao.parentId}</Text>
          </Flex>
          <Flex>
            <Text fontWeight="bold" mr={2}>Topic:</Text>
            <Text>{parentAAO.topic}</Text>
          </Flex>
          <Flex>
            <Text fontWeight="bold" mr={2}>Status:</Text>
            <Badge colorScheme={parentAAO.active ? "green" : "red"}>
              {parentAAO.active ? "Active" : "Inactive"}
            </Badge>
          </Flex>
        </Box>
      )}
      
      <Tabs colorScheme="blue" mt={6}>
        <TabList>
          <Tab>Members</Tab>
          {aao.isMacro && <Tab>Child AAOs</Tab>}
          {isOwner && <Tab>Admin</Tab>}
        </TabList>
        
        <TabPanels>
          {/* Members Tab */}
          <TabPanel>
            {isLoading ? (
              <Flex justify="center" py={4}>
                <Spinner />
              </Flex>
            ) : members.length === 0 ? (
              <Text>No members found</Text>
            ) : (
              <Table variant="simple">
                <Thead>
                  <Tr>
                    <Th>Address</Th>
                    <Th>Role</Th>
                    {isOwner && <Th>Actions</Th>}
                  </Tr>
                </Thead>
                <Tbody>
                  {members.map((member) => (
                    <Tr key={member.address}>
                      <Td>{member.address}</Td>
                      <Td>
                        {member.isOwner ? (
                          <Badge colorScheme="red">Owner</Badge>
                        ) : member.isAdmin ? (
                          <Badge colorScheme="green">Admin</Badge>
                        ) : (
                          <Badge colorScheme="gray">Member</Badge>
                        )}
                      </Td>
                      {isOwner && (
                        <Td>
                          {!member.isOwner && (
                            member.isAdmin ? (
                              <Button 
                                size="sm" 
                                colorScheme="red" 
                                onClick={() => handleRevokeAdmin(member.address)}
                              >
                                Revoke Admin
                              </Button>
                            ) : (
                              <Button 
                                size="sm" 
                                colorScheme="green" 
                                onClick={() => {
                                  setNewAdminAddress(member.address);
                                  onOpen();
                                }}
                              >
                                Make Admin
                              </Button>
                            )
                          )}
                        </Td>
                      )}
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
          </TabPanel>
          
          {/* Child AAOs Tab (for Macro AAOs) */}
          {aao.isMacro && (
            <TabPanel>
              {childAAOs.length === 0 ? (
                <Text>No child Micro AAOs found</Text>
              ) : (
                <Table variant="simple">
                  <Thead>
                    <Tr>
                      <Th>ID</Th>
                      <Th>Topic</Th>
                      <Th>Status</Th>
                      <Th>Owner</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {childAAOs.map((child) => (
                      <Tr key={child.id}>
                        <Td>{child.id}</Td>
                        <Td>{child.topic}</Td>
                        <Td>
                          <Badge colorScheme={child.active ? "green" : "red"}>
                            {child.active ? "Active" : "Inactive"}
                          </Badge>
                        </Td>
                        <Td>{child.owner}</Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              )}
            </TabPanel>
          )}
          
          {/* Admin Tab (for owners only) */}
          {isOwner && (
            <TabPanel>
              <Heading size="md" mb={4}>Administrative Actions</Heading>
              
              <Box mb={6}>
                <Heading size="sm" mb={2}>Assign Admin Role</Heading>
                <Flex>
                  <Input 
                    placeholder="Enter Ethereum address" 
                    value={newAdminAddress}
                    onChange={(e) => setNewAdminAddress(e.target.value)}
                    mr={2}
                  />
                  <Button 
                    colorScheme="blue" 
                    onClick={onOpen}
                    isDisabled={!newAdminAddress}
                  >
                    Assign
                  </Button>
                </Flex>
              </Box>
              
              <Divider my={4} />
              
              <Box>
                <Heading size="sm" mb={2}>Danger Zone</Heading>
                <Button 
                  colorScheme="red" 
                  onClick={handleTerminateAAO}
                  isDisabled={!aao.active}
                >
                  Terminate AAO
                </Button>
                <Text fontSize="sm" mt={2} color="gray.500">
                  This action cannot be undone. Once terminated, the AAO will be inactive and no new members can join.
                </Text>
              </Box>
            </TabPanel>
          )}
        </TabPanels>
      </Tabs>
      
      {/* Admin Role Assignment Modal */}
      <Modal isOpen={isOpen} onClose={onClose}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>Assign Admin Role</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <Text mb={4}>
              You are about to assign admin role to the following address:
            </Text>
            <Text fontWeight="bold" wordBreak="break-all">
              {newAdminAddress}
            </Text>
            <Alert status="warning" mt={4}>
              <AlertIcon />
              Admins can manage members and perform administrative actions.
            </Alert>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr={3} onClick={onClose}>
              Cancel
            </Button>
            <Button colorScheme="blue" onClick={handleAssignAdmin}>
              Confirm
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  );
};

export default AAODetails; 