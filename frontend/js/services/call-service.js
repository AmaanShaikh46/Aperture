/**
 * APERTURE - Call Service
 * Includes getIceServers() so TURN credentials can later be fetched from the backend.
 */
import { USE_MOCK_API, ICE_SERVERS } from '../config.js';
import { get, post } from './api-client.js';
import { mockCalls } from '../mock/mock-data.js';
import { uuid } from '../utils.js';

/** List call history. */
export async function getCalls() {
  if (USE_MOCK_API) return mockCalls.map((c) => ({ ...c }));
  return get('/api/calls');
}

/** Get a single call by ID. */
export async function getCall(callId) {
  if (USE_MOCK_API) {
    const call = mockCalls.find((c) => c.id === callId);
    return call ? { ...call } : null;
  }
  return get(`/api/calls/${callId}`);
}

/** Initiate a new call to a user. */
export async function createCall(userId) {
  if (USE_MOCK_API) {
    const call = {
      id: `call-${uuid().slice(0, 8)}`,
      callerId: '00000000-0000-0000-0000-000000000001',
      calleeId: userId,
      displayName: 'Unknown',
      avatarUrl: '',
      direction: 'outgoing',
      status: 'ringing',
      startedAt: new Date().toISOString(),
      endedAt: null,
      duration: 0,
    };
    mockCalls.unshift(call);
    return { ...call };
  }
  return post('/api/calls', { userId });
}

/** Accept an incoming call. */
export async function acceptCall(callId) {
  if (USE_MOCK_API) {
    const call = mockCalls.find((c) => c.id === callId);
    if (call) call.status = 'active';
    return { success: true };
  }
  return post(`/api/calls/${callId}/accept`);
}

/** Reject an incoming call. */
export async function rejectCall(callId) {
  if (USE_MOCK_API) {
    const call = mockCalls.find((c) => c.id === callId);
    if (call) { call.status = 'rejected'; call.endedAt = new Date().toISOString(); }
    return { success: true };
  }
  return post(`/api/calls/${callId}/reject`);
}

/** End an active call. */
export async function endCall(callId) {
  if (USE_MOCK_API) {
    const call = mockCalls.find((c) => c.id === callId);
    if (call) {
      call.status = 'completed';
      call.endedAt = new Date().toISOString();
      if (call.startedAt) call.duration = Math.floor((Date.now() - new Date(call.startedAt).getTime()) / 1000);
    }
    return { success: true };
  }
  return post(`/api/calls/${callId}/end`);
}

/**
 * Get ICE servers for WebRTC.
 * Currently returns static STUN config. When the backend provides
 * short-lived TURN credentials, this function will fetch them from the API.
 */
export async function getIceServers() {
  if (USE_MOCK_API) return [...ICE_SERVERS];
  // Future: const creds = await get('/api/calls/ice-servers'); return creds;
  return [...ICE_SERVERS];
}

export default {
  getCalls,
  getCall,
  createCall,
  acceptCall,
  rejectCall,
  endCall,
  getIceServers,
};
