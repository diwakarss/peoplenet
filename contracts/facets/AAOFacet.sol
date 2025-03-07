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
        require(
            aaoStorage.aaos[aaoId].owner == msg.sender || 
            aaoStorage.aaoAdmins[aaoId][msg.sender],
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
        require(
            aaoStorage.aaoMembers[aaoId][msg.sender],
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
        
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        
        aaoId = aaoStorage.aaoCounter;
        aaoStorage.aaoCounter++;
        
        aaoStorage.aaos[aaoId] = LibAAO.AAO({
            id: aaoId,
            topic: topic,
            owner: msg.sender,
            createdAt: block.timestamp,
            expiresAt: duration == 0 ? 0 : block.timestamp + duration,
            memberCount: 1,
            isActive: true
        });
        
        // Add creator as a member and admin
        aaoStorage.aaoMembers[aaoId][msg.sender] = true;
        aaoStorage.aaoAdmins[aaoId][msg.sender] = true;
        
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
        
        require(aaoStorage.aaos[aaoId].isActive, "AAOFacet: AAO not active");
        
        aaoStorage.aaos[aaoId].topic = newTopic;
        
        if (newDuration > 0) {
            aaoStorage.aaos[aaoId].expiresAt = block.timestamp + newDuration;
        }
        
        emit AAOModified(aaoId, newTopic, newDuration);
    }

    /**
     * @dev Terminates an AAO
     * @param aaoId The ID of the AAO to terminate
     */
    function terminateAAO(uint256 aaoId) external override onlyAAOOwnerOrAdmin(aaoId) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        
        require(aaoStorage.aaos[aaoId].isActive, "AAOFacet: AAO not active");
        
        aaoStorage.aaos[aaoId].isActive = false;
        
        emit AAOTerminated(aaoId, msg.sender);
    }

    /**
     * @dev Allows a user to join an AAO
     * @param aaoId The ID of the AAO to join
     */
    function joinAAO(uint256 aaoId) external override {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        
        require(aaoStorage.aaos[aaoId].isActive, "AAOFacet: AAO not active");
        require(!aaoStorage.aaoMembers[aaoId][msg.sender], "AAOFacet: Already a member");
        
        // Check if AAO has expired
        if (aaoStorage.aaos[aaoId].expiresAt > 0) {
            require(
                block.timestamp < aaoStorage.aaos[aaoId].expiresAt,
                "AAOFacet: AAO expired"
            );
        }
        
        aaoStorage.aaoMembers[aaoId][msg.sender] = true;
        aaoStorage.aaos[aaoId].memberCount++;
        
        emit AAOMemberJoined(aaoId, msg.sender);
    }

    /**
     * @dev Allows a user to leave an AAO
     * @param aaoId The ID of the AAO to leave
     */
    function leaveAAO(uint256 aaoId) external override onlyAAOMember(aaoId) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        
        // Owner cannot leave their own AAO
        require(aaoStorage.aaos[aaoId].owner != msg.sender, "AAOFacet: Owner cannot leave");
        
        aaoStorage.aaoMembers[aaoId][msg.sender] = false;
        
        // If user was an admin, remove admin status
        if (aaoStorage.aaoAdmins[aaoId][msg.sender]) {
            aaoStorage.aaoAdmins[aaoId][msg.sender] = false;
        }
        
        aaoStorage.aaos[aaoId].memberCount--;
        
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
        
        require(aaoStorage.aaos[aaoId].isActive, "AAOFacet: AAO not active");
        require(aaoStorage.aaoMembers[aaoId][member], "AAOFacet: Not a member");
        require(!aaoStorage.aaoAdmins[aaoId][member], "AAOFacet: Already an admin");
        
        aaoStorage.aaoAdmins[aaoId][member] = true;
        
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
        
        // Cannot revoke owner's admin status
        require(aaoStorage.aaos[aaoId].owner != admin, "AAOFacet: Cannot revoke owner admin");
        require(aaoStorage.aaoAdmins[aaoId][admin], "AAOFacet: Not an admin");
        
        aaoStorage.aaoAdmins[aaoId][admin] = false;
        
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
    ) external override onlyAAOOwnerOrAdmin(aaoId) {
        // This would integrate with the REP token system
        // Implementation depends on how REP tokens are managed
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
    ) external override onlyAAOOwnerOrAdmin(aaoId) {
        // This would integrate with the REP token system
        // Implementation depends on how REP tokens are managed
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
        
        require(aaoStorage.aaos[aaoId].isActive, "AAOFacet: AAO not active");
        
        proposalId = aaoStorage.proposalCounter;
        aaoStorage.proposalCounter++;
        
        aaoStorage.proposals[proposalId] = LibAAO.Proposal({
            id: proposalId,
            aaoId: aaoId,
            proposer: msg.sender,
            text: proposalText,
            createdAt: block.timestamp,
            status: LibAAO.ProposalStatus.Active,
            yesVotes: 0,
            noVotes: 0
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
        
        require(proposal.status == LibAAO.ProposalStatus.Active, "AAOFacet: Proposal not active");
        require(aaoStorage.aaoMembers[aaoId][msg.sender], "AAOFacet: Not a member");
        require(!aaoStorage.hasVoted[proposalId][msg.sender], "AAOFacet: Already voted");
        
        aaoStorage.hasVoted[proposalId][msg.sender] = true;
        
        if (support) {
            proposal.yesVotes++;
        } else {
            proposal.noVotes++;
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
        
        require(proposal.status == LibAAO.ProposalStatus.Active, "AAOFacet: Proposal not active");
        require(aaoStorage.aaoMembers[aaoId][msg.sender], "AAOFacet: Not a member");
        
        // Simple majority voting
        bool passed = proposal.yesVotes > proposal.noVotes;
        
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
        
        require(aaoStorage.aaos[aaoId].isActive, "AAOFacet: AAO not active");
        
        taskId = aaoStorage.taskCounter;
        aaoStorage.taskCounter++;
        
        aaoStorage.tasks[taskId] = LibAAO.Task({
            id: taskId,
            aaoId: aaoId,
            creator: msg.sender,
            description: taskDescription,
            reward: rewardAmount,
            createdAt: block.timestamp,
            completedAt: 0,
            assignee: address(0),
            status: LibAAO.TaskStatus.Open
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
        
        require(task.status == LibAAO.TaskStatus.Open, "AAOFacet: Task not open");
        require(aaoStorage.aaoMembers[aaoId][msg.sender], "AAOFacet: Not a member");
        
        task.assignee = msg.sender;
        task.status = LibAAO.TaskStatus.Assigned;
        
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
    ) external override onlyAAOOwnerOrAdmin(task.aaoId) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        
        LibAAO.Task storage task = aaoStorage.tasks[taskId];
        uint256 aaoId = task.aaoId;
        
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
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        return aaoStorage.aaos[aaoId];
    }

    /**
     * @dev Checks if an address is a member of an AAO
     * @param aaoId The ID of the AAO
     * @param member The address to check
     * @return True if the address is a member
     */
    function isMember(uint256 aaoId, address member) external view override returns (bool) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        return aaoStorage.aaoMembers[aaoId][member];
    }

    /**
     * @dev Checks if an address is an admin of an AAO
     * @param aaoId The ID of the AAO
     * @param admin The address to check
     * @return True if the address is an admin
     */
    function isAdmin(uint256 aaoId, address admin) external view override returns (bool) {
        LibAAO.AAOStorage storage aaoStorage = LibAAO.aaoStorage();
        return aaoStorage.aaoAdmins[aaoId][admin];
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
