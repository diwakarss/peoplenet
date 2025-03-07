// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../interfaces/IAAOFacet.sol";
import "../library/LibAAO.sol";
import "../library/LibErrors.sol";
import "../diamond/LibDiamond.sol";

/**
 * @title AAOFacet
 * @dev Manages Acentric Autonomous Organizations (AAOs) within the PeopleNet ecosystem
 * @custom:version 1.0.0
 */
contract AAOFacet is IAAOFacet {
    /**
     * @dev Modifier to ensure only the AAO owner or admin can perform certain actions
     * @param aaoId The ID of the AAO
     */
    modifier onlyAAOOwnerOrAdmin(uint256 aaoId) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        LibAAO.AAOInternal storage aao = aaoStorage.aaoById[aaoId];
        require(
            aao.owner == msg.sender || 
            aao.isAdmin[msg.sender],
            "AAOFacet: Not owner or admin"
        );
        _;
    }

    /**
     * @dev Modifier to ensure only AAO members can perform certain actions
     * @param aaoId The ID of the AAO
     */
    modifier onlyAAOMember(uint256 aaoId) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        LibAAO.AAOInternal storage aao = aaoStorage.aaoById[aaoId];
        require(
            aao.isMember[msg.sender],
            "AAOFacet: Not a member"
        );
        _;
    }

    /**
     * @dev Creates a new AAO
     * @param topic The topic or purpose of the AAO
     * @param duration The duration of the AAO in seconds (0 for permanent)
     * @return aaoId The ID of the newly created AAO
     */
    function createAAO(
        string calldata topic,
        uint256 duration
    ) external override returns (uint256 aaoId) {
        LibDiamond.enforceIsContractOwner();
        
        // Use the LibAAO.createAAO helper function
        aaoId = LibAAO.createAAO(
            topic,
            duration,
            msg.sender,
            true, // isMacro = true for AAOs created directly
            0     // macroAAOId = 0 (not applicable for macro AAOs)
        );
        
        emit AAOCreated(aaoId, topic, msg.sender, duration);
        return aaoId;
    }

    /**
     * @dev Modifies an existing AAO's properties
     * @param aaoId The ID of the AAO to modify
     * @param newTopic The new topic for the AAO
     * @param newDuration The new duration for the AAO
     */
    function modifyAAO(
        uint256 aaoId,
        string calldata newTopic,
        uint256 newDuration
    ) external override onlyAAOOwnerOrAdmin(aaoId) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        LibAAO.AAOInternal storage aao = aaoStorage.aaoById[aaoId];
        
        require(aao.active, "AAOFacet: AAO not active");
        
        aao.topic = newTopic;
        
        if (newDuration > 0) {
            aao.duration = newDuration;
        }
        
        emit AAOModified(aaoId, newTopic, newDuration);
    }

    /**
     * @dev Terminates an AAO
     * @param aaoId The ID of the AAO to terminate
     */
    function terminateAAO(uint256 aaoId) external override onlyAAOOwnerOrAdmin(aaoId) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        LibAAO.AAOInternal storage aao = aaoStorage.aaoById[aaoId];
        
        require(aao.active, "AAOFacet: AAO not active");
        
        aao.active = false;
        
        emit AAOTerminated(aaoId, msg.sender);
    }

    /**
     * @dev Allows a user to join an AAO
     * @param aaoId The ID of the AAO to join
     */
    function joinAAO(uint256 aaoId) external override {
        // Use the LibAAO.joinAAO helper function
        LibAAO.joinAAO(aaoId, msg.sender);
        
        emit AAOMemberJoined(aaoId, msg.sender);
    }

    /**
     * @dev Allows a user to leave an AAO
     * @param aaoId The ID of the AAO to leave
     */
    function leaveAAO(uint256 aaoId) external override onlyAAOMember(aaoId) {
        // Use the LibAAO.leaveAAO helper function
        LibAAO.leaveAAO(aaoId, msg.sender);
        
        emit AAOMemberLeft(aaoId, msg.sender);
    }

    /**
     * @dev Assigns admin role to a member
     * @param aaoId The ID of the AAO
     * @param member The address of the member to promote
     */
    function assignAdminRole(
        uint256 aaoId,
        address member
    ) external override onlyAAOOwnerOrAdmin(aaoId) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        LibAAO.AAOInternal storage aao = aaoStorage.aaoById[aaoId];
        
        require(aao.active, "AAOFacet: AAO not active");
        require(aao.isMember[member], "AAOFacet: Not a member");
        require(!aao.isAdmin[member], "AAOFacet: Already an admin");
        
        aao.isAdmin[member] = true;
        
        emit AAOAdminAssigned(aaoId, member);
    }

    /**
     * @dev Revokes admin role from a member
     * @param aaoId The ID of the AAO
     * @param admin The address of the admin to demote
     */
    function revokeAdminRole(
        uint256 aaoId,
        address admin
    ) external override onlyAAOOwnerOrAdmin(aaoId) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        LibAAO.AAOInternal storage aao = aaoStorage.aaoById[aaoId];
        
        // Cannot revoke owner's admin status
        require(aao.owner != admin, "AAOFacet: Cannot revoke owner admin");
        require(aao.isAdmin[admin], "AAOFacet: Not an admin");
        
        aao.isAdmin[admin] = false;
        
        emit AAOAdminRevoked(aaoId, admin);
    }

    /**
     * @dev Awards reputation points to a user
     * @param userId The address of the user
     * @param amount The amount of REP to award
     */
    function awardREP(
        address userId,
        uint256 amount
    ) external {
        // This would integrate with the REP token system
        // Implementation depends on how REP tokens are managed
        // For now, we'll just emit the event with a default AAO ID
        uint256 aaoId = 0; // Default AAO ID
        emit REPAwarded(aaoId, userId, amount);
    }

    /**
     * @dev Deducts reputation points from a user
     * @param userId The address of the user
     * @param amount The amount of REP to deduct
     */
    function deductREP(
        address userId,
        uint256 amount
    ) external {
        // This would integrate with the REP token system
        // Implementation depends on how REP tokens are managed
        // For now, we'll just emit the event with a default AAO ID
        uint256 aaoId = 0; // Default AAO ID
        emit REPDeducted(aaoId, userId, amount);
    }

    /**
     * @dev Executes a zero-gas transaction within an AAO
     * @param aaoId The ID of the AAO
     * @param to The recipient address
     * @param amount The amount to transfer
     */
    function executeTransaction(
        uint256 aaoId,
        address to,
        uint256 amount
    ) external override onlyAAOMember(aaoId) {
        // This would integrate with the PNT token system for gasless transactions
        // Implementation depends on how PNT tokens are managed
        emit TransactionExecuted(aaoId, msg.sender, to, amount);
    }

    /**
     * @dev Submits a governance proposal
     * @param aaoId The ID of the AAO
     * @param proposalText The text of the proposal
     * @return proposalId The ID of the created proposal
     */
    function submitProposal(
        uint256 aaoId,
        string calldata proposalText
    ) external override onlyAAOMember(aaoId) returns (uint256 proposalId) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        LibAAO.AAOInternal storage aao = aaoStorage.aaoById[aaoId];
        
        require(aao.active, "AAOFacet: AAO not active");
        
        proposalId = aaoStorage.proposalCount;
        aaoStorage.proposalCount++;
        
        aaoStorage.proposals[proposalId] = LibAAO.Proposal({
            id: proposalId,
            aaoId: aaoId,
            proposer: msg.sender,
            text: proposalText,
            forVotes: 0,
            againstVotes: 0,
            status: LibAAO.ProposalStatus.Active,
            createdAt: block.timestamp
        });
        
        emit ProposalSubmitted(aaoId, proposalId, msg.sender, proposalText);
        return proposalId;
    }

    /**
     * @dev Casts a vote on a proposal
     * @param proposalId The ID of the proposal
     * @param support Whether the voter supports the proposal
     */
    function vote(
        uint256 proposalId,
        bool support
    ) external override {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        
        LibAAO.Proposal storage proposal = aaoStorage.proposals[proposalId];
        uint256 aaoId = proposal.aaoId;
        LibAAO.AAOInternal storage aao = aaoStorage.aaoById[aaoId];
        
        require(proposal.status == LibAAO.ProposalStatus.Active, "AAOFacet: Proposal not active");
        require(aao.isMember[msg.sender], "AAOFacet: Not a member");
        require(!aaoStorage.hasVoted[proposalId][msg.sender], "AAOFacet: Already voted");
        
        aaoStorage.hasVoted[proposalId][msg.sender] = true;
        
        if (support) {
            proposal.forVotes++;
        } else {
            proposal.againstVotes++;
        }
        
        emit VoteCast(aaoId, proposalId, msg.sender, support);
    }

    /**
     * @dev Executes a proposal after voting period
     * @param proposalId The ID of the proposal to execute
     */
    function executeProposal(uint256 proposalId) external override {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        
        LibAAO.Proposal storage proposal = aaoStorage.proposals[proposalId];
        uint256 aaoId = proposal.aaoId;
        LibAAO.AAOInternal storage aao = aaoStorage.aaoById[aaoId];
        
        require(proposal.status == LibAAO.ProposalStatus.Active, "AAOFacet: Proposal not active");
        require(aao.isMember[msg.sender], "AAOFacet: Not a member");
        
        // Simple majority voting
        bool passed = proposal.forVotes > proposal.againstVotes;
        
        if (passed) {
            proposal.status = LibAAO.ProposalStatus.Executed;
        } else {
            proposal.status = LibAAO.ProposalStatus.Rejected;
        }
        
        emit ProposalExecuted(aaoId, proposalId, passed);
    }

    /**
     * @dev Creates a bounty task
     * @param aaoId The ID of the AAO
     * @param taskDescription Description of the task
     * @param rewardAmount Amount of reward for completing the task
     * @return taskId The ID of the created task
     */
    function createBounty(
        uint256 aaoId,
        string calldata taskDescription,
        uint256 rewardAmount
    ) external override onlyAAOMember(aaoId) returns (uint256 taskId) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        LibAAO.AAOInternal storage aao = aaoStorage.aaoById[aaoId];
        
        require(aao.active, "AAOFacet: AAO not active");
        
        taskId = aaoStorage.taskCount;
        aaoStorage.taskCount++;
        
        aaoStorage.tasks[taskId] = LibAAO.Task({
            id: taskId,
            aaoId: aaoId,
            creator: msg.sender,
            description: taskDescription,
            reward: rewardAmount,
            assignee: address(0),
            status: LibAAO.TaskStatus.Open,
            createdAt: block.timestamp,
            assignedAt: 0,
            completedAt: 0
        });
        
        emit BountyCreated(aaoId, taskId, msg.sender, taskDescription, rewardAmount);
        return taskId;
    }

    /**
     * @dev Assigns a task to a member
     * @param taskId The ID of the task
     */
    function assignTask(uint256 taskId) external override {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        
        LibAAO.Task storage task = aaoStorage.tasks[taskId];
        uint256 aaoId = task.aaoId;
        LibAAO.AAOInternal storage aao = aaoStorage.aaoById[aaoId];
        
        require(task.status == LibAAO.TaskStatus.Open, "AAOFacet: Task not open");
        require(aao.isMember[msg.sender], "AAOFacet: Not a member");
        
        task.assignee = msg.sender;
        task.status = LibAAO.TaskStatus.Assigned;
        task.assignedAt = block.timestamp;
        
        emit TaskAssigned(aaoId, taskId, msg.sender);
    }

    /**
     * @dev Completes a task
     * @param taskId The ID of the task
     */
    function completeTask(uint256 taskId) external override {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        
        LibAAO.Task storage task = aaoStorage.tasks[taskId];
        uint256 aaoId = task.aaoId;
        
        require(task.status == LibAAO.TaskStatus.Assigned, "AAOFacet: Task not assigned");
        require(task.assignee == msg.sender, "AAOFacet: Not the assignee");
        
        task.status = LibAAO.TaskStatus.PendingVerification;
        
        emit TaskCompleted(aaoId, taskId, msg.sender);
    }

    /**
     * @dev Verifies a completed task
     * @param taskId The ID of the task
     * @param approved Whether the task is approved
     */
    function verifyTask(
        uint256 taskId,
        bool approved
    ) external override {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        
        LibAAO.Task storage task = aaoStorage.tasks[taskId];
        uint256 aaoId = task.aaoId;
        LibAAO.AAOInternal storage aao = aaoStorage.aaoById[aaoId];
        
        // Check if caller is owner or admin
        require(
            aao.owner == msg.sender || 
            aao.isAdmin[msg.sender],
            "AAOFacet: Not owner or admin"
        );
        
        require(task.status == LibAAO.TaskStatus.PendingVerification, "AAOFacet: Task not pending verification");
        
        if (approved) {
            task.status = LibAAO.TaskStatus.Completed;
            task.completedAt = block.timestamp;
            
            // This would integrate with the token system for reward payment
            // Implementation depends on how tokens are managed
            
            emit TaskVerified(aaoId, taskId, true);
        } else {
            task.status = LibAAO.TaskStatus.Rejected;
            emit TaskVerified(aaoId, taskId, false);
        }
    }

    /**
     * @dev Gets information about an AAO
     * @param aaoId The ID of the AAO
     * @return AAO information
     */
    function getAAO(uint256 aaoId) external view override returns (LibAAO.AAO memory) {
        return LibAAO.getExternalAAO(aaoId);
    }

    /**
     * @dev Checks if an address is a member of an AAO
     * @param aaoId The ID of the AAO
     * @param member The address to check
     * @return True if the address is a member
     */
    function isMember(uint256 aaoId, address member) external view override returns (bool) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        LibAAO.AAOInternal storage aao = aaoStorage.aaoById[aaoId];
        return aao.isMember[member];
    }

    /**
     * @dev Checks if an address is an admin of an AAO
     * @param aaoId The ID of the AAO
     * @param admin The address to check
     * @return True if the address is an admin
     */
    function isAdmin(uint256 aaoId, address admin) external view override returns (bool) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        LibAAO.AAOInternal storage aao = aaoStorage.aaoById[aaoId];
        return aao.isAdmin[admin];
    }

    /**
     * @dev Gets information about a proposal
     * @param proposalId The ID of the proposal
     * @return Proposal information
     */
    function getProposal(uint256 proposalId) external view override returns (LibAAO.Proposal memory) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        return aaoStorage.proposals[proposalId];
    }

    /**
     * @dev Gets information about a task
     * @param taskId The ID of the task
     * @return Task information
     */
    function getTask(uint256 taskId) external view override returns (LibAAO.Task memory) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        return aaoStorage.tasks[taskId];
    }
}
