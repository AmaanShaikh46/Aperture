/**
 * APERTURE - Main Application Entry Point
 * Handles authentication gating, page routing, layout shell, bottom navigation,
 * and WebSocket lifecycle.
 */
import { auth } from './services/auth-service.js';
import { connectWebSocket, disconnectWebSocket, onWebSocketStateChange, WsState } from './realtime/websocket-client.js';
import { initTheme, showToast, queryParam } from './utils.js';
import { USE_MOCK_API } from './config.js';

let currentPage = null;
let currentPageDestroy = null;
let wsStateUnsub = null;

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
    </nav>`;
}

/** Setup bottom navigation click handlers. */
function setupNavigation() {
  document.querySelectorAll('.bottomnav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigateTo(btn.dataset.page);
    });
  });
}

/** Navigate to a page. */
async function navigateTo(page) {
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
  disconnectWebSocket();
}

// Boot the app when DOM is ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}

window.addEventListener('beforeunload', cleanupApp);
