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
let voiceAssistEnabled = true;

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
        <button type="button" class="btn btn-sm btn-outline-secondary" id="aperture-voice-pause"><i class="bi bi-pause-fill"></i><span>Pause</span></button>
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

  try { voiceAssistEnabled = localStorage.getItem('apertureVoiceAssistEnabled') !== 'false'; } catch (_) { voiceAssistEnabled = true; }
  updateVoiceAssistVisibility();
  launcher.addEventListener('click', () => {
    if (!voiceAssistEnabled) return;
    overlay.hidden = !overlay.hidden;
    if (!overlay.hidden) transcriptEl.textContent = 'Say “open chat [name]”, “read messages”, or “go back”.';
  });

  function updateVoiceAssistVisibility() {
    // When disabled in Profile, remove both the launcher and panel from the UI.
    launcher.hidden = !voiceAssistEnabled;
    if (!voiceAssistEnabled) overlay.hidden = true;
    launcher.setAttribute('aria-label', 'Open Voice Assist');
    launcher.title = 'Voice Assist';
  }
  function setVoiceAssistEnabled(enabled) {
    voiceAssistEnabled = Boolean(enabled);
    try { localStorage.setItem('apertureVoiceAssistEnabled', String(voiceAssistEnabled)); } catch (_) {}
    if (!voiceAssistEnabled) {
      stopOverlayRecognition();
      audioController.stopSpeaking();
      overlay.hidden = true;
      statusEl.textContent = 'Voice Assist off';
    } else {
      // Enabling from Profile reveals the launcher; opening the panel is a separate user action.
      overlay.hidden = true;
      statusEl.textContent = 'Ready · Indian English';
    }
    updateVoiceAssistVisibility();
  }
  window.addEventListener('aperture:voice-assist-setting-changed', (event) => {
    setVoiceAssistEnabled(Boolean(event.detail?.enabled));
  });
  window.addEventListener('aperture:voice-overlay-message', (event) => {
    if (event.detail?.text) transcriptEl.textContent = event.detail.text;
    statusEl.textContent = 'Ready · Indian English';
  });
  minimizeBtn.addEventListener('click', () => { overlay.hidden = true; });
  exitBtn.addEventListener('click', () => {
    stopOverlayRecognition();
    overlay.hidden = true;
    statusEl.textContent = 'Voice Assist closed';
  });
  cancelBtn.addEventListener('click', () => {
    stopOverlayRecognition();
    audioController.stopSpeaking();
    statusEl.textContent = 'Stopped';
    dotEl.classList.remove('is-listening');
  });
  pauseBtn.addEventListener('click', () => {
    stopOverlayRecognition();
    statusEl.textContent = 'Paused';
    dotEl.classList.remove('is-listening');
    listenBtn.querySelector('span').textContent = 'Resume';
  });
  listenBtn.addEventListener('click', () => {
    if (voiceOverlayRecognitionActive) { stopOverlayRecognition(); statusEl.textContent = 'Paused'; return; }
    if (!audioController.isSpeechRecognitionAvailable()) {
      statusEl.textContent = 'Speech recognition unavailable';
      transcriptEl.textContent = 'Use a supported browser with microphone permission.';
      return;
    }
    voiceOverlayRecognitionActive = true;
    statusEl.textContent = 'Listening · en-IN';
    dotEl.classList.add('is-listening');
    listenBtn.querySelector('span').textContent = 'Listening…';
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!voiceOverlayRecognition) {
      voiceOverlayRecognition = new SR();
      voiceOverlayRecognition.lang = 'en-IN';
      voiceOverlayRecognition.continuous = false;
      voiceOverlayRecognition.interimResults = true;
      voiceOverlayRecognition.onresult = (event) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) transcript += event.results[i][0].transcript;
        voiceOverlayTranscript = transcript.trim();
        if (voiceOverlayTranscript) transcriptEl.textContent = voiceOverlayTranscript;
        const result = event.results[event.results.length - 1];
        if (result?.isFinal && voiceOverlayTranscript) handleOverlayVoiceCommand(voiceOverlayTranscript, statusEl, transcriptEl, interpretedEl);
      };
      voiceOverlayRecognition.onerror = (event) => {
        statusEl.textContent = event.error === 'not-allowed' ? 'Microphone permission denied' : 'Could not hear clearly';
      };
      voiceOverlayRecognition.onend = () => {
        voiceOverlayRecognitionActive = false;
        dotEl.classList.remove('is-listening');
        listenBtn.querySelector('span').textContent = 'Listen';
        if (statusEl.textContent.startsWith('Listening')) statusEl.textContent = 'Ready · Indian English';
      };
    }
    try { voiceOverlayRecognition.start(); } catch (error) { voiceOverlayRecognitionActive = false; statusEl.textContent = 'Ready · Indian English'; }
  });

  function stopOverlayRecognition() {
    voiceOverlayRecognitionActive = false;
    if (voiceOverlayRecognition) { try { voiceOverlayRecognition.stop(); } catch (_) {} }
    listenBtn.querySelector('span').textContent = 'Listen';
    dotEl.classList.remove('is-listening');
  }
  window.__apertureStopVoiceOverlay = stopOverlayRecognition;
}

async function handleOverlayVoiceCommand(raw, statusEl, transcriptEl, interpretedEl) {
  if (!voiceAssistEnabled) return;
  const normalized = raw.toLowerCase().replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ').trim();
  const openMatch = normalized.match(/^(?:please\s+)?(?:open|show)\s+(?:the\s+)?chat\s+(?:with\s+)?(.+)$/);
  if (openMatch) {
    const name = openMatch[1].trim();
    statusEl.textContent = `Opening chat · ${name}`;
    interpretedEl.textContent = `Open chat → ${name}`;
    const open = () => window.dispatchEvent(new CustomEvent('aperture:voice-open-chat', { detail: { name } }));
    if (currentPage !== 'chats') navigateTo('chats').then(open); else open();
    return;
  }
  if (/^(?:please\s+)?read\s+(?:my\s+)?messages$/.test(normalized)) {
    window.dispatchEvent(new CustomEvent('aperture:voice-read-messages'));
    interpretedEl.textContent = 'Read messages aloud';
    statusEl.textContent = 'Reading messages';
    return;
  }
  if (/^(?:please\s+)?go\s+back$/.test(normalized)) {
    statusEl.textContent = 'Going back';
    interpretedEl.textContent = 'Go back → previous view';
    try {
      await voiceGoBack();
      // Keep the heard transcript for feedback, but don't leave a completed
      // navigation looking permanently in progress in the floating panel.
      statusEl.textContent = 'Ready · Indian English';
      interpretedEl.textContent = 'Go back → completed';
    } catch (error) {
      console.error('[Voice Assist] Go back failed:', error);
      statusEl.textContent = 'Could not go back';
      interpretedEl.textContent = 'Go back failed';
    }
    return;
  }
  interpretedEl.textContent = 'Command not recognized';
  transcriptEl.textContent = `I heard “${raw}”. Supported here: open chat [name], read messages, or go back.`;
  statusEl.textContent = 'Command not supported in quick overlay';
}

async function voiceGoBack() {
  // On the Chats page, use the exact same route lifecycle as clicking the
  // bottom Chats button. Re-initializing the page restores its full list,
  // event handlers, layout classes, and responsive styles instead of manually
  // rebuilding only the conversation-list DOM.
  if (currentPage === 'chats') {
    await navigateTo('chats');
    return true;
  }

  const previous = voiceNavigationHistory.pop();
  if (previous) {
    await navigateTo(previous);
    return true;
  }

  await navigateTo('chats');
  return true;
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
