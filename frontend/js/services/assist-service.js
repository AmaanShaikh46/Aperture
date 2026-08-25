/**
 * APERTURE - Assist Service
 * Submits voice commands and manages confirm/retry/cancel lifecycle.
 */
import { USE_MOCK_API } from '../config.js';
import { post } from './api-client.js';
import { mockAssistResponse } from '../mock/mock-data.js';

/** Submit a transcript for interpretation. Returns a command object. */
export async function submitAssistCommand(transcript) {
  if (USE_MOCK_API) return mockAssistResponse(transcript);
  return post('/api/assist/command', { transcript });
}

/** Confirm a command (execute the action). */
export async function confirmAssistAction(commandId) {
  if (USE_MOCK_API) {
    return { commandId, state: 'SUCCESS', spokenResponse: 'Done.' };
  }
  return post(`/api/assist/${commandId}/confirm`);
}

/** Retry interpretation of a command. */
export async function retryAssistAction(commandId) {
  if (USE_MOCK_API) {
    return { commandId, state: 'CONFIRMING', spokenResponse: 'Please try again.' };
  }
  return post(`/api/assist/${commandId}/retry`);
}

/** Cancel a command. */
export async function cancelAssistAction(commandId) {
  if (USE_MOCK_API) {
    return { commandId, state: 'CANCELLED' };
  }
  return post(`/api/assist/${commandId}/cancel`);
}

export const assistService = {
  submitAssistCommand,
  confirmAssistAction,
  retryAssistAction,
  cancelAssistAction,
};
export default assistService;
