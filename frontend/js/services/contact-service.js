/**
 * APERTURE - Contact Service
 */
import { USE_MOCK_API } from '../config.js';
import { get, post, deleteRequest } from './api-client.js';
import { mockContacts, mockUsers } from '../mock/mock-data.js';

/** Get the current user's contact list (enriched with user data). */
export async function getContacts() {
  if (USE_MOCK_API) {
    return mockContacts.map((c) => {
      const user = mockUsers.find((u) => u.id === c.userId);
      return { ...user, addedAt: c.addedAt };
    });
  }
  return get('/api/contacts');
}

/** Add a user to contacts. */
export async function addContact(userId) {
  if (USE_MOCK_API) {
    if (!mockContacts.find((c) => c.userId === userId)) {
      mockContacts.push({ userId, addedAt: new Date().toISOString() });
    }
    return { success: true };
  }
  return post('/api/contacts', { userId });
}

/** Remove a user from contacts. */
export async function removeContact(userId) {
  if (USE_MOCK_API) {
    const idx = mockContacts.findIndex((c) => c.userId === userId);
    if (idx >= 0) mockContacts.splice(idx, 1);
    return { success: true };
  }
  return deleteRequest(`/api/contacts/${userId}`);
}

export default { getContacts, addContact, removeContact };
