/**
 * APERTURE - Conversation Service
 */
import { USE_MOCK_API } from '../config.js';
import { get, post } from './api-client.js';
import { mockConversations, mockUsers } from '../mock/mock-data.js';
import { uuid } from '../utils.js';

/** Create or retrieve a direct conversation with a user. */
export async function createConversation(userId) {
  if (USE_MOCK_API) {
    let conv = mockConversations.find((c) => c.participantId === userId);
    if (!conv) {
      const user = mockUsers.find((u) => u.id === userId);
      conv = {
        id: `conv-${uuid().slice(0, 8)}`,
        type: 'direct',
        participantId: userId,
        participantName: user ? user.displayName : 'Unknown',
        participantAvatar: '',
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

/** List all conversations for the current user. */
export async function getConversations() {
  if (USE_MOCK_API) return mockConversations.map((c) => ({ ...c }));
  return get('/api/conversations');
}

/** Get a single conversation by ID. */
export async function getConversation(conversationId) {
  if (USE_MOCK_API) {
    const conv = mockConversations.find((c) => c.id === conversationId);
    return conv ? { ...conv } : null;
  }
  return get(`/api/conversations/${conversationId}`);
}

export default { createConversation, getConversations, getConversation };
