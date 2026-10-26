/**
 * APERTURE - Assist Confirmation Controller
 * Manages the confirmation flow for high-risk actions.
 * Works with both physical buttons and voice-state hooks.
 */
import { assistState, AssistState } from './assist-state.js';
import { assistService } from '../services/assist-service.js';
import { audioController } from './audio-controller.js';

let currentCommand = null;
let onResolvedCb = null;
let actionInFlight = false;

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
    const result = await assistService.confirmAssistAction(command.commandId);
    if (currentCommand !== command) return null;
    if (!result || result.state !== 'SUCCESS') {
      throw new Error(result?.spokenResponse || 'The action was not confirmed as successful.');
    }
    assistState.transition(AssistState.SUCCESS);
    if (result.spokenResponse) audioController.speak(result.spokenResponse);
    if (result.callId) {
      window.dispatchEvent(new CustomEvent('aperture:assist-call-created', { detail: result }));
    }
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
  try {
    await assistService.cancelAssistAction(command.commandId);
    if (currentCommand !== command) return null;
    assistState.forceState(AssistState.CANCELLED);
    audioController.stopSpeaking();
    audioController.speak('Okay, cancelling your request. No action was taken.');
    const callback = onResolvedCb;
    currentCommand = null;
    onResolvedCb = null;
    if (callback) callback('cancelled');
    return true;
  } catch (e) {
    assistState.transition(AssistState.ERROR);
    if (onResolvedCb) onResolvedCb('error', e);
    return null;
  } finally {
    actionInFlight = false;
  }
}

export const confirmationController = { setPendingCommand, getPendingCommand, confirm, retry, cancel };
export default confirmationController;
