/**
 * APERTURE - Assist State Machine
 * Explicit state transitions for the Assist interface.
 * Never use a collection of unrelated booleans.
 */

export const AssistState = {
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  PROCESSING: 'PROCESSING',
  UNDERSTANDING: 'UNDERSTANDING',
  CHECKING_CONTACT: 'CHECKING_CONTACT',
  CONFIRMING: 'CONFIRMING',
  EXECUTING: 'EXECUTING',
  SUCCESS: 'SUCCESS',
  RETRY: 'RETRY',
  CANCELLED: 'CANCELLED',
  ERROR: 'ERROR',
};

/** Allowed transitions from each state. */
const transitions = {
  [AssistState.IDLE]: [AssistState.LISTENING, AssistState.ERROR],
  [AssistState.LISTENING]: [AssistState.PROCESSING, AssistState.IDLE, AssistState.ERROR],
  [AssistState.PROCESSING]: [AssistState.UNDERSTANDING, AssistState.CHECKING_CONTACT, AssistState.CONFIRMING, AssistState.ERROR, AssistState.IDLE],
  [AssistState.UNDERSTANDING]: [AssistState.CHECKING_CONTACT, AssistState.CONFIRMING, AssistState.ERROR, AssistState.IDLE],
  [AssistState.CHECKING_CONTACT]: [AssistState.CONFIRMING, AssistState.RETRY, AssistState.ERROR, AssistState.IDLE],
  [AssistState.CONFIRMING]: [AssistState.EXECUTING, AssistState.RETRY, AssistState.CANCELLED, AssistState.ERROR],
  [AssistState.EXECUTING]: [AssistState.SUCCESS, AssistState.ERROR],
  [AssistState.SUCCESS]: [AssistState.IDLE],
  [AssistState.RETRY]: [AssistState.LISTENING, AssistState.IDLE],
  [AssistState.CANCELLED]: [AssistState.IDLE],
  [AssistState.ERROR]: [AssistState.IDLE, AssistState.RETRY],
};

let currentState = AssistState.IDLE;
const listeners = new Set();

/** Check if a transition is allowed. */
export function canTransition(to) {
  const allowed = transitions[currentState] || [];
  return allowed.includes(to);
}

/** Transition to a new state. Throws if the transition is invalid. */
export function transition(to) {
  if (!canTransition(to)) {
    console.warn(`[assist-state] Invalid transition: ${currentState} -> ${to}`);
    return false;
  }
  const from = currentState;
  currentState = to;
  console.log(`[assist-state] ${from} -> ${to}`);
  listeners.forEach((fn) => fn(to, from));
  window.dispatchEvent(new CustomEvent('aperture:assist-state', { detail: { state: to, from } }));
  return true;
}

/** Force a state transition (for error recovery). */
export function forceState(to) {
  const from = currentState;
  currentState = to;
  listeners.forEach((fn) => fn(to, from));
  window.dispatchEvent(new CustomEvent('aperture:assist-state', { detail: { state: to, from } }));
}

/** Get the current state. */
export function getState() {
  return currentState;
}

/** Subscribe to state changes. Returns unsubscribe function. */
export function onStateChange(callback) {
  listeners.add(callback);
  callback(currentState, currentState);
  return () => listeners.delete(callback);
}

/** Reset to IDLE. */
export function reset() {
  forceState(AssistState.IDLE);
}

export const assistState = {
  AssistState,
  canTransition,
  transition,
  forceState,
  getState,
  onStateChange,
  reset,
};
export default assistState;
