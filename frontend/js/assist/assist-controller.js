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
let pendingClarification = null;

/** Resolve short spoken control words, including common Indian-English STT variants.
 * Use the first control word heard so duplicated trailing speech cannot override it.
 */
function getSpokenControl(transcript) {
  const text = String(transcript || '').toLowerCase().replace(/[^a-z\s']/g, ' ').replace(/\s+/g, ' ').trim();
  const matches = [...text.matchAll(/\b(confirm|conform|cancel|cancelled|canceled|yes|no|stop|never mind|nevermind|retry|try again|repeat|start over|redo)\b/g)];
  if (!matches.length) return '';
  const first = matches[0][0];
  if (first === 'confirm' || first === 'conform' || first === 'yes') return 'confirm';
  if (['cancel', 'cancelled', 'canceled', 'no', 'stop', 'never mind', 'nevermind'].includes(first)) return 'cancel';
  if (['retry', 'try again', 'repeat', 'start over', 'redo'].includes(first)) return 'retry';
  return '';
}

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
  const spokenControl = getSpokenControl(transcript);

  // Recipient clarification cards do not create a pending confirmation command.
  // Handle voice confirmation here so saying "confirm" selects the displayed
  // candidate just like clicking its button does. Never guess when several
  // candidates are available.
  if (pendingClarification) {
    const isConfirm = spokenControl === 'confirm';
    const isCancel = spokenControl === 'cancel';
    if (isConfirm) {
      const options = pendingClarification.clarificationOptions || [];
      if (options.length === 1) {
        const selected = options[0];
        pendingClarification = null;
        return submitTranscript(selected.transcript);
      }
      audioController.speak('More than one recipient is available. Please say the recipient name or choose one on screen.');
      return null;
    }
    if (isCancel) {
      pendingClarification = null;
      window.dispatchEvent(new CustomEvent('aperture:assist-clear'));
      assistState.forceState(AssistState.IDLE);
      return null;
    }
    // A different utterance supersedes the clarification and is interpreted as
    // a fresh request, matching the existing behavior for other Assist states.
    pendingClarification = null;
  }

  if (confirmationController.getPendingCommand()) {
    if (spokenControl === 'confirm') return confirm();
    if (spokenControl === 'cancel') return cancel();
    if (spokenControl === 'retry') return retry();
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
      if (Array.isArray(command.clarificationOptions) && command.clarificationOptions.length) {
        // Keep the displayed options available for spoken confirmation as well
        // as the existing on-screen candidate buttons.
        pendingClarification = command;
        // A recipient choice is a normal clarification step, not an error.
        assistState.forceState(AssistState.CLARIFYING);
        window.dispatchEvent(new CustomEvent('aperture:assist-clarification', { detail: command }));
      } else {
        assistState.transition(AssistState.ERROR);
        if (onErrorCb) onErrorCb(explanation);
      }
      return null;
    }

    if (command.spokenResponse) {
      audioController.speak(command.spokenResponse);
    }

    // Register the pending command before entering CONFIRMING. The page's state
    // listener renders the confirmation card synchronously on this transition;
    // transitioning first meant renderConfirmation() saw no pending command
    // and returned, leaving the confidence/details card invisible.
    confirmationController.setPendingCommand(command, (action, result) => {
      if (action === 'confirmed') {
        window.dispatchEvent(new CustomEvent('aperture:assist-clear'));
        setTimeout(() => assistState.forceState(AssistState.IDLE), 1200);
      } else if (action === 'cancelled' || action === 'retry') {
        window.dispatchEvent(new CustomEvent('aperture:assist-clear'));
        setTimeout(() => assistState.forceState(AssistState.IDLE), 0);
      } else if (action === 'error') {
        if (onErrorCb) onErrorCb(result?.message || 'The action could not be completed. Check its status before retrying.');
      }
    });
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
  pendingClarification = null;
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
