/**
 * APERTURE - Assist Controller
 * Orchestrates the Assist flow: listen → submit → interpret → confirm → execute.
 * Coordinates audio-controller, assist-state, confirmation-controller, and assist-service.
 */
import { assistState, AssistState } from './assist-state.js';
import { audioController } from './audio-controller.js';
import { confirmationController } from './confirmation-controller.js';
import { assistService } from '../services/assist-service.js';

let mode = 'hold'; // 'hold' or 'continuous'
let onStateChangeCb = null;
let onInterpretationCb = null;
let onErrorCb = null;

/** Initialize the controller with callbacks. */
export function initAssist({ onStateChange, onInterpretation, onError } = {}) {
  onStateChangeCb = onStateChange || null;
  onInterpretationCb = onInterpretation || null;
  onErrorCb = onError || null;

  assistState.onStateChange((newState) => {
    if (onStateChangeCb) onStateChangeCb(newState);
  });

  return {
    startListening,
    stopListening,
    submitTranscript,
    setMode,
    getMode,
    confirm,
    retry,
    cancel,
    cleanup,
  };
}

/** Set the input mode: 'hold' or 'continuous'. */
export function setMode(m) {
  mode = m;
}

/** Get the current input mode. */
export function getMode() {
  return mode;
}

/** Start listening for voice input. */
export function startListening() {
  if (!audioController.isSpeechRecognitionAvailable()) {
    assistState.transition(AssistState.ERROR);
    if (onErrorCb) onErrorCb('Speech recognition is not available in this browser.');
    return false;
  }
  assistState.transition(AssistState.LISTENING);
  audioController.startListening(
    (transcript, isFinal) => {
      if (onInterpretationCb) onInterpretationCb({ transcript, isFinal });
      if (isFinal) {
        submitTranscript(transcript);
      }
    },
    (error) => {
      assistState.transition(AssistState.ERROR);
      if (onErrorCb) onErrorCb(`Speech recognition error: ${error}`);
    },
    mode === 'continuous',
  );
  return true;
}

/** Stop listening. */
export function stopListening() {
  audioController.stopListening();
  if (assistState.getState() === AssistState.LISTENING) {
    assistState.transition(AssistState.PROCESSING);
  }
}

/** Submit a transcript (from voice or typed input) for interpretation. */
export async function submitTranscript(transcript) {
  if (!transcript || !transcript.trim()) {
    assistState.transition(AssistState.ERROR);
    if (onErrorCb) onErrorCb('No speech detected.');
    return null;
  }
  assistState.transition(AssistState.PROCESSING);
  try {
    const command = await assistService.submitAssistCommand(transcript);
    assistState.transition(AssistState.UNDERSTANDING);

    if (command.spokenResponse) {
      audioController.speak(command.spokenResponse);
    }

    if (command.confirmationRequired) {
      assistState.transition(AssistState.CONFIRMING);
      confirmationController.setPendingCommand(command, (action) => {
        if (action === 'confirmed') {
          setTimeout(() => assistState.transition(AssistState.IDLE), 1500);
        } else if (action === 'retry') {
          // Stay in retry state for re-listen
        } else if (action === 'cancelled') {
          setTimeout(() => assistState.transition(AssistState.IDLE), 500);
        }
      });
      return command;
    } else {
      // No confirmation needed — auto-execute.
      assistState.transition(AssistState.EXECUTING);
      const result = await assistService.confirmAssistAction(command.commandId);
      assistState.transition(AssistState.SUCCESS);
      if (result && result.spokenResponse) audioController.speak(result.spokenResponse);
      setTimeout(() => assistState.transition(AssistState.IDLE), 1500);
      return result;
    }
  } catch (e) {
    assistState.transition(AssistState.ERROR);
    if (onErrorCb) onErrorCb(e.message || 'Interpretation failed.');
    return null;
  }
}

/** Confirm the pending action. */
export function confirm() {
  return confirmationController.confirm();
}

/** Retry the pending action. */
export function retry() {
  return confirmationController.retry();
}

/** Cancel the pending action. */
export function cancel() {
  return confirmationController.cancel();
}

/** Clean up resources. */
export function cleanup() {
  audioController.stopListening();
  audioController.stopSpeaking();
  assistState.reset();
}

export const assistController = {
  initAssist,
  setMode,
  getMode,
  startListening,
  stopListening,
  submitTranscript,
  confirm,
  retry,
  cancel,
  cleanup,
};
export default assistController;
