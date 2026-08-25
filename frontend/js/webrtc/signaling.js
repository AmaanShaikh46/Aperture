/**
 * APERTURE - WebRTC Signaling
 * Routes signaling messages (offer, answer, ICE) through the WebSocket client.
 */
import { sendSocketEvent } from '../realtime/websocket-client.js';
import { eventRouter } from '../realtime/event-router.js';
import { EventTypes } from '../realtime/event-router.js';

/** Send a call offer to the remote peer via WebSocket. */
export function sendOffer(callId, offer) {
  return sendSocketEvent(EventTypes.CALL_OFFER, { callId, offer });
}

/** Send a call answer to the remote peer via WebSocket. */
export function sendAnswer(callId, answer) {
  return sendSocketEvent(EventTypes.CALL_ANSWER, { callId, answer });
}

/** Send an ICE candidate to the remote peer via WebSocket. */
export function sendIceCandidate(candidate, callId) {
  return sendSocketEvent(EventTypes.CALL_ICE, { candidate, callId });
}

/** Send a call accept notification. */
export function sendCallAccept(callId) {
  return sendSocketEvent(EventTypes.CALL_ACCEPT_SEND, { callId });
}

/** Send a call reject notification. */
export function sendCallReject(callId) {
  return sendSocketEvent(EventTypes.CALL_REJECT_SEND, { callId });
}

/** Send a call end notification. */
export function sendCallEnd(callId) {
  return sendSocketEvent(EventTypes.CALL_END_SEND, { callId });
}

/** Listen for incoming call offers. Returns unsubscribe function. */
export function onOffer(handler) {
  return eventRouter.on(EventTypes.CALL_OFFER, handler);
}

/** Listen for incoming call answers. Returns unsubscribe function. */
export function onAnswer(handler) {
  return eventRouter.on(EventTypes.CALL_ANSWER, handler);
}

/** Listen for incoming ICE candidates. Returns unsubscribe function. */
export function onIceCandidate(handler) {
  return eventRouter.on(EventTypes.CALL_ICE, handler);
}

/** Listen for incoming calls. Returns unsubscribe function. */
export function onIncomingCall(handler) {
  return eventRouter.on(EventTypes.CALL_INCOMING, handler);
}

/** Listen for call accepted. Returns unsubscribe function. */
export function onCallAccepted(handler) {
  return eventRouter.on(EventTypes.CALL_ACCEPTED, handler);
}

/** Listen for call rejected. Returns unsubscribe function. */
export function onCallRejected(handler) {
  return eventRouter.on(EventTypes.CALL_REJECTED, handler);
}

/** Listen for call ended. Returns unsubscribe function. */
export function onCallEnded(handler) {
  return eventRouter.on(EventTypes.CALL_ENDED, handler);
}

export const signaling = {
  sendOffer,
  sendAnswer,
  sendIceCandidate,
  sendCallAccept,
  sendCallReject,
  sendCallEnd,
  onOffer,
  onAnswer,
  onIceCandidate,
  onIncomingCall,
  onCallAccepted,
  onCallRejected,
  onCallEnded,
};
export default signaling;
