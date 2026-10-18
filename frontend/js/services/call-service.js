/**
 * APERTURE - Call Service
 * Includes getIceServers() so TURN credentials can later be fetched from the backend.
 */
import { USE_MOCK_API, ICE_SERVERS } from '../config.js';
import { get, post } from './api-client.js';
import { mockCalls } from '../mock/mock-data.js';
import { uuid } from '../utils.js';

// Metered TURN configuration.
const METERED_CREDENTIALS_URL =
  'https://aperture-calls.metered.live/api/v1/turn/credentials';

const METERED_API_KEY = import.meta.env.VITE_METERED_API_KEY || '';

let cachedMeteredIceServers = null;

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
export async function createCall(userId, callType = 'audio') {
  if (USE_MOCK_API) {
    const call = {
      id: `call-${uuid().slice(0, 8)}`,
      callerId: '00000000-0000-0000-0000-000000000001',
      calleeId: userId,
      callType,
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
  return post('/api/calls', { userId, callType });
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
 * Uses Metered TURN when available and preserves Google STUN as fallback.
 */
export async function getIceServers() {

  if (USE_MOCK_API) {
    return [...ICE_SERVERS];
  }

  // Reuse a previously successful Metered response.
  if (cachedMeteredIceServers) {
    return [...ICE_SERVERS, ...cachedMeteredIceServers];
  }

  // Allow the app to continue using STUN if no key is configured.
  if (!METERED_API_KEY) {
    console.warn(
      '[webrtc] Metered API key is missing. Using STUN fallback.',
    );
    return [...ICE_SERVERS];
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const url = new URL(METERED_CREDENTIALS_URL);
    url.searchParams.set('apiKey', METERED_API_KEY);

    const response = await fetch(url.toString(), {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Metered returned HTTP ${response.status}`);
    }

    const meteredServers = await response.json();

    // Do not accept an invalid response or a response without TURN servers
    const hasTurnServer = Array.isArray(meteredServers)
      && meteredServers.some((server) => {
        const urls = Array.isArray(server.urls)
          ? server.urls
          : [server.urls];

        return urls.some(
          (serverUrl) =>
            typeof serverUrl === 'string'
            && /^(turn|turns):/i.test(serverUrl),
        );
      });

    if (!hasTurnServer) {
      throw new Error('Metered response contains no TURN servers');
    }

    // Cache only a successfully validated response.
    cachedMeteredIceServers = meteredServers;

    console.info('[webrtc] Metered TURN configuration loaded.');

    // Keep the existing Google STUN configuration.
    return [...ICE_SERVERS, ...meteredServers];
  } catch {

    console.warn(
      '[webrtc] Metered TURN unavailable. Falling back to STUN.',
    );

    return [...ICE_SERVERS];
  } finally {
    clearTimeout(timeoutId);
  }
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
