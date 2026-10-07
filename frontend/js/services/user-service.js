/**
 * APERTURE - User Service
 * Wraps user/profile API calls. Uses mock data when USE_MOCK_API is true.
 */
import { USE_MOCK_API } from '../config.js';
import { get, patch } from './api-client.js';
import { mockCurrentUser, mockUsers } from '../mock/mock-data.js';

/** Get the current authenticated user's profile. */
export async function getCurrentUser() {
  if (USE_MOCK_API) return { ...mockCurrentUser };
  return get('/api/me');
}

/** Update the current user's profile. */
export async function updateProfile(data) {
  if (USE_MOCK_API) {
    Object.assign(mockCurrentUser, data);
    return { ...mockCurrentUser };
  }
  return patch('/api/me/profile', data);
}

/** Search for users by query string. */
export async function searchUsers(query) {
  if (USE_MOCK_API) {
    const q = (query || '').toLowerCase();
    return mockUsers.filter(
      (u) =>
        u.displayName.toLowerCase().includes(q) ||
        u.username.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q),
    );
  }
  return get('/api/v1/users/search', { query: { q: query } });
}

export default { getCurrentUser, updateProfile, searchUsers };
