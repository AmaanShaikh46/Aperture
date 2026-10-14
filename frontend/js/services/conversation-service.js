/**
 * APERTURE - Conversation Service
 */
import { USE_MOCK_API } from '../config.js';
import { get, post, patch, deleteRequest } from './api-client.js';
import {
  mockConversations,
  mockUsers,
  mockCurrentUser,
} from '../mock/mock-data.js';
import { uuid } from '../utils.js';

/** Create or retrieve a direct conversation with a user. */
export async function createConversation(userId) {
  if (USE_MOCK_API) {
    let conv = mockConversations.find(
      (c) => c.type === 'direct' && c.participantId === userId
    );

    if (!conv) {
      const user = mockUsers.find((u) => u.id === userId);

      conv = {
        id: `conv-${uuid().slice(0, 8)}`,
        type: 'direct',
        participantId: userId,
        participantName: user ? user.displayName : 'Unknown',
        participantAvatar: user?.avatarUrl || '',
        participants: [],
        lastMessage: null,
        unreadCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockConversations.unshift(conv);
    }

    return { ...conv };
  }

  return post('/api/conversations', { userId });
}

/**
 * Create a group conversation with the current user as its administrator.
 * participantIds contains the IDs of the other users to add.
 */
export async function createGroupConversation(name, participantIds) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Enter a group name.');
  }

  if (!Array.isArray(participantIds)) {
    throw new Error('Select the group participants.');
  }

  const normalizedName = name.trim();
  const uniqueParticipantIds = [...new Set(participantIds)];

  if (normalizedName.length > 100) {
    throw new Error('Group name cannot exceed 100 characters.');
  }

  if (uniqueParticipantIds.length < 1) {
    throw new Error('Select at least one other person for the group.');
  }

  if (uniqueParticipantIds.length > 100) {
    throw new Error('A group cannot have more than 100 invited participants.');
  }

  if (USE_MOCK_API) {
    const selectedIds = new Set(uniqueParticipantIds);
    const selectedUsers = mockUsers.filter((user) => selectedIds.has(user.id));

    if (selectedUsers.length !== selectedIds.size) {
      throw new Error('One or more selected users could not be found.');
    }

    const participants = [
      {
        id: mockCurrentUser.id,
        displayName: mockCurrentUser.displayName,
        avatarUrl: mockCurrentUser.avatarUrl || null,
        role: 'admin',
      },
      ...selectedUsers.map((user) => ({
        id: user.id,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl || null,
        role: 'member',
      })),
    ];

    const now = new Date().toISOString();
    const conversation = {
      id: `conv-${uuid().slice(0, 8)}`,
      type: 'group',
      name: normalizedName,
      participantId: null,
      participantName: normalizedName,
      participantAvatar: null,
      participants,
      lastMessage: null,
      unreadCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    mockConversations.unshift(conversation);
    return { ...conversation, participants: [...participants] };
  }

  return post('/api/conversations', {
    type: 'group',
    name: normalizedName,
    participantIds: uniqueParticipantIds,
  });
}

/** List all conversations for the current user. */
export async function getConversations() {
  if (USE_MOCK_API) {
    return mockConversations.map((conversation) => ({ ...conversation }));
  }

  return get('/api/conversations');
}

/** Get a single conversation by ID. */
export async function getConversation(conversationId) {
  if (USE_MOCK_API) {
    const conversation = mockConversations.find((c) => c.id === conversationId);
    return conversation ? { ...conversation } : null;
  }

  return get(`/api/conversations/${conversationId}`);
}

/** Rename a group conversation. */
export async function renameGroupConversation(conversationId, name) {
  const trimmedName = String(name ?? '').trim();

  if (!trimmedName) throw new Error('Group name is required.');
  if (trimmedName.length > 100) {
    throw new Error('Group name cannot exceed 100 characters.');
  }

  if (USE_MOCK_API) {
    const conversation = mockConversations.find((item) => item.id === conversationId);
    if (!conversation) throw new Error('Conversation not found.');
    if (conversation.type !== 'group') throw new Error('Only groups can be renamed.');

    conversation.name = trimmedName;
    conversation.participantName = trimmedName;
    conversation.updatedAt = new Date().toISOString();
    return { ...conversation };
  }

  return patch(
    `/api/conversations/${encodeURIComponent(conversationId)}/name`,
    { name: trimmedName }
  );
}

/** Add members to an existing group conversation. */
export async function addGroupParticipants(conversationId, participantIds) {
  if (!Array.isArray(participantIds) || participantIds.length === 0) {
    throw new Error('Select at least one person to add.');
  }

  const uniqueIds = [...new Set(participantIds)];
  if (uniqueIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error('One or more participant IDs are invalid.');
  }
  if (uniqueIds.length > 100) {
    throw new Error('You cannot add more than 100 participants at once.');
  }

  if (USE_MOCK_API) {
    const conversation = mockConversations.find((item) => item.id === conversationId);
    if (!conversation) throw new Error('Conversation not found.');
    if (conversation.type !== 'group') throw new Error('Members can only be added to groups.');

    const participants = conversation.participants || [];
    const existingIds = new Set(participants.map((participant) => String(participant.id)));
    const selectedIds = new Set(uniqueIds);
    const selectedUsers = mockUsers.filter((user) => selectedIds.has(String(user.id)));

    if (selectedUsers.length !== selectedIds.size) {
      throw new Error('One or more selected users could not be found.');
    }

    const newUsers = selectedUsers.filter((user) => !existingIds.has(String(user.id)));
    if (participants.length + newUsers.length > 101) {
      throw new Error('A group cannot have more than 101 members.');
    }

    if (newUsers.length > 0) {
      conversation.participants = [
        ...participants,
        ...newUsers.map((user) => ({
          id: user.id,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl || null,
          role: 'member',
        })),
      ];
      conversation.updatedAt = new Date().toISOString();
    }

    return { ...conversation, participants: [...(conversation.participants || [])] };
  }

  return post(
    `/api/conversations/${encodeURIComponent(conversationId)}/participants`,
    { participantIds: uniqueIds }
  );
}

/** Remove a regular member from a group. Only admins may do this. */
export async function removeGroupParticipant(conversationId, participantId) {
  const memberId = String(participantId ?? '').trim();
  if (!memberId) throw new Error('Select a group member to remove.');

  if (USE_MOCK_API) {
    const conversation = mockConversations.find((item) => item.id === conversationId);
    if (!conversation) throw new Error('Conversation not found.');
    if (conversation.type !== 'group') throw new Error('Members can only be removed from groups.');

    const participants = conversation.participants || [];
    const currentUser = participants.find(
      (participant) => String(participant.id) === String(mockCurrentUser.id)
    );
    if (currentUser?.role !== 'admin') {
      throw new Error('Only group admins can remove members.');
    }
    if (memberId === String(mockCurrentUser.id)) {
      throw new Error('Admins cannot remove themselves.');
    }

    const target = participants.find((participant) => String(participant.id) === memberId);
    if (!target) throw new Error('That user is not a member of this group.');
    if (String(target.role).toLowerCase() === 'admin') {
      throw new Error('Administrators cannot be removed. Transfer admin role first.');
    }

    conversation.participants = participants.filter(
      (participant) => String(participant.id) !== memberId
    );
    conversation.updatedAt = new Date().toISOString();

    return {
      conversationId: String(conversation.id),
      name: conversation.name,
      updatedAt: conversation.updatedAt,
      removedMemberId: memberId,
      participants: [...conversation.participants],
    };
  }

  return deleteRequest(
    `/api/conversations/${encodeURIComponent(conversationId)}/participants/${encodeURIComponent(memberId)}`
  );
}


/** Transfer group administration to an existing regular member. */
export async function transferGroupAdmin(conversationId, participantId) {
  const targetId = String(participantId ?? '').trim();
  if (!targetId) throw new Error('Select a group member to become the admin.');

  if (USE_MOCK_API) {
    const conversation = mockConversations.find((item) => item.id === conversationId);
    if (!conversation || conversation.type !== 'group') {
      throw new Error('Group conversation not found.');
    }
    const participants = conversation.participants || [];
    const current = participants.find(
      (participant) => String(participant.id) === String(mockCurrentUser.id)
    );
    const target = participants.find(
      (participant) => String(participant.id) === targetId
    );
    if (current?.role !== 'admin') throw new Error('Only the current group admin can transfer administration.');
    if (!target) throw new Error('The selected user is not a member of this group.');
    if (target.role === 'admin') throw new Error('The selected member is already an administrator.');
    current.role = 'member';
    target.role = 'admin';
    conversation.updatedAt = new Date().toISOString();
    return {
      conversationId: String(conversation.id),
      name: conversation.name,
      updatedAt: conversation.updatedAt,
      adminUserId: targetId,
      participants: [...participants],
    };
  }

  return post(
    `/api/conversations/${encodeURIComponent(conversationId)}/transfer-admin`,
    { participantId: targetId }
  );
}

/** Leave a group as a regular member. Group admins must transfer admin first. */
export async function leaveGroupConversation(conversationId) {
  if (USE_MOCK_API) {
    const index = mockConversations.findIndex((item) => item.id === conversationId);
    if (index < 0) throw new Error('Group conversation not found.');
    const conversation = mockConversations[index];
    if (conversation.type !== 'group') throw new Error('Only group conversations can be left.');
    const participants = conversation.participants || [];
    const current = participants.find(
      (participant) => String(participant.id) === String(mockCurrentUser.id)
    );
    if (!current) throw new Error('You are not a member of this group.');
    if (current.role === 'admin') {
      throw new Error('Transfer admin rights to another member before leaving the group.');
    }
    conversation.participants = participants.filter(
      (participant) => String(participant.id) !== String(mockCurrentUser.id)
    );
    conversation.updatedAt = new Date().toISOString();
    const payload = {
      conversationId: String(conversation.id),
      name: conversation.name,
      updatedAt: conversation.updatedAt,
      removedMemberId: String(mockCurrentUser.id),
      leftBySelf: true,
      participants: [...conversation.participants],
    };
    mockConversations.splice(index, 1);
    return payload;
  }

  return post(`/api/conversations/${encodeURIComponent(conversationId)}/leave`);
}

export default {
  createConversation,
  createGroupConversation,
  getConversations,
  getConversation,
  renameGroupConversation,
  addGroupParticipants,
  removeGroupParticipant,
  transferGroupAdmin,
  leaveGroupConversation,
};
