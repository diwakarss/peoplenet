import { useState, useEffect } from 'react';
import {
  Box,
  Button,
  FormControl,
  FormLabel,
  Input,
  Select,
  NumberInput,
  NumberInputField,
  NumberInputStepper,
  NumberIncrementStepper,
  NumberDecrementStepper,
  Heading,
  Text,
  VStack,
  HStack,
  useToast,
  Divider,
  Radio,
  RadioGroup,
  Stack,
  Alert,
  AlertIcon
} from '@chakra-ui/react';
import { ethers } from 'ethers';
import { useWeb3 } from '../contexts/Web3Context';
import { getAAOFacet, getMacroAAOFactory, getMicroAAOFactory } from '../utils/contracts';

const CreateAAO = ({ onSuccess }) => {
  const { account, provider, signer, isConnected } = useWeb3();
  const [isLoading, setIsLoading] = useState(false);
  const [aaoType, setAAOType] = useState('macro');
  const [topic, setTopic] = useState('');
  const [duration, setDuration] = useState(30); // days
  const [macroAAOs, setMacroAAOs] = useState([]);
  const [selectedMacroId, setSelectedMacroId] = useState('');
  const [error, setError] = useState(null);
  const toast = useToast();

  // Function to load macro AAOs for selection when creating micro AAO
  const loadMacroAAOs = async () => {
    if (!isConnected || !provider || !account) return;
    
    try {
      const aaoFacet = getAAOFacet(signer || provider);
      
      // Check if the required functions exist
      if (typeof aaoFacet.getAAOsByCreator !== 'function') {
        console.error('Function getAAOsByCreator not found on AAOFacet');
        setError('AAO functionality not available. The contract might not be properly deployed or initialized.');
        return;
      }
      
      const userAAOs = await aaoFacet.getAAOsByCreator(account);
      
      const macroAAOsList = [];
      for (const aaoId of userAAOs) {
        const aao = await aaoFacet.getAAO(aaoId);
        if (aao.isMacro) {
          macroAAOsList.push({
            id: aaoId.toString(),
            topic: aao.topic
          });
        }
      }
      
      setMacroAAOs(macroAAOsList);
    } catch (error) {
      console.error('Error loading macro AAOs:', error);
      setError(error.message || 'Failed to load macro AAOs');
    }
  };

  // Load macro AAOs on component mount and when account changes
  useEffect(() => {
    loadMacroAAOs();
  }, [isConnected, provider, account, signer]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!isConnected || !signer) {
      toast({
        title: 'Not connected',
        description: 'Please connect your wallet first',
        status: 'error',
        duration: 5000,
        isClosable: true,
      });
      return;
    }
    
    if (!topic) {
      toast({
        title: 'Missing topic',
        description: 'Please enter a topic for your AAO',
        status: 'error',
        duration: 5000,
        isClosable: true,
      });
      return;
    }
    
    if (aaoType === 'micro' && !selectedMacroId) {
      toast({
        title: 'Missing parent',
        description: 'Please select a parent Macro AAO',
        status: 'error',
        duration: 5000,
        isClosable: true,
      });
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    try {
      // Convert duration from days to seconds
      const durationInSeconds = duration * 24 * 60 * 60;
      
      if (aaoType === 'macro') {
        // Create Macro AAO
        const macroFactory = getMacroAAOFactory(signer);
        
        // Check if the required functions exist
        if (typeof macroFactory.createMacroAAO !== 'function') {
          throw new Error('Function createMacroAAO not found. The contract might not be properly deployed or initialized.');
        }
        
        const tx = await macroFactory.createMacroAAO(topic, durationInSeconds);
        await tx.wait();
      } else {
        // Create Micro AAO
        const microFactory = getMicroAAOFactory(signer);
        
        // Check if the required functions exist
        if (typeof microFactory.createMicroAAO !== 'function') {
          throw new Error('Function createMicroAAO not found. The contract might not be properly deployed or initialized.');
        }
        
        const tx = await microFactory.createMicroAAO(selectedMacroId, topic, durationInSeconds);
        await tx.wait();
      }
      
      // Reset form
      setTopic('');
      setDuration(30);
      setSelectedMacroId('');
      
      // Reload macro AAOs list
      loadMacroAAOs();
      
      // Notify success
      toast({
        title: 'AAO Created',
        description: `Your ${aaoType} AAO has been created successfully`,
        status: 'success',
        duration: 5000,
        isClosable: true,
      });
      
      if (onSuccess) {
        onSuccess();
      }
      
    } catch (error) {
      console.error('Error creating AAO:', error);
      setError(error.message || 'An error occurred while creating the AAO');
      toast({
        title: 'Error creating AAO',
        description: error.message || 'An error occurred while creating the AAO',
        status: 'error',
        duration: 5000,
        isClosable: true,
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box>
      <Heading size="lg" mb={6}>Create New AAO</Heading>
      
      {error && (
        <Alert status="error" mb={4}>
          <AlertIcon />
          {error}
        </Alert>
      )}
      
      <form onSubmit={handleSubmit}>
        <VStack spacing={6} align="stretch">
          <RadioGroup onChange={setAAOType} value={aaoType}>
            <FormLabel>AAO Type</FormLabel>
            <Stack direction="row">
              <Radio value="macro">Macro AAO</Radio>
              <Radio value="micro">Micro AAO</Radio>
            </Stack>
          </RadioGroup>
          
          <FormControl isRequired>
            <FormLabel>Topic</FormLabel>
            <Input 
              placeholder="Enter AAO topic" 
              value={topic} 
              onChange={(e) => setTopic(e.target.value)} 
            />
          </FormControl>
          
          <FormControl isRequired>
            <FormLabel>Duration (days)</FormLabel>
            <NumberInput 
              min={1} 
              max={365} 
              value={duration} 
              onChange={(valueString) => setDuration(parseInt(valueString))}
            >
              <NumberInputField />
              <NumberInputStepper>
                <NumberIncrementStepper />
                <NumberDecrementStepper />
              </NumberInputStepper>
            </NumberInput>
          </FormControl>
          
          {aaoType === 'micro' && (
            <FormControl isRequired>
              <FormLabel>Parent Macro AAO</FormLabel>
              <Select 
                placeholder="Select parent Macro AAO" 
                value={selectedMacroId} 
                onChange={(e) => setSelectedMacroId(e.target.value)}
              >
                {macroAAOs.map((aao) => (
                  <option key={aao.id} value={aao.id}>
                    {aao.topic} (ID: {aao.id})
                  </option>
                ))}
              </Select>
            </FormControl>
          )}
          
          <Button 
            type="submit" 
            colorScheme="blue" 
            isLoading={isLoading} 
            loadingText="Creating"
            isDisabled={!isConnected || !signer}
          >
            Create AAO
          </Button>
        </VStack>
      </form>
      
      <Divider my={8} />
      
      <Box>
        <Heading size="md" mb={4}>About AAOs</Heading>
        <Text>
          Acentric Autonomous Organizations (AAOs) are decentralized entities that facilitate 
          collaboration between users. Each AAO functions as a mini-blockchain, executing 
          governance, transactions, and automation.
        </Text>
        <Text mt={4}>
          <strong>Macro AAOs</strong> are top-level organizations that can contain multiple Micro AAOs.
        </Text>
        <Text mt={2}>
          <strong>Micro AAOs</strong> are sub-organizations that belong to a parent Macro AAO.
        </Text>
      </Box>
    </Box>
  );
};

export default CreateAAO; 