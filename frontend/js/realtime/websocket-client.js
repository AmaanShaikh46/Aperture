/**
 * APERTURE - WebSocket Client
 * Manages the real-time connection with automatic reconnect, backoff,
 * connection state tracking, clean shutdown, and event dispatch.
 */
import { WS_BASE_URL, WS_RECONNECT, USE_MOCK_API } from '../config.js';
import { eventRouter } from './event-router.js';

const State = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  SHUTTING_DOWN: 'shutting_down',
};

let ws = null;
let state = State.DISCONNECTED;
let reconnectAttempts = 0;
let reconnectTimer = null;
let manuallyClosed = false;
let listeners = new Set();

/** Build the WebSocket URL, appending the access token as a query param. */
async function buildWsUrl() {
  const base = WS_BASE_URL.replace(/^http/, 'ws').replace(/\/$/, '');
  const { auth } = await import('../services/auth-service.js');
  const token = await auth.getAccessToken();
  const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${base}/ws${tokenParam}`;
}

/** Notify all listeners of a state change. */
function notifyStateChange(newState) {
  state = newState;
  listeners.forEach((fn) => fn(newState));
  window.dispatchEvent(new CustomEvent('aperture:ws-state', { detail: { state: newState } }));
}

/** Schedule a reconnect with exponential backoff. */
function scheduleReconnect() {
  if (manuallyClosed) return;
  const { INITIAL_DELAY, MAX_DELAY, BACKOFF_FACTOR } = WS_RECONNECT;
  const delay = Math.min(INITIAL_DELAY * Math.pow(BACKOFF_FACTOR, reconnectAttempts), MAX_DELAY);
  reconnectAttempts++;
  notifyStateChange(State.RECONNECTING);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connectWebSocket();
  }, delay);
}

/** Connect to the WebSocket server. */
export async function connectWebSocket() {
  if (manuallyClosed) return;
  if (state === State.CONNECTING || state === State.CONNECTED) return;

  notifyStateChange(State.CONNECTING);

  // In mock mode, simulate a connection without a real server.
  if (USE_MOCK_API) {
    setTimeout(() => notifyStateChange(State.CONNECTED), 300);
    return;
  }

  try {
    const url = await buildWsUrl();
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectAttempts = 0;
      notifyStateChange(State.CONNECTED);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data && data.type) {
          eventRouter.route(data.type, data.payload || data);
        }
      } catch (e) {
        console.error('[ws] Failed to parse message:', e);
      }
    };

    ws.onerror = (err) => {
      console.error('[ws] Error:', err);
    };

    ws.onclose = () => {
      if (manuallyClosed) {
        notifyStateChange(State.DISCONNECTED);
        return;
      }
      scheduleReconnect();
    };
  } catch (e) {
    console.error('[ws] Connection failed:', e);
    scheduleReconnect();
  }
}

/** Cleanly disconnect and stop reconnect attempts. */
export function disconnectWebSocket() {
  manuallyClosed = true;
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.onopen = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }
  notifyStateChange(State.DISCONNECTED);
  // Reset for future reconnects.
  manuallyClosed = false;
  reconnectAttempts = 0;
}

/** Send an event through the WebSocket. */
export function sendSocketEvent(type, payload = {}) {
  if (USE_MOCK_API) {
    // In mock mode, echo some events back through the router for local testing.
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('[ws] Cannot send — not connected.');
    return false;
  }
  const msg = JSON.stringify({ type, payload });
  ws.send(msg);
  return true;
}

/** Check if the WebSocket is currently connected. */
export function isWebSocketConnected() {
  return state === State.CONNECTED;
}

/** Get the current connection state. */
export function getWebSocketState() {
  return state;
}

/** Subscribe to connection state changes. Returns an unsubscribe function. */
export function onWebSocketStateChange(callback) {
  listeners.add(callback);
  callback(state);
  return () => listeners.delete(callback);
}

export const WsState = State;
export default {
  connectWebSocket,
  disconnectWebSocket,
  sendSocketEvent,
  isWebSocketConnected,
  getWebSocketState,
  onWebSocketStateChange,
  WsState,
};
