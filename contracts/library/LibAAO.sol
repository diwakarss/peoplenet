// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title LibAAO
 * @dev Library for AAO storage and data structures
 */
library LibAAO {
    bytes32 constant STORAGE_POSITION = keccak256("peoplenet.aao.storage");

    enum ProposalStatus { Active, Executed, Rejected }
    enum TaskStatus { Open, Assigned, PendingVerification, Completed, Rejected }

    // Internal AAO struct with mappings (for storage)
    struct AAOInternal {
        string topic;
        uint256 duration;
        address owner;
        bool active;
        bool isMacro;
        address[] members;
        mapping(address => bool) isMember;
        mapping(address => bool) isAdmin;
        uint256 macroAAOId; // For micro AAOs, the ID of their parent macro AAO
    }

    // External AAO struct without mappings (for return values)
    struct AAO {
        string topic;
        uint256 duration;
        address owner;
        bool active;
        bool isMacro;
        address[] members;
        uint256 macroAAOId;
    }

    struct Proposal {
        uint256 id;
        uint256 aaoId;
        address proposer;
        string text;
        uint256 forVotes;
        uint256 againstVotes;
        ProposalStatus status;
        uint256 createdAt;
    }

    struct Task {
        uint256 id;
        uint256 aaoId;
        address creator;
        string description;
        uint256 reward;
        address assignee;
        TaskStatus status;
        uint256 createdAt;
        uint256 assignedAt;
        uint256 completedAt;
    }

    struct AAOStorage {
        mapping(uint256 => AAOInternal) aaoById;
        uint256 aaoCount;
        mapping(address => uint256[]) aaosByCreator;
        mapping(address => uint256[]) aaosByMember;
        mapping(uint256 => uint256[]) microAAOsByMacroId;
        
        // Proposal management
        mapping(uint256 => Proposal) proposals;
        uint256 proposalCount;
        mapping(uint256 => mapping(address => bool)) hasVoted;
        
        // Task management
        mapping(uint256 => Task) tasks;
        uint256 taskCount;
    }

    /**
     * @dev Returns the AAO storage
     * @return ds The storage struct
     */
    function aaoStorage() internal pure returns (AAOStorage storage ds) {
        bytes32 position = STORAGE_POSITION;
        assembly {
            ds.slot := position
        }
    }

    // Helper function to convert internal AAO to external AAO
    function getExternalAAO(uint256 aaoId) internal view returns (AAO memory) {
        AAOStorage storage ds = aaoStorage();
        AAOInternal storage internalAAO = ds.aaoById[aaoId];
        
        // Create external AAO without mappings
        return AAO({
            topic: internalAAO.topic,
            duration: internalAAO.duration,
            owner: internalAAO.owner,
            active: internalAAO.active,
            isMacro: internalAAO.isMacro,
            members: internalAAO.members,
            macroAAOId: internalAAO.macroAAOId
        });
    }

    function createAAO(
        string memory _topic,
        uint256 _duration,
        address _owner,
        bool _isMacro,
        uint256 _macroAAOId
    ) internal returns (uint256) {
        AAOStorage storage ds = aaoStorage();
        uint256 aaoId = ds.aaoCount;
        
        AAOInternal storage aao = ds.aaoById[aaoId];
        aao.topic = _topic;
        aao.duration = _duration;
        aao.owner = _owner;
        aao.active = true;
        aao.isMacro = _isMacro;
        
        // Add owner as first member and admin
        aao.members.push(_owner);
        aao.isMember[_owner] = true;
        aao.isAdmin[_owner] = true;
        
        // If it's a micro AAO, set the macro AAO ID and update the relationship
        if (!_isMacro) {
            aao.macroAAOId = _macroAAOId;
            ds.microAAOsByMacroId[_macroAAOId].push(aaoId);
        }
        
        // Update mappings
        ds.aaosByCreator[_owner].push(aaoId);
        ds.aaosByMember[_owner].push(aaoId);
        
        // Increment AAO count
        ds.aaoCount++;
        
        return aaoId;
    }

    function joinAAO(uint256 _aaoId, address _member) internal {
        AAOStorage storage ds = aaoStorage();
        AAOInternal storage aao = ds.aaoById[_aaoId];
        
        require(aao.active, "AAO is not active");
        require(!aao.isMember[_member], "Already a member");
        
        aao.members.push(_member);
        aao.isMember[_member] = true;
        ds.aaosByMember[_member].push(_aaoId);
    }

    function leaveAAO(uint256 _aaoId, address _member) internal {
        AAOStorage storage ds = aaoStorage();
        AAOInternal storage aao = ds.aaoById[_aaoId];
        
        require(aao.isMember[_member], "Not a member of this AAO");
        require(_member != aao.owner, "Owner cannot leave AAO");
        
        // Remove from members array
        for (uint256 i = 0; i < aao.members.length; i++) {
            if (aao.members[i] == _member) {
                aao.members[i] = aao.members[aao.members.length - 1];
                aao.members.pop();
                break;
            }
        }
        
        aao.isMember[_member] = false;
        
        // If member was an admin, revoke admin status
        if (aao.isAdmin[_member]) {
            aao.isAdmin[_member] = false;
        }
        
        // Remove from aaosByMember mapping
        uint256[] storage memberAAOs = ds.aaosByMember[_member];
        for (uint256 i = 0; i < memberAAOs.length; i++) {
            if (memberAAOs[i] == _aaoId) {
                memberAAOs[i] = memberAAOs[memberAAOs.length - 1];
                memberAAOs.pop();
                break;
            }
        }
    }
}
