// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../library/LibAAO.sol";

/**
 * @title IAAOFacet
 * @dev Interface for the AAO management facet
 */
interface IAAOFacet {
    // Events
    event AAOCreated(uint256 indexed aaoId, string topic, address indexed owner, uint256 duration);
    event AAOModified(uint256 indexed aaoId, string newTopic, uint256 newDuration);
    event AAOTerminated(uint256 indexed aaoId, address indexed terminator);
    event AAOMemberJoined(uint256 indexed aaoId, address indexed member);
    event AAOMemberLeft(uint256 indexed aaoId, address indexed member);
    event AAOAdminAssigned(uint256 indexed aaoId, address indexed admin);
    event AAOAdminRevoked(uint256 indexed aaoId, address indexed admin);
    event REPAwarded(uint256 indexed aaoId, address indexed user, uint256 amount);
    event REPDeducted(uint256 indexed aaoId, address indexed user, uint256 amount);
    event TransactionExecuted(uint256 indexed aaoId, address indexed from, address indexed to, uint256 amount);
    event ProposalSubmitted(uint256 indexed aaoId, uint256 indexed proposalId, address indexed proposer, string text);
    event VoteCast(uint256 indexed aaoId, uint256 indexed proposalId, address indexed voter, bool support);
    event ProposalExecuted(uint256 indexed aaoId, uint256 indexed proposalId, bool passed);
    event BountyCreated(uint256 indexed aaoId, uint256 indexed taskId, address indexed creator, string description, uint256 reward);
    event TaskAssigned(uint256 indexed aaoId, uint256 indexed taskId, address indexed assignee);
    event TaskCompleted(uint256 indexed aaoId, uint256 indexed taskId, address indexed assignee);
    event TaskVerified(uint256 indexed aaoId, uint256 indexed taskId, bool approved);

    // AAO Lifecycle Management
    function createAAO(string calldata topic, uint256 duration) external returns (uint256 aaoId);
    function modifyAAO(uint256 aaoId, string calldata newTopic, uint256 newDuration) external;
    function terminateAAO(uint256 aaoId) external;

    // Member & Role Management
    function joinAAO(uint256 aaoId) external;
    function leaveAAO(uint256 aaoId) external;
    function assignAdminRole(uint256 aaoId, address member) external;
    function revokeAdminRole(uint256 aaoId, address admin) external;

    // Reputation & Trust System
    function awardREP(address userId, uint256 amount) external;
    function deductREP(address userId, uint256 amount) external;

    // Transaction Handling
    function executeTransaction(uint256 aaoId, address to, uint256 amount) external;

    // Governance & Voting
    function submitProposal(uint256 aaoId, string calldata proposalText) external returns (uint256 proposalId);
    function vote(uint256 proposalId, bool support) external;
    function executeProposal(uint256 proposalId) external;

    // Task & Bounty Systems
    function createBounty(uint256 aaoId, string calldata taskDescription, uint256 rewardAmount) external returns (uint256 taskId);
    function assignTask(uint256 taskId) external;
    function completeTask(uint256 taskId) external;
    function verifyTask(uint256 taskId, bool approved) external;

    // View Functions
    function getAAO(uint256 aaoId) external view returns (LibAAO.AAO memory);
    function isMember(uint256 aaoId, address member) external view returns (bool);
    function isAdmin(uint256 aaoId, address admin) external view returns (bool);
    function getProposal(uint256 proposalId) external view returns (LibAAO.Proposal memory);
    function getTask(uint256 taskId) external view returns (LibAAO.Task memory);
}
