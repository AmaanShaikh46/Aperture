/**
 * APERTURE - Audio Controller
 * Handles speech-to-text (STT) via Web Speech API and text-to-speech (TTS) via SpeechSynthesis.
 * Also provides browser-accessible speech feedback.
 */

let recognition = null;
let isListening = false;
let onTranscriptCb = null;
let onErrorCb = null;
let continuousMode = false;

/** Check if speech recognition is available. */
export function isSpeechRecognitionAvailable() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/** Check if text-to-speech is available. */
export function isSpeechSynthesisAvailable() {
  return !!window.speechSynthesis;
}

/** Initialize speech recognition. */
function getRecognition() {
  if (recognition) return recognition;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    if (onTranscriptCb) onTranscriptCb(transcript, event.results[event.results.length - 1].isFinal);
  };

  recognition.onerror = (event) => {
    if (onErrorCb) onErrorCb(event.error);
  };

  recognition.onend = () => {
    isListening = false;
    window.dispatchEvent(new CustomEvent('aperture:assist-listening-stopped'));
  };

  return recognition;
}

/** Start listening. Calls onTranscript with interim and final results. */
export function startListening(onTranscript, onError, continuous = false) {
  const rec = getRecognition();
  if (!rec) {
    if (onError) onError('not-available');
    return false;
  }
  onTranscriptCb = onTranscript;
  onErrorCb = onError;
  continuousMode = continuous;
  rec.continuous = continuous;
  rec.interimResults = true;
  try {
    rec.start();
    isListening = true;
    window.dispatchEvent(new CustomEvent('aperture:assist-listening-started'));
    return true;
  } catch (e) {
    console.error('[audio] startListening error:', e);
    return false;
  }
}

/** Stop listening. */
export function stopListening() {
  if (recognition && isListening) {
    try { recognition.stop(); } catch (e) { /* ignore */ }
    isListening = false;
  }
}

/** Check if currently listening. */
export function getIsListening() {
  return isListening;
}

/** Speak text using TTS. */
export function speak(text) {
  if (!isSpeechSynthesisAvailable() || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  window.speechSynthesis.speak(utterance);
}

/** Stop any ongoing speech. */
export function stopSpeaking() {
  if (isSpeechSynthesisAvailable()) {
    window.speechSynthesis.cancel();
  }
}

export const audioController = {
  isSpeechRecognitionAvailable,
  isSpeechSynthesisAvailable,
  startListening,
  stopListening,
  getIsListening,
  speak,
  stopSpeaking,
};
export default audioController;
