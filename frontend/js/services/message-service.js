/**
 * APERTURE - Message Service
 */
import { USE_MOCK_API } from '../config.js';
import { get, post } from './api-client.js';
import { mockMessages, mockConversations, mockCurrentUser } from '../mock/mock-data.js';
import { uuid } from '../utils.js';

/** Get messages for a conversation (optionally cursor-paginated). */
export async function getMessages(conversationId, cursor) {
  if (USE_MOCK_API) {
    const msgs = mockMessages[conversationId] || [];
    return msgs.map((m) => ({ ...m }));
  }
  const query = {};
  if (cursor) query.cursor = cursor;
  return get(`/api/conversations/${conversationId}/messages`, query ? { query } : undefined);
}

/** Send a message in a conversation. */
export async function sendMessage(conversationId, content) {
  if (USE_MOCK_API) {
    const msg = {
      id: `msg-${uuid().slice(0, 8)}`,
      conversationId,
      senderId: mockCurrentUser.id,
      content,
      createdAt: new Date().toISOString(),
      status: 'sent',
    };
    if (!mockMessages[conversationId]) mockMessages[conversationId] = [];
    mockMessages[conversationId].push(msg);
    // Update conversation last message
    const conv = mockConversations.find((c) => c.id === conversationId);
    if (conv) {
      conv.lastMessage = { ...msg };
      conv.updatedAt = msg.createdAt;
    }
    return { ...msg };
  }
  return post(`/api/conversations/${conversationId}/messages`, { content });
}

/** Mark a message as read. */
export async function markMessageRead(messageId) {
  if (USE_MOCK_API) {
    for (const convId of Object.keys(mockMessages)) {
      const msg = mockMessages[convId].find((m) => m.id === messageId);
      if (msg) msg.status = 'read';
    }
    return { success: true };
  }
  return post(`/api/messages/${messageId}/read`);
}

export default { getMessages, sendMessage, markMessageRead };
