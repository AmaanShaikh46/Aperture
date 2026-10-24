/**
 * APERTURE - Assist Confirmation Controller
 * Manages the confirmation flow for high-risk actions.
 * Works with both physical buttons and voice-state hooks.
 */
import { assistState, AssistState } from './assist-state.js';
import { assistService } from '../services/assist-service.js';
import { audioController } from './audio-controller.js';
import { attachExistingOutgoingCall } from '../webrtc/call-controller.js';

let currentCommand = null;
let onResolvedCb = null;
let actionInFlight = false;

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Set the current command pending confirmation. */
export function setPendingCommand(command, onResolved) {
  if (actionInFlight) return false;
  if (!command || typeof command.commandId !== 'string' || !command.commandId.trim()) {
    return false;
  }
  currentCommand = command;
  onResolvedCb = onResolved || null;
  return true;
}

/** Get the current pending command. */
export function getPendingCommand() {
  return currentCommand;
}

/** Confirm and execute the pending action. */
export async function confirm() {
  if (!currentCommand || actionInFlight) return null;
  const command = currentCommand;
  actionInFlight = true;
  try {
    if (!assistState.transition(AssistState.EXECUTING)) assistState.forceState(AssistState.EXECUTING);
    const result = await withTimeout(
      assistService.confirmAssistAction(command.commandId),
      20000,
      'This action is taking too long. Check the call/chat status before retrying.'
    );
    if (currentCommand !== command) return null;
    if (!result || result.state !== 'SUCCESS') {
      throw new Error(result?.spokenResponse || 'The action was not confirmed as successful.');
    }
    // Voice Assist's API creates the CallSession and rings the recipient, but
    // the caller still needs to attach the normal WebRTC UI to that same call.
    // Never call startOutgoingCall here: that would create a duplicate call.
    if (result.intent === 'CALL_CONTACT' && result.callId) {
      const recipient = command.recipient || {};
      attachExistingOutgoingCall({
        id: result.callId,
        displayName: recipient.displayName || command.recipientName || 'Your friend',
        callType: 'audio',
        status: result.status || 'ringing',
      });
    }
    assistState.transition(AssistState.SUCCESS);
    if (result.spokenResponse) audioController.speak(result.spokenResponse);
    const callback = onResolvedCb;
    currentCommand = null;
    onResolvedCb = null;
    if (callback) callback('confirmed', result);
    return result;
  } catch (e) {
    assistState.transition(AssistState.ERROR);
    if (onResolvedCb) onResolvedCb('error', e);
    return null;
  } finally {
    actionInFlight = false;
  }
}

/** Retry interpretation without executing the pending action. */
export async function retry() {
  if (!currentCommand || actionInFlight) return null;
  const command = currentCommand;
  actionInFlight = true;
  try {
    const result = await assistService.retryAssistAction(command.commandId);
    if (!result || result.state !== 'CONFIRMING') {
      throw new Error(result?.spokenResponse || 'Could not retry the request.');
    }
    if (currentCommand !== command) return null;
    assistState.transition(AssistState.RETRY);
    const callback = onResolvedCb;
    currentCommand = null;
    onResolvedCb = null;
    if (callback) callback('retry', result);
    return result;
  } catch (e) {
    assistState.transition(AssistState.ERROR);
    if (onResolvedCb) onResolvedCb('error', e);
    return null;
  } finally {
    actionInFlight = false;
  }
}

/** Cancel the pending action. */
export async function cancel() {
  if (!currentCommand || actionInFlight) return null;
  const command = currentCommand;
  actionInFlight = true;

  // Clear the local pending action immediately so the screen never depends on
  // a network response to dismiss the confirmation.
  currentCommand = null;
  const callback = onResolvedCb;
  onResolvedCb = null;
  audioController.stopSpeaking();
  assistState.forceState(AssistState.CANCELLED);
  if (callback) callback('cancelled');

  try {
    await withTimeout(
      assistService.cancelAssistAction(command.commandId),
      5000,
      'Cancellation is taking longer than expected.'
    );
  } catch (e) {
    // Local cancellation is still complete. The server-side command expires
    // automatically; log the failure rather than restoring stale UI.
    console.warn('[assist] Could not confirm server-side cancellation:', e);
  } finally {
    actionInFlight = false;
    if (assistState.getState() === AssistState.CANCELLED) {
      assistState.forceState(AssistState.IDLE);
    }
  }
  return true;
}

export const confirmationController = { setPendingCommand, getPendingCommand, confirm, retry, cancel };
export default confirmationController;
