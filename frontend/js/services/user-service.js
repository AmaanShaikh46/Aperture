/**
 * APERTURE - User Service
 * Normalizes API profile payloads for frontend consumers.
 */
import { USE_MOCK_API } from '../config.js';
import { get, patch, post } from './api-client.js';
import { mockCurrentUser, mockUsers } from '../mock/mock-data.js';
import { getMockRelationshipState } from './friend-service.js';

function normalizeProfile(payload) {
  const profile = payload?.profile ?? payload;

  if (!profile || !profile.id) {
    throw new Error('Your profile record could not be found.');
  }

  return {
    id: profile.id,
    username: profile.username ?? '',
    displayName: profile.displayName ?? profile.display_name ?? '',
    avatarUrl: profile.avatarUrl ?? profile.avatar_url ?? '',
    email: profile.email ?? '',
    about: profile.about ?? profile.bio ?? '',
    bio: profile.bio ?? profile.about ?? '',
    createdAt: profile.createdAt ?? profile.created_at ?? null,
    updatedAt: profile.updatedAt ?? profile.updated_at ?? null,
  };
}

/** Get the current authenticated user's profile. */
export async function getCurrentUser() {
  if (USE_MOCK_API) return normalizeProfile(mockCurrentUser);
  return normalizeProfile(await get('/api/v1/users/me'));
}

/** Update editable profile fields. Avatar changes use uploadProfileAvatar(). */
export async function updateProfile(data) {
  const payload = {
    displayName: data.displayName ?? data.display_name ?? undefined,
    username: data.username ?? undefined,
    bio: data.about ?? data.bio ?? undefined,
  };

  if (USE_MOCK_API) {
    if (payload.displayName !== undefined) mockCurrentUser.displayName = payload.displayName;
    if (payload.username !== undefined) mockCurrentUser.username = payload.username || null;
    if (payload.bio !== undefined) {
      mockCurrentUser.about = payload.bio ?? '';
      mockCurrentUser.bio = payload.bio ?? '';
    }
    return normalizeProfile(mockCurrentUser);
  }

  return normalizeProfile(await patch('/api/v1/users/me', payload));
}

/** Upload a validated profile image; server-side validation is authoritative. */
export async function uploadProfileAvatar(file) {
  if (!(file instanceof File)) {
    throw new Error('Choose an image file to upload.');
  }

  if (USE_MOCK_API) {
    mockCurrentUser.avatarUrl = URL.createObjectURL(file);
    return normalizeProfile(mockCurrentUser);
  }

  const formData = new FormData();
  formData.append('file', file);
  return normalizeProfile(
    await post('/api/v1/users/me/avatar', formData),
  );
}

/** Search for users by query string. */
export async function searchUsers(query) {
  if (USE_MOCK_API) {
    const q = (query || '').trim().toLowerCase();
    return mockUsers
      .filter((user) =>
        [user.displayName, user.username, user.email]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(q)),
      )
      .map((user) => ({ ...user, ...getMockRelationshipState(user.id) }));
  }

  const results = await get('/api/v1/users/search', {
    query: { q: (query || '').trim() },
  });

  return results.map((user) => ({
    id: user.id,
    username: user.username ?? '',
    displayName: user.displayName ?? user.display_name ?? user.username ?? 'Unknown',
    avatarUrl: user.avatarUrl ?? user.avatar_url ?? '',
    relationshipStatus: user.relationshipStatus ?? user.relationship_status ?? 'none',
    friendRequestId: user.friendRequestId ?? user.friend_request_id ?? null,
  }));
}

export default {
  getCurrentUser,
  updateProfile,
  uploadProfileAvatar,
  searchUsers,
};
