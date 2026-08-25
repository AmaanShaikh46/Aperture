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

/** Set the current command pending confirmation. */
export function setPendingCommand(command, onResolved) {
  currentCommand = command;
  onResolvedCb = onResolved || null;
}

/** Get the current pending command. */
export function getPendingCommand() {
  return currentCommand;
}

/** Confirm and execute the pending action. */
export async function confirm() {
  if (!currentCommand) return;
  assistState.transition(AssistState.EXECUTING);
  try {
    const result = await assistService.confirmAssistAction(currentCommand.commandId);
    assistState.transition(AssistState.SUCCESS);
    if (result.spokenResponse) audioController.speak(result.spokenResponse);
    if (onResolvedCb) onResolvedCb('confirmed', result);
    currentCommand = null;
    return result;
  } catch (e) {
    assistState.transition(AssistState.ERROR);
    if (onResolvedCb) onResolvedCb('error', e);
    return null;
  }
}

/** Retry — go back to listening. */
export async function retry() {
  if (!currentCommand) return;
  try {
    const result = await assistService.retryAssistAction(currentCommand.commandId);
    assistState.transition(AssistState.RETRY);
    if (onResolvedCb) onResolvedCb('retry', result);
    currentCommand = null;
    return result;
  } catch (e) {
    assistState.transition(AssistState.ERROR);
    return null;
  }
}

/** Cancel the pending action. */
export async function cancel() {
  if (!currentCommand) return;
  try {
    await assistService.cancelAssistAction(currentCommand.commandId);
  } catch (e) { /* ignore */ }
  assistState.transition(AssistState.CANCELLED);
  audioController.stopSpeaking();
  if (onResolvedCb) onResolvedCb('cancelled');
  currentCommand = null;
}

export const confirmationController = { setPendingCommand, getPendingCommand, confirm, retry, cancel };
export default confirmationController;
