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
let clearUiHandler = null;
let clarificationHandler = null;

/** Initialize the Assist page. */
export function initAssistPage(container) {
  containerEl = container;
  renderShell();
  setupControls();
  setupStateListener();
  clearUiHandler = () => clearAssistUi();
  clarificationHandler = (event) => showClarificationOptions(event.detail);
  window.addEventListener('aperture:assist-clear', clearUiHandler);
  window.addEventListener('aperture:assist-clarification', clarificationHandler);
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
            <li>CONFIRM / RETRY / CANCEL — say the command while reviewing an action</li>
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
    } else if ([AssistState.CANCELLED, AssistState.SUCCESS, AssistState.IDLE].includes(newState)) {
      clearAssistUi();
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
    [AssistState.CLARIFYING]: { icon: 'bi-person-check', label: 'CHOOSE RECIPIENT', desc: 'Please confirm who you meant', micClass: 'bi-person-check' },
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
  descEl.textContent = info.desc;
  micIcon.className = `bi ${info.micClass}`;

  // Update state display class
  const displayEl = document.getElementById('assist-state-display');
  displayEl.className = `assist-state-display state-${state.toLowerCase()}`;

  if (state === AssistState.IDLE) clearAssistUi();
}

/** Clear all transient transcript, interpretation, confirmation and error UI. */
function clearAssistUi() {
  const transcriptEl = document.getElementById('assist-transcript');
  const confirmEl = document.getElementById('assist-confirmation');
  const errorEl = document.getElementById('assist-error');
  const saidEl = document.getElementById('transcript-said');
  const interpretationEl = document.getElementById('interpretation-content');
  const messageEl = document.getElementById('confirmation-message');
  const buttonsEl = document.getElementById('confirmation-buttons');
  const errorMessageEl = document.getElementById('assist-error-message');
  const errorButtonsEl = document.getElementById('assist-error-buttons');
  if (transcriptEl) transcriptEl.style.display = 'none';
  if (confirmEl) confirmEl.style.display = 'none';
  if (errorEl) errorEl.style.display = 'none';
  if (saidEl) saidEl.textContent = '';
  if (interpretationEl) interpretationEl.textContent = '';
  if (messageEl) messageEl.textContent = '';
  if (buttonsEl) buttonsEl.replaceChildren();
  if (errorMessageEl) errorMessageEl.textContent = '';
  if (errorButtonsEl) errorButtonsEl.replaceChildren();
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
  const intentLabels = {
    SEND_MESSAGE: 'Send message', CALL_CONTACT: 'Call contact', OPEN_CHAT: 'Open chat',
    READ_MESSAGES: 'Read messages', SEARCH_CONVERSATION: 'Search conversation', GO_BACK: 'Go back',
  };
  const actionLabel = intentLabels[command.intent] || command.intent || 'Unknown action';
  const isMessage = command.intent === 'SEND_MESSAGE';
  const intentScore = Number(command.intentConfidence ?? command.confidence ?? 0);
  const recipientScore = Number(command.recipientMatchScore ?? 0);
  const risk = String(command.risk || 'unknown').toLowerCase();
  const recipientName = command.recipient?.displayName || 'Not resolved';
  const recipientUsername = command.recipient?.username || '';
  const messageBody = typeof command.message === 'string' && command.message.length
    ? command.message : 'Not applicable for this action';

  // Keep the review details together so the user can verify the exact action before execution.
  interpEl.innerHTML = `
    <div class="interpretation-row"><span class="interp-label">Action:</span> ${escapeHtml(actionLabel)}</div>
    <div class="interpretation-row"><span class="interp-label">Recipient:</span> ${escapeHtml(recipientName)}</div>
    ${recipientUsername ? `<div class="interpretation-row"><span class="interp-label">Username:</span> ${escapeHtml(recipientUsername)}</div>` : ''}
    <div class="interpretation-row"><span class="interp-label">Message:</span> ${isMessage ? `&ldquo;${escapeHtml(messageBody)}&rdquo;` : 'Not applicable'}</div>
    <div class="interpretation-row"><span class="interp-label">Intent confidence (rule-based):</span> ${Math.round(Math.max(0, Math.min(1, intentScore)) * 100)}%</div>
    <div class="interpretation-row"><span class="interp-label">Recipient match score:</span> ${command.recipient ? `${Math.round(Math.max(0, Math.min(1, recipientScore)) * 100)}%` : 'Not applicable'}</div>
    <div class="interpretation-row"><span class="interp-label">Risk:</span> <span class="risk-badge risk-${escapeHtml(risk)}">${escapeHtml(risk)}</span></div>
    <div class="small text-muted">Scores are rule-based estimates, not calibrated probabilities.</div>`;

  // Keep spoken and physical confirmation paths available together.
  const spoken = command.spokenResponse || `Ready to ${actionLabel.toLowerCase()}.`;
  msgEl.innerHTML = `<div class="spoken-response">${escapeHtml(spoken)}</div><div class="say-confirm text-muted small mt-1">Say &ldquo;Confirm&rdquo;, &ldquo;Retry&rdquo;, or &ldquo;Cancel&rdquo; — or use the buttons below.</div>`;

  // Render buttons
  const isCall = command.intent === 'CALL_CONTACT';
  btnsEl.innerHTML = `
    <button class="btn btn-success assist-confirm-btn" aria-label="Confirm action">${isCall ? 'CALL' : 'CONFIRM'}</button>
    <button class="btn btn-outline-secondary assist-retry-btn" aria-label="Retry">RETRY</button>
    <button class="btn btn-outline-danger assist-cancel-btn" aria-label="Cancel">CANCEL</button>`;

  btnsEl.querySelector('.assist-confirm-btn').addEventListener('click', async (event) => {
    setConfirmationButtonsBusy(true);
    try { await assistController.confirm(); } finally { setConfirmationButtonsBusy(false); }
  });
  btnsEl.querySelector('.assist-retry-btn').addEventListener('click', async () => {
    setConfirmationButtonsBusy(true);
    try { await assistController.retry(); } finally { setConfirmationButtonsBusy(false); }
  });
  btnsEl.querySelector('.assist-cancel-btn').addEventListener('click', async () => {
    setConfirmationButtonsBusy(true);
    try { await assistController.cancel(); } finally { setConfirmationButtonsBusy(false); }
  });
}

/** Prevent duplicate clicks while a confirmation request is in flight. */
function setConfirmationButtonsBusy(busy) {
  const buttons = document.querySelectorAll('#confirmation-buttons button');
  buttons.forEach((button) => { button.disabled = busy; });
}

/** Show an error with retry/cancel buttons. */
function showError(message) {
  const errorEl = document.getElementById('assist-error');
  const msgEl = document.getElementById('assist-error-message');
  const btnsEl = document.getElementById('assist-error-buttons');
  const confirmEl = document.getElementById('assist-confirmation');
  if (confirmEl) confirmEl.style.display = 'none';
  errorEl.style.display = 'block';
  msgEl.textContent = message || 'I didn\'t understand that.';
  btnsEl.innerHTML = `
    <button class="btn btn-outline-secondary assist-error-retry-btn">RETRY</button>
    <button class="btn btn-outline-danger assist-error-cancel-btn">CANCEL</button>`;
  btnsEl.querySelector('.assist-error-retry-btn').addEventListener('click', async () => {
    errorEl.style.display = 'none';
    if (confirmationController.getPendingCommand()) {
      await assistController.retry();
      return;
    }
    assistState.forceState(AssistState.IDLE);
    assistController.startListening();
  });
  btnsEl.querySelector('.assist-error-cancel-btn').addEventListener('click', async () => {
    if (confirmationController.getPendingCommand()) {
      await assistController.cancel();
    } else {
      assistState.reset();
      clearAssistUi();
    }
  });
}


/** Offer explicit recipient choices when similar contacts are detected. */
function showClarificationOptions(data) {
  const errorEl = document.getElementById('assist-error');
  const msgEl = document.getElementById('assist-error-message');
  const btnsEl = document.getElementById('assist-error-buttons');
  const confirmEl = document.getElementById('assist-confirmation');
  if (!errorEl || !msgEl || !btnsEl) return;
  if (confirmEl) confirmEl.style.display = 'none';
  errorEl.style.display = 'block';
  msgEl.textContent = data?.spokenResponse || 'Several contacts sound similar. Choose the intended username; no action was taken.';
  btnsEl.replaceChildren();
  for (const option of (data?.clarificationOptions || [])) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-outline-primary';
    button.textContent = `${option.displayName} (@${option.username})`;
    button.addEventListener('click', async () => {
      btnsEl.querySelectorAll('button').forEach((item) => { item.disabled = true; });
      errorEl.style.display = 'none';
      clearAssistUi();
      await assistController.submitTranscript(option.transcript);
    });
    btnsEl.appendChild(button);
  }
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'btn btn-outline-danger';
  cancelButton.textContent = 'CANCEL';
  cancelButton.addEventListener('click', () => {
    assistState.reset();
    clearAssistUi();
  });
  btnsEl.appendChild(cancelButton);
}

/** Clean up. */
export function destroyAssistPage() {
  if (stateUnsub) stateUnsub();
  if (clearUiHandler) window.removeEventListener('aperture:assist-clear', clearUiHandler);
  if (clarificationHandler) window.removeEventListener('aperture:assist-clarification', clarificationHandler);
  assistController.cleanup();
}

export default { initAssistPage, destroyAssistPage };
