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
    assistState.forceState(AssistState.PROCESSING);
  }
}

/** Submit a transcript (from voice or typed input) for interpretation. */
export async function submitTranscript(transcript) {
  const spokenControl = String(transcript || '').trim().toLowerCase().replace(/[.!?,]+$/g, '');
  if (confirmationController.getPendingCommand()) {
    if (/^(confirm|yes|yes confirm|confirm it|do it)$/.test(spokenControl)) return confirm();
    if (/^(cancel|no|no cancel|cancel it|never mind|nevermind)$/.test(spokenControl)) return cancel();
  }
  // If another command is pending, cancel it before interpreting a new request.
  if (confirmationController.getPendingCommand()) await confirmationController.cancel();
  // A new request supersedes stale result/error cards from the previous one.
  window.dispatchEvent(new CustomEvent('aperture:assist-clear'));
  if (!transcript || !transcript.trim()) {
    assistState.transition(AssistState.ERROR);
    if (onErrorCb) onErrorCb('No speech detected.');
    return null;
  }
  assistState.forceState(AssistState.PROCESSING);
  try {
    const command = await assistService.submitAssistCommand(transcript);
    assistState.transition(AssistState.UNDERSTANDING);

    if (command.confirmationRequired !== true || !command.commandId) {
      const explanation =
        command.spokenResponse ||
        'I could not prepare a safe action for confirmation. No action was taken.';
      audioController.speak(explanation);
      assistState.transition(AssistState.ERROR);
      if (onErrorCb) onErrorCb(explanation);
      return null;
    }

    if (command.spokenResponse) {
      audioController.speak(command.spokenResponse);
    }

    // Register the pending command before transitioning: the CONFIRMING state
    // listener renders the physical confirmation controls synchronously.
    const registered = confirmationController.setPendingCommand(command, (action) => {
      if (action === 'confirmed') {
        window.dispatchEvent(new CustomEvent('aperture:assist-clear'));
        setTimeout(() => assistState.forceState(AssistState.IDLE), 1200);
      } else if (action === 'cancelled' || action === 'retry') {
        window.dispatchEvent(new CustomEvent('aperture:assist-clear'));
        setTimeout(() => assistState.forceState(AssistState.IDLE), 0);
      }
    });
    if (!registered) {
      assistState.forceState(AssistState.ERROR);
      const message = 'Could not prepare the confirmation controls. No action was taken.';
      if (onErrorCb) onErrorCb(message);
      return null;
    }
    assistState.transition(AssistState.CONFIRMING);
    return command;
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
