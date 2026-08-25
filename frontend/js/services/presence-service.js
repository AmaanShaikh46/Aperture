/**
 * APERTURE - Presence Service
 */
import { USE_MOCK_API } from '../config.js';
import { get } from './api-client.js';
import { mockUsers } from '../mock/mock-data.js';

/** Get presence info for a user. */
export async function getPresence(userId) {
  if (USE_MOCK_API) {
    const user = mockUsers.find((u) => u.id === userId);
    if (!user) return { userId, presence: 'offline', lastSeen: null };
    return { userId, presence: user.presence, lastSeen: user.lastSeen };
  }
  return get(`/api/presence/${userId}`);
}

export default { getPresence };
