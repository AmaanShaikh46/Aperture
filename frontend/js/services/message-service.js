/**
 * APERTURE - Message Service
 */
import { USE_MOCK_API } from '../config.js';
import { get, post } from './api-client.js';
import { mockMessages, mockConversations, mockCurrentUser } from '../mock/mock-data.js';
import { uuid } from '../utils.js';

/** Get one chronological page of messages, optionally preceding a cursor. */
export async function getMessages(conversationId, { limit = 50, cursor = null } = {}) {
  if (USE_MOCK_API) {
    const compare = (a, b) => {
      const aTime = Date.parse(a.createdAt);
      const bTime = Date.parse(b.createdAt);
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
        return aTime - bTime;
      }
      return String(a.id).localeCompare(String(b.id));
    };
    const allMessages = [...(mockMessages[conversationId] || [])].sort(compare);
    const eligible = cursor
      ? allMessages.filter((message) => {
          const timeDifference = Date.parse(message.createdAt) - Date.parse(cursor.createdAt);
          return timeDifference < 0 || (
            timeDifference === 0 && String(message.id).localeCompare(String(cursor.id)) < 0
          );
        })
      : allMessages;
    const hasMore = eligible.length > limit;
    const items = eligible.slice(-limit).map((message) => ({ ...message }));
    const oldest = items[0];
    return {
      items,
      hasMore,
      nextCursor: hasMore && oldest
        ? { createdAt: oldest.createdAt, id: oldest.id }
        : null,
    };
  }

  const query = { limit: String(limit) };
  if (cursor?.createdAt && cursor?.id) {
    query.before_created_at = cursor.createdAt;
    query.before_id = cursor.id;
  }
  return get(`/api/conversations/${conversationId}/messages`, { query });
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
      const msg = mockMessages[convId].find((m) => String(m.id) === String(messageId));
      if (!msg) continue;
      if (!Array.isArray(msg.receipts)) msg.receipts = [];
      let receipt = msg.receipts.find(
        (item) => String(item.userId) === String(mockCurrentUser.id)
      );
      if (!receipt) {
        receipt = { userId: mockCurrentUser.id, status: 'read', readAt: new Date().toISOString() };
        msg.receipts.push(receipt);
      } else {
        receipt.status = 'read';
        receipt.readAt ||= new Date().toISOString();
      }
      msg.status = 'read';
    }
    return { success: true };
  }
  return post(`/api/messages/${messageId}/read`);
}


export async function uploadAttachment(conversationId, file, caption = '') {
  if (USE_MOCK_API) {
    throw new Error('Media uploads are unavailable in mock mode.');
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('caption', caption);

  return post(
    `/api/conversations/${conversationId}/messages/attachments`,
    formData
  );
}

export async function getAttachmentUrl(attachmentId) {
  if (USE_MOCK_API) {
    throw new Error('Media downloads are unavailable in mock mode.');
  }

  return get(`/api/attachments/${attachmentId}/url`);
}

export default {
  getMessages,
  sendMessage,
  markMessageRead,
  uploadAttachment,
  getAttachmentUrl, 
};