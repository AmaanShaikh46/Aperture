/**
 * APERTURE - Assist Page Module
 * Accessibility-first voice interface. Hold-to-speak and continuous listening modes.
 * Displays what the user said and what Aperture understood, with confirmation flow.
 */
import { assistController } from '../assist/assist-controller.js';
import { assistState, AssistState, onStateChange } from '../assist/assist-state.js';
import { audioController } from '../assist/audio-controller.js';
import { confirmationController } from '../assist/confirmation-controller.js';
import { escapeHtml } from '../utils.js';

let containerEl = null;
let holdActive = false;
let stateUnsub = null;

/** Initialize the Assist page. */
export function initAssistPage(container) {
  containerEl = container;
  renderShell();
  setupControls();
  setupStateListener();
  updateStateDisplay(AssistState.IDLE);
}

/** Render the page shell. */
function renderShell() {
  containerEl.innerHTML = `
    <div class="assist-page">
      <div class="assist-header">
        <h2 class="h5 mb-1">Aperture Assist</h2>
        <p class="text-muted small mb-0">Voice-controlled assistant</p>
      </div>

      <div class="assist-mode-toggle">
        <div class="btn-group w-100" role="group" aria-label="Input mode">
          <button type="button" class="btn btn-outline-primary active" id="mode-hold" data-mode="hold">Hold to Speak</button>
          <button type="button" class="btn btn-outline-primary" id="mode-continuous" data-mode="continuous">Continuous</button>
        </div>
      </div>

      <div class="assist-state-display" id="assist-state-display" aria-live="polite" aria-atomic="true">
        <div class="assist-state-icon" id="assist-state-icon"><i class="bi bi-mic"></i></div>
        <div class="assist-state-label" id="assist-state-label">IDLE</div>
        <div class="assist-state-desc" id="assist-state-desc">Press and hold the button to speak</div>
      </div>

      <div class="assist-mic-control" id="assist-mic-control">
        <button class="assist-mic-btn" id="assist-mic-btn" aria-label="Hold to speak" aria-pressed="false">
          <i class="bi bi-mic-fill" id="assist-mic-icon"></i>
        </button>
      </div>

      <div class="assist-transcript" id="assist-transcript" style="display:none;">
        <div class="transcript-section">
          <div class="transcript-label">YOU SAID:</div>
          <div class="transcript-content" id="transcript-said"></div>
        </div>
        <div class="transcript-section">
          <div class="transcript-label">APERTURE UNDERSTOOD:</div>
          <div class="interpretation-content" id="interpretation-content"></div>
        </div>
      </div>

      <div class="assist-confirmation" id="assist-confirmation" style="display:none;">
        <div class="confirmation-message" id="confirmation-message"></div>
        <div class="confirmation-buttons" id="confirmation-buttons"></div>
      </div>

      <div class="assist-error" id="assist-error" style="display:none;">
        <div class="error-message" id="assist-error-message"></div>
        <div class="error-buttons" id="assist-error-buttons"></div>
      </div>

      <div class="assist-commands-help">
        <details>
          <summary class="text-muted small">Supported Commands</summary>
          <ul class="small text-muted mt-2 mb-0">
            <li>SEND MESSAGE — "chat message [name] [message]"</li>
            <li>CALL CONTACT — "call [name]"</li>
            <li>OPEN CHAT — "open chat [name]"</li>
            <li>READ MESSAGES — "read messages"</li>
            <li>SEARCH CONVERSATION — "search [query]"</li>
            <li>GO BACK — "go back"</li>
          </ul>
        </details>
      </div>
    </div>`;
}

/** Setup the mic control and mode toggle. */
function setupControls() {
  const micBtn = document.getElementById('assist-mic-btn');
  const micIcon = document.getElementById('assist-mic-icon');
  const modeHoldBtn = document.getElementById('mode-hold');
  const modeContBtn = document.getElementById('mode-continuous');

  // Mode toggle
  modeHoldBtn.addEventListener('click', () => {
    assistController.setMode('hold');
    modeHoldBtn.classList.add('active');
    modeContBtn.classList.remove('active');
    document.getElementById('assist-state-desc').textContent = 'Press and hold the button to speak';
    micBtn.setAttribute('aria-label', 'Hold to speak');
  });
  modeContBtn.addEventListener('click', () => {
    assistController.setMode('continuous');
    modeContBtn.classList.add('active');
    modeHoldBtn.classList.remove('active');
    document.getElementById('assist-state-desc').textContent = 'Tap the button to start/stop listening';
    micBtn.setAttribute('aria-label', 'Tap to start or stop listening');
  });

  // Hold-to-speak mode
  micBtn.addEventListener('pointerdown', (e) => {
    if (assistController.getMode() !== 'hold') return;
    e.preventDefault();
    holdActive = true;
    micBtn.classList.add('listening');
    micBtn.setAttribute('aria-pressed', 'true');
    micIcon.className = 'bi bi-mic-fill';
    assistController.startListening();
  });

  micBtn.addEventListener('pointerup', (e) => {
    if (assistController.getMode() !== 'hold' || !holdActive) return;
    e.preventDefault();
    holdActive = false;
    micBtn.classList.remove('listening');
    micBtn.setAttribute('aria-pressed', 'false');
    assistController.stopListening();
  });

  micBtn.addEventListener('pointerleave', () => {
    if (assistController.getMode() !== 'hold' || !holdActive) return;
    holdActive = false;
    micBtn.classList.remove('listening');
    micBtn.setAttribute('aria-pressed', 'false');
    assistController.stopListening();
  });

  // Continuous mode — tap to toggle
  micBtn.addEventListener('click', () => {
    if (assistController.getMode() !== 'continuous') return;
    if (audioController.getIsListening()) {
      micBtn.classList.remove('listening');
      micBtn.setAttribute('aria-pressed', 'false');
      assistController.stopListening();
    } else {
      micBtn.classList.add('listening');
      micBtn.setAttribute('aria-pressed', 'true');
      assistController.startListening();
    }
  });

  // Keyboard accessibility
  micBtn.addEventListener('keydown', (e) => {
    if (assistController.getMode() === 'hold') {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!holdActive) {
          holdActive = true;
          micBtn.classList.add('listening');
          micBtn.setAttribute('aria-pressed', 'true');
          assistController.startListening();
        }
      }
    }
  });

  micBtn.addEventListener('keyup', (e) => {
    if (assistController.getMode() === 'hold') {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (holdActive) {
          holdActive = false;
          micBtn.classList.remove('listening');
          micBtn.setAttribute('aria-pressed', 'false');
          assistController.stopListening();
        }
      }
    }
  });

  // Initialize assist controller
  assistController.initAssist({
    onStateChange: (newState) => updateStateDisplay(newState),
    onInterpretation: ({ transcript, isFinal }) => {
      if (transcript) {
        document.getElementById('assist-transcript').style.display = 'block';
        document.getElementById('transcript-said').textContent = `"${transcript}"`;
      }
    },
    onError: (message) => {
      showError(message);
    },
  });
}

/** Setup state change listener. */
function setupStateListener() {
  stateUnsub = onStateChange((newState) => {
    updateStateDisplay(newState);
    if (newState === AssistState.CONFIRMING) {
      renderConfirmation();
    }
  });
}

/** Update the state display. */
function updateStateDisplay(state) {
  const iconEl = document.getElementById('assist-state-icon');
  const labelEl = document.getElementById('assist-state-label');
  const descEl = document.getElementById('assist-state-desc');
  const micIcon = document.getElementById('assist-mic-icon');

  const stateInfo = {
    [AssistState.IDLE]: { icon: 'bi-mic', label: 'IDLE', desc: assistController.getMode() === 'hold' ? 'Press and hold the button to speak' : 'Tap the button to start listening', micClass: 'bi-mic-fill' },
    [AssistState.LISTENING]: { icon: 'bi-mic-fill', label: 'LISTENING', desc: 'Speak now...', micClass: 'bi-mic-fill' },
    [AssistState.PROCESSING]: { icon: 'bi-hourglass-split', label: 'PROCESSING', desc: 'Processing your speech...', micClass: 'bi-hourglass-split' },
    [AssistState.UNDERSTANDING]: { icon: 'bi-cpu', label: 'UNDERSTANDING', desc: 'Understanding your request...', micClass: 'bi-cpu' },
    [AssistState.CHECKING_CONTACT]: { icon: 'bi-person-search', label: 'CHECKING CONTACT', desc: 'Finding the contact...', micClass: 'bi-person-search' },
    [AssistState.CONFIRMING]: { icon: 'bi-question-circle', label: 'CONFIRMING', desc: 'Please confirm this action', micClass: 'bi-question-circle' },
    [AssistState.EXECUTING]: { icon: 'bi-play-circle', label: 'EXECUTING', desc: 'Executing your request...', micClass: 'bi-play-circle' },
    [AssistState.SUCCESS]: { icon: 'bi-check-circle', label: 'SUCCESS', desc: 'Done!', micClass: 'bi-check-circle' },
    [AssistState.RETRY]: { icon: 'bi-arrow-repeat', label: 'RETRY', desc: 'Please try again', micClass: 'bi-arrow-repeat' },
    [AssistState.CANCELLED]: { icon: 'bi-x-circle', label: 'CANCELLED', desc: 'Action cancelled', micClass: 'bi-x-circle' },
    [AssistState.ERROR]: { icon: 'bi-exclamation-triangle', label: 'ERROR', desc: 'Something went wrong', micClass: 'bi-exclamation-triangle' },
  };

  const info = stateInfo[state] || stateInfo[AssistState.IDLE];
  iconEl.innerHTML = `<i class="bi ${info.icon}"></i>`;
  labelEl.textContent = info.label;
  if (state !== AssistState.CONFIRMING) descEl.textContent = info.desc;
  micIcon.className = `bi ${info.micClass}`;

  // Update state display class
  const displayEl = document.getElementById('assist-state-display');
  displayEl.className = `assist-state-display state-${state.toLowerCase()}`;

  // Reset transcript on idle
  if (state === AssistState.IDLE) {
    setTimeout(() => {
      const transcriptEl = document.getElementById('assist-transcript');
      const confirmEl = document.getElementById('assist-confirmation');
      const errorEl = document.getElementById('assist-error');
      if (transcriptEl) transcriptEl.style.display = 'none';
      if (confirmEl) confirmEl.style.display = 'none';
      if (errorEl) errorEl.style.display = 'none';
    }, 500);
  }
}

/** Render the confirmation UI. */
function renderConfirmation() {
  const command = confirmationController.getPendingCommand();
  if (!command) return;

  const transcriptEl = document.getElementById('assist-transcript');
  const confirmEl = document.getElementById('assist-confirmation');
  const msgEl = document.getElementById('confirmation-message');
  const btnsEl = document.getElementById('confirmation-buttons');

  transcriptEl.style.display = 'block';
  confirmEl.style.display = 'block';

  // Render interpretation
  const interpEl = document.getElementById('interpretation-content');
  interpEl.innerHTML = `
    <div class="interpretation-row"><span class="interp-label">Action:</span> ${escapeHtml(command.intent || '')}</div>
    ${command.recipient ? `<div class="interpretation-row"><span class="interp-label">Recipient:</span> ${escapeHtml(command.recipient.displayName || '')}</div>` : ''}
    ${command.message ? `<div class="interpretation-row"><span class="interp-label">Message:</span> "${escapeHtml(command.message)}"</div>` : ''}
    <div class="interpretation-row"><span class="interp-label">Confidence:</span> ${Math.round((command.confidence || 0) * 100)}%</div>
    <div class="interpretation-row"><span class="interp-label">Risk:</span> <span class="risk-badge risk-${(command.risk || '').toLowerCase()}">${escapeHtml(command.risk || '')}</span></div>`;

  // Render confirmation message
  const spoken = command.spokenResponse || '';
  msgEl.innerHTML = `<div class="spoken-response">${escapeHtml(spoken)}</div><div class="say-confirm text-muted small mt-1">Say "Confirm" or tap the button</div>`;

  // Render buttons
  const isCall = command.intent === 'CALL_CONTACT';
  btnsEl.innerHTML = `
    <button class="btn btn-success assist-confirm-btn" aria-label="Confirm action">${isCall ? 'CALL' : 'CONFIRM'}</button>
    <button class="btn btn-outline-secondary assist-retry-btn" aria-label="Retry">RETRY</button>
    <button class="btn btn-outline-danger assist-cancel-btn" aria-label="Cancel">CANCEL</button>`;

  btnsEl.querySelector('.assist-confirm-btn').addEventListener('click', () => assistController.confirm());
  btnsEl.querySelector('.assist-retry-btn').addEventListener('click', () => assistController.retry());
  btnsEl.querySelector('.assist-cancel-btn').addEventListener('click', () => assistController.cancel());
}

/** Show an error with retry/cancel buttons. */
function showError(message) {
  const errorEl = document.getElementById('assist-error');
  const msgEl = document.getElementById('assist-error-message');
  const btnsEl = document.getElementById('assist-error-buttons');
  errorEl.style.display = 'block';
  msgEl.textContent = message || 'I didn\'t understand that.';
  btnsEl.innerHTML = `
    <button class="btn btn-outline-secondary assist-error-retry-btn">RETRY</button>
    <button class="btn btn-outline-danger assist-error-cancel-btn">CANCEL</button>`;
  btnsEl.querySelector('.assist-error-retry-btn').addEventListener('click', () => {
    errorEl.style.display = 'none';
    assistState.transition(AssistState.RETRY);
    assistState.transition(AssistState.LISTENING);
    assistController.startListening();
  });
  btnsEl.querySelector('.assist-error-cancel-btn').addEventListener('click', () => {
    errorEl.style.display = 'none';
    assistState.reset();
  });
}

/** Clean up. */
export function destroyAssistPage() {
  if (stateUnsub) stateUnsub();
  assistController.cleanup();
}

export default { initAssistPage, destroyAssistPage };
