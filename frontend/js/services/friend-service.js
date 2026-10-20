/**
 * APERTURE - Mutual friendship and friend-request service.
 * The server is authoritative for every production relationship decision.
 */
import { USE_MOCK_API } from '../config.js';
import { get, post, deleteRequest } from './api-client.js';
import { mockContacts, mockUsers, mockCurrentUser } from '../mock/mock-data.js';
import { uuid } from '../utils.js';

const mockFriendRequests = [];

function getMockUser(userId) {
  return mockUsers.find((user) => String(user.id) === String(userId));
}

export function getMockRelationshipState(userId) {
  const id = String(userId);
  if (mockContacts.some((contact) => String(contact.userId) === id)) {
    return { relationshipStatus: 'friends', friendRequestId: null };
  }
  const request = mockFriendRequests.find((item) =>
    (String(item.senderId) === String(mockCurrentUser.id) && String(item.recipientId) === id)
    || (String(item.senderId) === id && String(item.recipientId) === String(mockCurrentUser.id))
  );
  if (!request) return { relationshipStatus: 'none', friendRequestId: null };
  return {
    relationshipStatus: String(request.senderId) === String(mockCurrentUser.id)
      ? 'request_sent'
      : 'request_received',
    friendRequestId: request.id,
  };
}

/** List accepted friends. */
export async function getFriends() {
  if (USE_MOCK_API) {
    return mockContacts
      .map((contact) => getMockUser(contact.userId))
      .filter(Boolean)
      .map((user) => ({ ...user, displayName: user.displayName || user.username }));
  }
  return get('/api/v1/users/friends');
}

/** List incoming and outgoing pending requests. */
export async function getFriendRequests() {
  if (USE_MOCK_API) {
    const incoming = mockFriendRequests
      .filter((request) => String(request.recipientId) === String(mockCurrentUser.id))
      .map((request) => ({ ...getMockUser(request.senderId), id: request.id, userId: request.senderId, createdAt: request.createdAt }))
      .filter((user) => user.userId);
    const outgoing = mockFriendRequests
      .filter((request) => String(request.senderId) === String(mockCurrentUser.id))
      .map((request) => ({ ...getMockUser(request.recipientId), id: request.id, userId: request.recipientId, createdAt: request.createdAt }))
      .filter((user) => user.userId);
    return { incoming, outgoing };
  }
  return get('/api/v1/users/friend-requests');
}

/** Send a friend request (idempotent on the server). */
export async function sendFriendRequest(userId) {
  if (USE_MOCK_API) {
    const currentState = getMockRelationshipState(userId);
    if (currentState.relationshipStatus === 'friends') throw new Error('You are already friends with this user.');
    if (currentState.relationshipStatus === 'request_sent') return { id: currentState.friendRequestId, status: 'pending' };
    if (currentState.relationshipStatus === 'request_received') throw new Error('This user has already sent you a request.');
    const request = {
      id: `friend-request-${uuid()}`,
      senderId: mockCurrentUser.id,
      recipientId: userId,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    mockFriendRequests.push(request);
    return { id: request.id, status: 'pending' };
  }
  return post('/api/v1/users/friend-requests', { userId });
}

/** Accept an incoming request. */
export async function acceptFriendRequest(requestId) {
  if (USE_MOCK_API) {
    const index = mockFriendRequests.findIndex((request) => request.id === requestId);
    if (index < 0) throw new Error('Friend request not found.');
    const request = mockFriendRequests[index];
    if (String(request.recipientId) !== String(mockCurrentUser.id)) throw new Error('Only the recipient can accept this request.');
    if (!mockContacts.some((contact) => String(contact.userId) === String(request.senderId))) {
      mockContacts.push({ userId: request.senderId, addedAt: new Date().toISOString() });
    }
    mockFriendRequests.splice(index, 1);
    return { success: true, status: 'accepted', friendId: request.senderId };
  }
  return post(`/api/v1/users/friend-requests/${encodeURIComponent(requestId)}/accept`);
}

/** Reject an incoming request. */
export async function rejectFriendRequest(requestId) {
  if (USE_MOCK_API) {
    const index = mockFriendRequests.findIndex((request) => request.id === requestId);
    if (index < 0) throw new Error('Friend request not found.');
    const request = mockFriendRequests[index];
    if (String(request.recipientId) !== String(mockCurrentUser.id)) throw new Error('Only the recipient can reject this request.');
    mockFriendRequests.splice(index, 1);
    return { success: true, status: 'rejected' };
  }
  return post(`/api/v1/users/friend-requests/${encodeURIComponent(requestId)}/reject`);
}

/** Cancel an outgoing pending request. */
export async function cancelFriendRequest(requestId) {
  if (USE_MOCK_API) {
    const index = mockFriendRequests.findIndex((request) => request.id === requestId);
    if (index < 0) return { success: true, status: 'cancelled' };
    const request = mockFriendRequests[index];
    if (String(request.senderId) !== String(mockCurrentUser.id)) throw new Error('Only the sender can cancel this request.');
    mockFriendRequests.splice(index, 1);
    return { success: true, status: 'cancelled' };
  }
  return deleteRequest(`/api/v1/users/friend-requests/${encodeURIComponent(requestId)}`);
}

/** Remove a friend without deleting past messages. */
export async function removeFriend(userId) {
  if (USE_MOCK_API) {
    const index = mockContacts.findIndex((contact) => String(contact.userId) === String(userId));
    if (index >= 0) mockContacts.splice(index, 1);
    return { success: true, removed: index >= 0 };
  }
  return deleteRequest(`/api/v1/users/friends/${encodeURIComponent(userId)}`);
}

export default {
  getFriends,
  getFriendRequests,
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  cancelFriendRequest,
  removeFriend,
  getMockRelationshipState,
};
