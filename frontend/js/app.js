/**
 * APERTURE - Main Application Entry Point
 * Handles authentication gating, page routing, layout shell, bottom navigation,
 * and WebSocket lifecycle.
 */
import { auth } from './services/auth-service.js';
import { connectWebSocket, disconnectWebSocket, onWebSocketStateChange, WsState } from './realtime/websocket-client.js';
import { initTheme, showToast, queryParam } from './utils.js';
import { USE_MOCK_API } from './config.js';
import { initializeCallRuntime, destroyCallRuntime } from './webrtc/call-controller.js';
import { audioController } from './assist/audio-controller.js';

let currentPage = null;
let currentPageDestroy = null;
let wsStateUnsub = null;
let voiceNavigationHistory = [];
let voiceOverlayRecognitionActive = false;
let voiceOverlayTranscript = '';
let voiceOverlayRecognition = null;
let voiceOverlayContinuousMode = false;

/** App entry — called on DOMContentLoaded. */
export async function startApp() {
  initTheme();

  // Check authentication (skip in mock mode for convenience).
  if (!USE_MOCK_API) {
    const session = await auth.getSession();
    if (!session) {
      window.location.href = 'login.html';
      return;
    }
  }

  renderLayout();
  setupNavigation();
  setupVoiceOverlay();
  window.__apertureNavigateTo = (page) => navigateTo(page);
  window.__apertureVoiceGoBack = voiceGoBack;
  initializeCallRuntime();
  setupWebSocket();

  // Route to the initial page.
  const initialPage = queryParam('page') || 'chats';
  navigateTo(initialPage);

  // Listen for auth-expired events.
  window.addEventListener('aperture:auth-expired', () => {
    showToast('Your session has expired. Please sign in again.', 'warning');
    setTimeout(() => { window.location.href = 'login.html'; }, 2000);
  });
}

/** Render the app layout shell: top bar, main content, bottom navigation. */
function renderLayout() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <header class="app-topbar" role="banner">
      <div class="app-topbar-left">
        <span class="app-brand" aria-label="Aperture">
          <i class="bi bi-aperture" aria-hidden="true"></i>
          <span class="app-brand-text">APERTURE</span>
        </span>
      </div>
      <div class="app-topbar-center" id="app-page-title">Chats</div>
      <div class="app-topbar-right">
        <button
          class="btn btn-sm btn-link"
          id="contacts-nav"
          aria-label="Contacts"
          title="Contacts"
        >
          <i class="bi bi-people"></i>
        </button>

        <button class="btn btn-sm btn-link app-ws-indicator" id="ws-indicator" aria-label="Connection status" title="Connecting...">
          <span class="ws-dot ws-connecting" id="ws-dot"></span>
        </button>
      </div>
    </header>

    <main class="app-main" id="app-main" role="main"></main>

    <nav class="app-bottomnav" role="navigation" aria-label="Main navigation">
      <button class="bottomnav-item active" data-page="chats" aria-label="Chats" aria-current="page">
        <i class="bi bi-chat-dots"></i>
        <span class="bottomnav-label">Chats</span>
      </button>
      <button class="bottomnav-item" data-page="calls" aria-label="Calls">
        <i class="bi bi-telephone"></i>
        <span class="bottomnav-label">Calls</span>
      </button>
      <button class="bottomnav-item" data-page="assist" aria-label="Aperture Assist">
        <i class="bi bi-mic"></i>
        <span class="bottomnav-label">Assist</span>
      </button>
      <button class="bottomnav-item" data-page="profile" aria-label="Profile">
        <i class="bi bi-person"></i>
        <span class="bottomnav-label">Profile</span>
      </button>
    </nav>
    <button type="button" class="aperture-voice-launcher" id="aperture-voice-launcher" aria-label="Open Voice Assist" title="Voice Assist"><i class="bi bi-mic-fill"></i></button>
    <section class="aperture-voice-overlay" id="aperture-voice-overlay" aria-label="Voice Assist" hidden>
      <div class="aperture-voice-head">
        <span class="aperture-voice-status-dot" id="aperture-voice-dot"></span>
        <div class="aperture-voice-heading"><strong>Aperture Voice Assist</strong><small id="aperture-voice-status">Ready · Indian English</small></div>
        <button type="button" class="aperture-voice-iconbtn" id="aperture-voice-minimize" aria-label="Minimize Voice Assist" title="Minimize"><i class="bi bi-dash-lg"></i></button>
        <button type="button" class="aperture-voice-iconbtn" id="aperture-voice-exit" aria-label="Exit Voice Assist" title="Exit"><i class="bi bi-x-lg"></i></button>
      </div>
      <div class="aperture-voice-transcript-label">WHAT I HEARD</div>
      <div class="aperture-voice-transcript" id="aperture-voice-transcript" aria-live="polite">Say “open chat Ishwar”, “read messages”, or “go back”.</div>
      <div class="aperture-voice-transcript-label">APERTURE UNDERSTOOD</div>
      <div class="aperture-voice-interpreted" id="aperture-voice-interpreted">Waiting for a command</div>
      <div class="aperture-voice-actions">
        <button type="button" class="btn btn-sm btn-primary" id="aperture-voice-listen"><i class="bi bi-mic-fill"></i><span>Listen</span></button>
        <button type="button" class="btn btn-sm btn-outline-secondary" id="aperture-voice-pause" aria-pressed="false" title="Toggle continuous listening"><i class="bi bi-arrow-repeat"></i><span>Continuous: Off</span></button>
        <button type="button" class="btn btn-sm btn-outline-danger" id="aperture-voice-cancel"><i class="bi bi-x-circle"></i><span>Stop speech</span></button>
      </div>
    </section>`;
}

/** Setup bottom navigation click handlers. */
function setupNavigation() {
  document.querySelectorAll('.bottomnav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigateTo(btn.dataset.page);
    });
  });

  const contactsBtn = document.getElementById('contacts-nav');

if (contactsBtn) {
  contactsBtn.addEventListener('click', () => {
    navigateTo('contacts');
  });
}
}



/** Navigate to a page. */
async function navigateTo(page) {
  if (currentPage && currentPage !== page) {
    voiceNavigationHistory.push(currentPage);
    if (voiceNavigationHistory.length > 30) voiceNavigationHistory.shift();
  }
  // Destroy previous page.
  if (currentPageDestroy) {
    try { currentPageDestroy(); } catch (e) { /* ignore */ }
    currentPageDestroy = null;
  }

  // Update nav active state.
  document.querySelectorAll('.bottomnav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.page === page);
    btn.setAttribute('aria-current', btn.dataset.page === page ? 'page' : 'false');
  });

  // Update title.
  const titleEl = document.getElementById('app-page-title');
  const titles = { chats: 'Chats', calls: 'Calls', assist: 'Assist', profile: 'Profile', contacts: 'Contacts', admin: 'Admin' };
  if (titleEl) titleEl.textContent = titles[page] || page;

  const mainEl = document.getElementById('app-main');
  if (!mainEl) return;

  // Show loading state.
  mainEl.innerHTML = `<div class="loading-state"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div></div>`;

  try {
    switch (page) {
      case 'chats': {
        const mod = await import('./pages/chat-page.js');
        await mod.initChatPage(mainEl);
        currentPageDestroy = mod.destroyChatPage;
        break;
      }
      case 'calls': {
        const mod = await import('./pages/calls-page.js');
        await mod.initCallsPage(mainEl);
        currentPageDestroy = mod.destroyCallsPage;
        break;
      }
      case 'assist': {
        const mod = await import('./pages/assist-page.js');
        mod.initAssistPage(mainEl);
        currentPageDestroy = mod.destroyAssistPage;
        break;
      }
      case 'profile': {
        const mod = await import('./pages/profile-page.js');
        await mod.initProfilePage(mainEl);
        currentPageDestroy = mod.destroyProfilePage;
        break;
      }
      case 'contacts': {
        const mod = await import('./pages/contacts-page.js');
        await mod.initContactsPage(mainEl);
        currentPageDestroy = mod.destroyContactsPage;
        break;
      }
      case 'admin': {
        const mod = await import('./pages/admin-page.js');
        await mod.initAdminPage(mainEl);
        currentPageDestroy = mod.destroyAdminPage;
        break;
      }
      default:
        mainEl.innerHTML = `<div class="empty-state"><p>Page not found.</p></div>`;
    }
    currentPage = page;
  } catch (e) {
    console.error(`[app] Failed to load page "${page}":`, e);
    mainEl.innerHTML = `<div class="error-state"><i class="bi bi-exclamation-triangle"></i><p>Could not load this page.</p><button class="btn btn-sm btn-outline-primary" onclick="location.reload()">Retry</button></div>`;
  }
}

/** Install the compact app-level Voice Assist overlay. */
function setupVoiceOverlay() {
  const overlay = document.getElementById('aperture-voice-overlay');
  const listenBtn = document.getElementById('aperture-voice-listen');
  const pauseBtn = document.getElementById('aperture-voice-pause');
  const cancelBtn = document.getElementById('aperture-voice-cancel');
  const minimizeBtn = document.getElementById('aperture-voice-minimize');
  const exitBtn = document.getElementById('aperture-voice-exit');
  const transcriptEl = document.getElementById('aperture-voice-transcript');
  const interpretedEl = document.getElementById('aperture-voice-interpreted');
  const statusEl = document.getElementById('aperture-voice-status');
  const dotEl = document.getElementById('aperture-voice-dot');
  const launcher = document.getElementById('aperture-voice-launcher');
  if (!overlay || !listenBtn || !launcher) return;

  launcher.addEventListener('click', () => {
    overlay.hidden = !overlay.hidden;
    if (!overlay.hidden) transcriptEl.textContent = 'Say “open chat [name]”, “read messages ascending 5”, “video call [name]”, or “go back”.';
  });
  window.addEventListener('aperture:voice-overlay-message', (event) => {
    if (event.detail?.text) transcriptEl.textContent = event.detail.text;
    statusEl.textContent = 'Ready · Indian English';
  });
  minimizeBtn.addEventListener('click', () => { overlay.hidden = true; stopOverlayRecognition(); statusEl.textContent = 'Paused'; });
  exitBtn.addEventListener('click', () => {
    stopOverlayRecognition();
    audioController.stopSpeaking();
    overlay.hidden = true;
    voiceOverlayContinuousMode = false;
    pauseBtn.setAttribute('aria-pressed', 'false');
    pauseBtn.querySelector('span').textContent = 'Continuous: Off';
    statusEl.textContent = 'Exited';
  });
  cancelBtn.addEventListener('click', () => {
    stopOverlayRecognition();
    audioController.stopSpeaking();
    voiceOverlayContinuousMode = false;
    pauseBtn.setAttribute('aria-pressed', 'false');
    pauseBtn.querySelector('span').textContent = 'Continuous: Off';
    statusEl.textContent = 'Stopped';
    dotEl.classList.remove('is-listening');
  });
  pauseBtn.addEventListener('click', () => {
    voiceOverlayContinuousMode = !voiceOverlayContinuousMode;
    pauseBtn.setAttribute('aria-pressed', String(voiceOverlayContinuousMode));
    pauseBtn.classList.toggle('btn-primary', voiceOverlayContinuousMode);
    pauseBtn.classList.toggle('btn-outline-secondary', !voiceOverlayContinuousMode);
    pauseBtn.querySelector('span').textContent = `Continuous: ${voiceOverlayContinuousMode ? 'On' : 'Off'}`;
    if (voiceOverlayContinuousMode) {
      if (!startOverlayRecognition()) voiceOverlayContinuousMode = false;
    } else {
      stopOverlayRecognition();
      statusEl.textContent = 'Ready · Indian English';
    }
    pauseBtn.setAttribute('aria-pressed', String(voiceOverlayContinuousMode));
    pauseBtn.querySelector('span').textContent = `Continuous: ${voiceOverlayContinuousMode ? 'On' : 'Off'}`;
  });
  listenBtn.addEventListener('click', () => {
    if (voiceOverlayRecognitionActive) { stopOverlayRecognition(); statusEl.textContent = 'Paused'; return; }
    voiceOverlayContinuousMode = false;
    pauseBtn.setAttribute('aria-pressed', 'false');
    pauseBtn.classList.remove('btn-primary');
    pauseBtn.classList.add('btn-outline-secondary');
    pauseBtn.querySelector('span').textContent = 'Continuous: Off';
    startOverlayRecognition();
  });

  function startOverlayRecognition() {
    if (!audioController.isSpeechRecognitionAvailable()) {
      statusEl.textContent = 'Speech recognition unavailable';
      transcriptEl.textContent = 'Use a supported browser with microphone permission.';
      return false;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!voiceOverlayRecognition) {
      voiceOverlayRecognition = new SR();
      voiceOverlayRecognition.lang = 'en-IN';
      voiceOverlayRecognition.interimResults = true;
      voiceOverlayRecognition.onresult = (event) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) transcript += event.results[i][0].transcript;
        voiceOverlayTranscript = transcript.trim();
        if (voiceOverlayTranscript) transcriptEl.textContent = voiceOverlayTranscript;
        const result = event.results[event.results.length - 1];
        if (result?.isFinal && voiceOverlayTranscript) {
          const recognized = isSupportedOverlayCommand(voiceOverlayTranscript);
          if (!recognized) {
            interpretedEl.textContent = 'Ignored — command not recognized';
            statusEl.textContent = voiceOverlayContinuousMode ? 'Continuous listening · waiting for a supported command' : 'Command not recognized';
            if (!voiceOverlayContinuousMode) stopOverlayRecognition();
            return;
          }
          // Stop before executing to avoid interpreting our own spoken feedback.
          if (voiceOverlayContinuousMode) {
            try { voiceOverlayRecognition.stop(); } catch (_) {}
          }
          handleOverlayVoiceCommand(voiceOverlayTranscript, statusEl, transcriptEl, interpretedEl);
          if (!voiceOverlayContinuousMode) stopOverlayRecognition();
        }
      };
      voiceOverlayRecognition.onerror = (event) => {
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          voiceOverlayContinuousMode = false;
          statusEl.textContent = 'Microphone permission denied';
          pauseBtn.setAttribute('aria-pressed', 'false');
          pauseBtn.querySelector('span').textContent = 'Continuous: Off';
          return;
        }
        if (event.error !== 'no-speech' && event.error !== 'aborted') statusEl.textContent = 'Could not hear clearly';
      };
      voiceOverlayRecognition.onend = () => {
        voiceOverlayRecognitionActive = false;
        dotEl.classList.remove('is-listening');
        listenBtn.querySelector('span').textContent = 'Listen';
        if (voiceOverlayContinuousMode && !overlay.hidden) {
          // Restart after a completed phrase; ignore unknown phrases before dispatching actions.
          setTimeout(() => { if (voiceOverlayContinuousMode && !overlay.hidden) startOverlayRecognition(); }, 350);
        } else if (statusEl.textContent.startsWith('Listening')) {
          statusEl.textContent = 'Ready · Indian English';
        }
      };
    }
    voiceOverlayRecognition.continuous = voiceOverlayContinuousMode;
    if (voiceOverlayRecognitionActive) return true;
    voiceOverlayRecognitionActive = true;
    statusEl.textContent = voiceOverlayContinuousMode ? 'Continuous listening · en-IN' : 'Listening · en-IN';
    dotEl.classList.add('is-listening');
    listenBtn.querySelector('span').textContent = 'Listening…';
    try { voiceOverlayRecognition.start(); return true; }
    catch (error) {
      voiceOverlayRecognitionActive = false;
      dotEl.classList.remove('is-listening');
      statusEl.textContent = 'Ready · Indian English';
      return false;
    }
  }

  function stopOverlayRecognition() {
    voiceOverlayContinuousMode = false;
    voiceOverlayRecognitionActive = false;
    if (voiceOverlayRecognition) { try { voiceOverlayRecognition.stop(); } catch (_) {} }
    listenBtn.querySelector('span').textContent = 'Listen';
    dotEl.classList.remove('is-listening');
  }
  window.__apertureStopVoiceOverlay = stopOverlayRecognition;
}

function normalizeOverlayTranscript(raw) {
  return String(raw || '').toLowerCase().replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Normalize spoken count words only in the count position of a read-messages
 * command. This avoids changing ordinary message text or contact names.
 */
function normalizeReadMessagesTranscript(raw) {
  const normalized = normalizeOverlayTranscript(raw);
  const match = normalized.match(/^(please\s+)?read\s+(my\s+)?messages(?:\s+(ascending|descending)(?:\s+(one|two|to|too|\d{1,2}))?)?$/);
  if (!match) return normalized;

  const spokenCounts = { one: '1', two: '2', to: '2', too: '2' };
  const count = match[4] ? (spokenCounts[match[4]] || match[4]) : '';
  return [
    match[1] ? 'please' : '',
    'read',
    match[2] ? 'my' : '',
    'messages',
    match[3] || '',
    count,
  ].filter(Boolean).join(' ');
}

function isSupportedOverlayCommand(raw) {
  const normalized = normalizeReadMessagesTranscript(raw);
  return /^(?:please\s+)?(?:open|show)\s+(?:the\s+)?chat\s+(?:with\s+)?[a-z0-9][a-z0-9 .'-]{0,79}$/.test(normalized)
    || /^(?:please\s+)?read\s+(?:my\s+)?messages(?:\s+(?:ascending|descending)(?:\s+\d{1,2})?)?$/.test(normalized)
    || /^(?:please\s+)?(?:call|audio\s+call|video\s+call)\s+[a-z0-9][a-z0-9 .'-]{0,79}$/.test(normalized)
    || /^(?:please\s+)?(?:call\s+)?(?:audio|video)\s+call\s+[a-z0-9][a-z0-9 .'-]{0,79}$/.test(normalized)
    || /^(?:please\s+)?go\s+back$/.test(normalized);
}

function handleOverlayVoiceCommand(raw, statusEl, transcriptEl, interpretedEl) {
  // Use the same scoped number normalization for dispatch that command
  // recognition uses, so "one", "two", "to", and "too" reach the reader.
  const normalized = normalizeReadMessagesTranscript(raw);
  const openMatch = normalized.match(/^(?:please\s+)?(?:open|show)\s+(?:the\s+)?chat\s+(?:with\s+)?(.+)$/);
  if (openMatch) {
    const name = openMatch[1].trim();
    statusEl.textContent = `Opening chat · ${name}`;
    interpretedEl.textContent = `Open chat → ${name}`;
    const open = () => window.dispatchEvent(new CustomEvent('aperture:voice-open-chat', { detail: { name } }));
    if (currentPage !== 'chats') navigateTo('chats').then(open); else open();
    return;
  }

  const readMatch = normalized.match(/^(?:please\s+)?read\s+(?:my\s+)?messages(?:\s+(ascending|descending)(?:\s+(\d{1,2}))?)?$/);
  if (readMatch) {
    const mode = readMatch[1] || 'default';
    const limit = readMatch[2] ? Math.min(20, Math.max(1, Number(readMatch[2]))) : null;
    const detail = { mode, limit };
    const read = () => window.dispatchEvent(new CustomEvent('aperture:voice-read-messages', { detail }));
    if (currentPage !== 'chats') {
      statusEl.textContent = 'Open a chat to read messages';
      interpretedEl.textContent = `Read messages · ${mode}`;
      navigateTo('chats').then(() => {
        transcriptEl.textContent = 'Choose a conversation, then say read messages again.';
      });
    } else {
      read();
      interpretedEl.textContent = mode === 'default' ? 'Read recent messages aloud' : `Read ${mode} messages${limit ? ` · ${limit}` : ''}`;
      statusEl.textContent = 'Reading messages';
    }
    return;
  }

  const callMatch = normalized.match(/^(?:please\s+)?(?:(video|audio)\s+call|call\s+(?:(video|audio)\s+call\s+)?)(.+)$/);
  if (callMatch) {
    const callType = callMatch[1] || callMatch[2] || 'audio';
    const recipient = (callMatch[3] || '').trim();
    if (!recipient) return;
    interpretedEl.textContent = `Request ${callType} call → ${recipient}`;
    statusEl.textContent = 'Opening Voice Assist for confirmation';
    const submit = () => window.dispatchEvent(new CustomEvent('aperture:assist-overlay-command', {
      detail: { transcript: `${callType} call ${recipient}` },
    }));
    if (currentPage !== 'assist') navigateTo('assist').then(submit);
    else submit();
    return;
  }

  if (/^(?:please\s+)?go\s+back$/.test(normalized)) {
    voiceGoBack();
    interpretedEl.textContent = 'Go back → previous view';
    statusEl.textContent = 'Going back';
    return;
  }
  interpretedEl.textContent = 'Command not recognized';
  transcriptEl.textContent = `I heard “${raw}”. Try: open chat [name], read messages [ascending|descending] [number], call [name], audio call [name], video call [name], or go back.`;
  statusEl.textContent = 'Command not supported in quick overlay';
}

function voiceGoBack() {
  // Match the user's explicit requirement: invoke the real Chats tab click
  // handler instead of reconstructing the chat UI or traversing voice history.
  voiceNavigationHistory = [];
  const chatsTab = document.querySelector('.bottomnav-item[data-page="chats"]');
  if (chatsTab) chatsTab.click();
}

/** Setup WebSocket connection and state indicator. */
function setupWebSocket() {
  const dotEl = document.getElementById('ws-dot');
  const btnEl = document.getElementById('ws-indicator');

  wsStateUnsub = onWebSocketStateChange((state) => {
    if (!dotEl || !btnEl) return;
    dotEl.className = 'ws-dot';
    if (state === WsState.CONNECTED) {
      dotEl.classList.add('ws-connected');
      btnEl.title = 'Connected';
    } else if (state === WsState.CONNECTING) {
      dotEl.classList.add('ws-connecting');
      btnEl.title = 'Connecting...';
    } else if (state === WsState.RECONNECTING) {
      dotEl.classList.add('ws-reconnecting');
      btnEl.title = 'Reconnecting...';
    } else {
      dotEl.classList.add('ws-disconnected');
      btnEl.title = 'Disconnected';
    }
  });

  connectWebSocket();
}

/** Clean up on page unload. */
export function cleanupApp() {
  if (wsStateUnsub) wsStateUnsub();
  if (currentPageDestroy) { try { currentPageDestroy(); } catch (e) { /* ignore */ } }
  void destroyCallRuntime();
  disconnectWebSocket();
}

// Boot the app when DOM is ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}

window.addEventListener('beforeunload', cleanupApp);
