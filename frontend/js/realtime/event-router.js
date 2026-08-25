/**
 * APERTURE - WebSocket Event Router
 * Routes incoming WebSocket events to the correct page/service.
 * Keeps UI logic out of websocket-client.js.
 */

const handlers = new Map();

/** Register a handler for a specific event type. Returns an unsubscribe function. */
export function on(eventType, handler) {
  if (!handlers.has(eventType)) handlers.set(eventType, new Set());
  handlers.get(eventType).add(handler);
  return () => handlers.get(eventType)?.delete(handler);
}

/** Route an incoming event to all registered handlers for its type. */
export function route(eventType, payload) {
  const typeHandlers = handlers.get(eventType);
  if (typeHandlers) {
    typeHandlers.forEach((h) => {
      try { h(payload); } catch (e) { console.error(`[event-router] Handler error for "${eventType}":`, e); }
    });
  }
  // Also dispatch a global DOM event so pages can listen declaratively.
  window.dispatchEvent(new CustomEvent(`aperture:ws:${eventType}`, { detail: payload }));
}

export const EventTypes = {
  // Server -> Client
  MESSAGE_NEW: 'message.new',
  MESSAGE_DELIVERED: 'message.delivered',
  MESSAGE_READ: 'message.read',
  TYPING_START: 'typing.start',
  TYPING_STOP: 'typing.stop',
  PRESENCE_ONLINE: 'presence.online',
  PRESENCE_OFFLINE: 'presence.offline',
  CALL_INCOMING: 'call.incoming',
  CALL_ACCEPTED: 'call.accepted',
  CALL_REJECTED: 'call.rejected',
  CALL_ENDED: 'call.ended',
  ASSIST_TRANSCRIPT: 'assist.transcript',
  ASSIST_INTERPRETATION: 'assist.interpretation',
  ASSIST_CONFIRMATION: 'assist.confirmation',
  ASSIST_RESULT: 'assist.result',
  ASSIST_ERROR: 'assist.error',
  // Client -> Server
  MESSAGE_SEND: 'message.send',
  MESSAGE_READ_ACK: 'message.read',
  TYPING_START_SEND: 'typing.start',
  TYPING_STOP_SEND: 'typing.stop',
  PRESENCE_ONLINE_SEND: 'presence.online',
  PRESENCE_OFFLINE_SEND: 'presence.offline',
  CALL_OFFER: 'call.offer',
  CALL_ANSWER: 'call.answer',
  CALL_ICE: 'call.ice',
  CALL_ACCEPT_SEND: 'call.accept',
  CALL_REJECT_SEND: 'call.reject',
  CALL_END_SEND: 'call.end',
  ASSIST_COMMAND: 'assist.command',
};

export const eventRouter = { on, route, EventTypes };
export default eventRouter;
