/**
 * APERTURE - Conversation Service
 */
import { USE_MOCK_API } from '../config.js';
import { get, post } from './api-client.js';
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
 *
 * participantIds contains the IDs of the other users to add.
 * The backend remains responsible for authoritative validation.
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

  if (uniqueParticipantIds.length < 2) {
    throw new Error('Select at least two other people for the group.');
  }

  if (uniqueParticipantIds.length > 100) {
    throw new Error('A group cannot have more than 100 invited participants.');
  }

  if (USE_MOCK_API) {
    const selectedIds = new Set(uniqueParticipantIds);

    const selectedUsers = mockUsers.filter(
      (user) => selectedIds.has(user.id)
    );

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

    return {
      ...conversation,
      participants: [...participants],
    };
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
    const conversation = mockConversations.find(
      (c) => c.id === conversationId
    );

    return conversation ? { ...conversation } : null;
  }

  return get(`/api/conversations/${conversationId}`);
}

export default {
  createConversation,
  createGroupConversation,
  getConversations,
  getConversation,
};