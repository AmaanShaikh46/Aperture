/**
 * APERTURE - Chat Page Module
 * Renders conversation list, chat header, message list, composer,
 * typing indicator, presence, and all empty/loading/error/retry states.
 */
import { getConversations } from '../services/conversation-service.js';
import { getMessages, sendMessage, markMessageRead } from '../services/message-service.js';
import { getPresence } from '../services/presence-service.js';
import { auth } from '../services/auth-service.js';
import { eventRouter, EventTypes } from '../realtime/event-router.js';
import { escapeHtml, formatTime, formatDate, formatLastSeen, getInitials, avatarColor, debounce } from '../utils.js';

let currentUser = null;
let activeConversationId = null;
let conversations = [];
let messages = [];
let typingTimeout = null;
let unsubscribeFns = [];

// Message Explorer state
let explorerOpen = false;
let explorerSenderId = 'all';
let explorerDate = '';
let explorerTab = 'messages';

/** Initialize the chat page. */
export async function initChatPage(container) {
  currentUser = await auth.getUser();
  if (!currentUser) {
    const session = await auth.getSession();
    if (session) currentUser = session.user;
  }
  // Use a stable id from mock if auth user not available (mock mode)
  if (!currentUser) {
    currentUser = { id: '00000000-0000-0000-0000-000000000001' };
  }

  renderShell(container);
  await loadConversations();

  // Subscribe to real-time events.
  unsubscribeFns.push(
    eventRouter.on(EventTypes.MESSAGE_NEW, (msg) => {
      if (msg.conversationId === activeConversationId) {
        messages.push(msg);
        renderMessages();
        markMessageRead(msg.id).catch(() => { });
      } else {
        // Increment unread on conversation list
        const conv = conversations.find((c) => c.id === msg.conversationId);
        if (conv) {
          conv.unreadCount = (conv.unreadCount || 0) + 1;
          conv.lastMessage = msg;
          renderConversationList();
        }
      }
    }),
  );
  unsubscribeFns.push(
    eventRouter.on(EventTypes.MESSAGE_DELIVERED, (data) => {
      const msg = messages.find((m) => m.id === data.messageId);
      if (msg) { msg.status = 'delivered'; renderMessages(); }
    }),
  );
  unsubscribeFns.push(
    eventRouter.on(EventTypes.MESSAGE_READ, (data) => {
      const msg = messages.find((m) => m.id === data.messageId);
      if (msg) { msg.status = 'read'; renderMessages(); }
    }),
  );
  unsubscribeFns.push(
    eventRouter.on(EventTypes.TYPING_START, (data) => {
      if (data.conversationId === activeConversationId) showTypingIndicator();
    }),
  );
  unsubscribeFns.push(
    eventRouter.on(EventTypes.TYPING_STOP, (data) => {
      if (data.conversationId === activeConversationId) hideTypingIndicator();
    }),
  );
}

/** Render the two-panel shell: conversation list + chat area. */
function renderShell(container) {
  container.innerHTML = `
    <div class="chat-shell">
      <aside class="conversation-list-panel" id="conv-list-panel">
        <div class="conversation-list-header">
          <h2 class="h6 mb-0">Chats</h2>
        </div>
        <div id="conversation-list" class="conversation-list"></div>
      </aside>
      <section class="chat-area" id="chat-area">
        <div class="chat-empty-state">
          <i class="bi bi-chat-dots" aria-hidden="true"></i>
          <p>Select a conversation to start chatting</p>
        </div>
      </section>
    </div>`;
}

/** Load and render the conversation list. */
async function loadConversations() {
  const listEl = document.getElementById('conversation-list');
  listEl.innerHTML = `<div class="loading-state"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div></div>`;
  try {
    conversations = await getConversations();
    renderConversationList();
  } catch (e) {
    listEl.innerHTML = `<div class="error-state"><i class="bi bi-exclamation-triangle"></i><p>Could not load chats.</p><button class="btn btn-sm btn-outline-primary" onclick="window.__apertureChatReload()">Retry</button></div>`;
  }
  window.__apertureChatReload = () => loadConversations();
}

/** Render the conversation list. */
function renderConversationList() {
  const listEl = document.getElementById('conversation-list');
  if (!conversations || conversations.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><i class="bi bi-chat-square-text"></i><p>No conversations yet</p></div>`;
    return;
  }
  listEl.innerHTML = conversations
    .map((conv) => {
      const isActive = conv.id === activeConversationId;
      const initials = getInitials(conv.participantName);
      const color = avatarColor(conv.participantName);
      const lastMsg = conv.lastMessage;
      const lastMsgText = lastMsg ? escapeHtml(lastMsg.content) : '<span class="text-muted">No messages yet</span>';
      const lastMsgTime = lastMsg ? formatDate(lastMsg.createdAt) : '';
      const unread = conv.unreadCount > 0 ? `<span class="badge bg-primary rounded-pill">${conv.unreadCount}</span>` : '';
      return `
        <div class="conversation-item ${isActive ? 'active' : ''}" data-conversation-id="${conv.id}" role="button" tabindex="0" aria-label="Open conversation with ${escapeHtml(conv.participantName)}">
          <div class="avatar" style="background-color:${color}">${initials}</div>
          <div class="conversation-meta">
            <div class="conversation-top-row">
              <span class="conversation-name">${escapeHtml(conv.participantName)}</span>
              <span class="conversation-time">${lastMsgTime}</span>
            </div>
            <div class="conversation-bottom-row">
              <span class="conversation-preview">${lastMsgText}</span>
              ${unread}
            </div>
          </div>
        </div>`;
    })
    .join('');

  listEl.querySelectorAll('.conversation-item').forEach((el) => {
    el.addEventListener('click', () => openConversation(el.dataset.conversationId));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openConversation(el.dataset.conversationId); }
    });
  });
}

/** Open a conversation and load its messages. */
async function openConversation(conversationId) {
  activeConversationId = conversationId;
  explorerOpen = false;
  document.getElementById('chat-area')?.classList.remove('has-message-explorer');
  explorerSenderId = 'all';
  explorerDate = '';
  explorerTab = 'messages';
  renderConversationList();
  const chatArea = document.getElementById('chat-area');
  chatArea.innerHTML = `
    <div class="chat-main" id="chat-main">
      <div class="chat-header" id="chat-header">
        <div class="chat-header-info">
          <div class="avatar" id="chat-header-avatar"></div>
          <div>
            <div class="chat-header-name" id="chat-header-name">Loading...</div>
            <div class="chat-header-status" id="chat-header-status">...</div>
          </div>
        </div>
      </div>

      <div class="message-list" id="message-list">
        <div class="loading-state">
          <div class="spinner-border text-primary" role="status">
            <span class="visually-hidden">Loading...</span>
          </div>
        </div>
      </div>

      <div class="typing-indicator" id="typing-indicator" style="display:none;">
        <span></span><span></span><span></span>
      </div>

      <div class="message-composer" id="message-composer">
        <input
          type="text"
          id="message-input"
          class="form-control"
          placeholder="Type a message..."
          aria-label="Type a message"
          autocomplete="off"
        />
        <button id="send-btn" class="btn btn-primary" aria-label="Send message">
          <i class="bi bi-send-fill"></i>
        </button>
      </div>
    </div>

    <aside class="message-explorer" id="message-explorer" hidden>
    </aside>`;

  const conv = conversations.find((c) => c.id === conversationId);
  if (conv) {
    const nameEl = document.getElementById('chat-header-name');
    const avatarEl = document.getElementById('chat-header-avatar');
    nameEl.textContent = conv.participantName;
    avatarEl.textContent = getInitials(conv.participantName);
    avatarEl.style.backgroundColor = avatarColor(conv.participantName);
    conv.unreadCount = 0;
    renderConversationList();
    // Load presence
    // Load presence for direct conversations.
    // Group conversations show member count instead.
    try {
      const statusEl = document.getElementById('chat-header-status');

      if (conv.type === 'group') {
        const memberCount = conv.participants ? conv.participants.length : 0;
        statusEl.textContent = `${memberCount} members`;
      } else {
        const presence = await getPresence(conv.participantId);

        if (presence.presence === 'online') {
          statusEl.innerHTML = '<span class="presence-dot online"></span> Online';
        } else {
          statusEl.innerHTML = `<span class="presence-dot offline"></span> Last seen ${formatLastSeen(presence.lastSeen)}`;
        }
      }
    } catch (e) { /* ignore */ }
  }

  await loadMessages(conversationId);

  const input = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  sendBtn.addEventListener('click', handleSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });
  input.addEventListener('input', debounce(handleTyping, 400));
  input.focus();
}

/** Load messages for a conversation. */
async function loadMessages(conversationId) {
  const listEl = document.getElementById('message-list');
  try {
    messages = await getMessages(conversationId);
    renderMessages();
    // Mark all as read
    messages.forEach((m) => {
      if (m.senderId !== currentUser.id) markMessageRead(m.id).catch(() => { });
    });
  } catch (e) {
    listEl.innerHTML = `<div class="error-state"><i class="bi bi-exclamation-triangle"></i><p>Could not load messages.</p><button class="btn btn-sm btn-outline-primary" onclick="window.__apertureMsgReload('${conversationId}')">Retry</button></div>`;
    window.__apertureMsgReload = (id) => loadMessages(id);
  }
}

/** Get the currently active conversation. */
function getActiveConversation() {
  return conversations.find((c) => c.id === activeConversationId);
}

/** Get a participant from the active group conversation. */
function getSenderInfo(senderId) {
  const conv = getActiveConversation();
  return conv?.participants?.find((p) => p.id === senderId) || null;
}

/**
 * Open the message explorer for a sender.
 */
function openMessageExplorer(senderId = 'all') {
  const explorer = document.getElementById('message-explorer');
  if (!explorer) return;

  explorerOpen = true;
  explorerSenderId = senderId;
  document.getElementById('chat-area')?.classList.add('has-message-explorer');
  renderMessageExplorer();
}

/**
 * Render the message explorer panel.
 */
function renderMessageExplorer() {
  const explorer = document.getElementById('message-explorer');

  if (!explorer) return;

  if (!explorerOpen) {
    explorer.hidden = true;
    explorer.innerHTML = '';
    return;
  }

  const conv = getActiveConversation();

  if (!conv || conv.type !== 'group') {
    explorer.hidden = true;
    return;
  }

  const selectedSender = explorerSenderId === 'all' ? null : getSenderInfo(explorerSenderId);
  const filteredMessages = messages.filter((message) => {
    if (explorerSenderId !== 'all' && message.senderId !== explorerSenderId) return false;
    if (!explorerDate) return true;
    const date = new Date(message.createdAt);
    if (Number.isNaN(date.getTime())) return false;
    const localDate = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    return localDate === explorerDate;
  });
  const isLink = (message) => message.type === 'link' || Boolean(message.url) || /https?:\/\//i.test(message.content || '');
  const matchesTab = (message) => {
    if (explorerTab === 'media') return ['image', 'file', 'document', 'media'].includes(message.type) || Boolean(message.fileName || message.mimeType);
    if (explorerTab === 'links') return isLink(message);
    return true;
  };
  const visibleMessages = filteredMessages.filter(matchesTab).slice().reverse();

  explorer.hidden = false;

  explorer.innerHTML = `
      <div class="message-explorer-header">
      <div>
        <h3>Message Explorer</h3>
        <p>
          ${selectedSender
            ? `Messages from ${escapeHtml(selectedSender.displayName)}`
            : 'Explore messages'}
        </p>
      </div>

      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        id="explorer-close-btn"
        aria-label="Close message explorer"
      >
        <i class="bi bi-x-lg"></i>
      </button>
    </div>

    <div class="message-explorer-body">
      <div class="explorer-filter">
        <label for="explorer-sender">Sender</label>

        <select id="explorer-sender" class="form-select">
          <option value="all" ${explorerSenderId === 'all' ? 'selected' : ''}>All senders</option>

          ${(conv.participants || [])
            .map((participant) => `
              <option
                value="${participant.id}"
                ${participant.id === explorerSenderId ? 'selected' : ''}
              >
                ${escapeHtml(participant.displayName)}
              </option>
            `)
            .join('')}
        </select>
      </div>

      <div class="explorer-filter">
        <label for="explorer-date">Date</label>

        <input
          type="date"
          id="explorer-date"
          class="form-control"
          value="${explorerDate}"
        />
      </div>

      <div class="explorer-tabs">
        <button
          type="button"
          class="explorer-tab ${explorerTab === 'messages' ? 'active' : ''}"
          data-explorer-tab="messages"
        >
          Messages
        </button>

        <button
          type="button"
          class="explorer-tab ${explorerTab === 'media' ? 'active' : ''}"
          data-explorer-tab="media"
        >
          Media & Files
        </button>

        <button
          type="button"
          class="explorer-tab ${explorerTab === 'links' ? 'active' : ''}"
          data-explorer-tab="links"
        >
          Links
        </button>
      </div>

      <div class="explorer-results" id="explorer-results" aria-live="polite">
        ${visibleMessages.length ? visibleMessages.map((message) => {
          const detail = explorerTab === 'media'
            ? (message.fileName || message.content || 'Attachment')
            : (message.url || message.content || 'Link');
          const category = explorerTab === 'media'
            ? (message.type === 'image' ? 'Image' : 'File')
            : (explorerTab === 'links' ? 'Link' : (message.type || 'Message'));
          return `
            <button type="button" class="explorer-result" data-message-id="${escapeHtml(message.id)}">
              <span class="explorer-result-topline">
                <span>${escapeHtml(category)}</span>
                <time datetime="${escapeHtml(message.createdAt)}">${escapeHtml(new Date(message.createdAt).toLocaleString())}</time>
              </span>
              <span class="explorer-result-content">${escapeHtml(detail)}</span>
              ${message.fileName ? `<span class="explorer-result-filename">${escapeHtml(message.fileName)}</span>` : ''}
            </button>`;
        }).join('') : '<div class="empty-state explorer-empty"><i class="bi bi-search"></i><p>No matching items found.</p></div>'}
      </div>
    </div>
  `;

  document
    .getElementById('explorer-close-btn')
    .addEventListener('click', closeMessageExplorer);
  document.getElementById('explorer-sender').addEventListener('change', (event) => {
    explorerSenderId = event.target.value;
    renderMessageExplorer();
  });
  document.getElementById('explorer-date').addEventListener('change', (event) => {
    explorerDate = event.target.value;
    renderMessageExplorer();
  });
  explorer.querySelectorAll('[data-explorer-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      explorerTab = button.dataset.explorerTab;
      renderMessageExplorer();
    });
  });
  explorer.querySelectorAll('[data-message-id]').forEach((button) => {
    button.addEventListener('click', () => jumpToMessage(button.dataset.messageId));
  });
}

/** Jump from an Explorer result to its message in the conversation and highlight it. */
function jumpToMessage(messageId) {
  const messageEl = Array.from(document.querySelectorAll('.message-bubble[data-message-id]'))
    .find((element) => element.dataset.messageId === messageId);
  if (!messageEl) return;
  messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  messageEl.classList.remove('message-highlight');
  requestAnimationFrame(() => messageEl.classList.add('message-highlight'));
}

/** Format a local calendar day for a date divider in the chat timeline. */
function formatMessageDay(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();

  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Close the message explorer.
 */
function closeMessageExplorer() {
  explorerOpen = false;
  document.getElementById('chat-area')?.classList.remove('has-message-explorer');

  const explorer = document.getElementById('message-explorer');

  if (!explorer) return;

  explorer.hidden = true;
  explorer.innerHTML = '';
}

/** Render the message list. */
function renderMessages() {
  const listEl = document.getElementById('message-list');
  if (!listEl) return;

  if (!messages || messages.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <i class="bi bi-chat"></i>
        <p>No messages yet. Say hello!</p>
      </div>`;
    return;
  }

  const conv = conversations.find((c) => c.id === activeConversationId);
  const isGroup = conv?.type === 'group';

  let previousDay = null;
  listEl.innerHTML = messages
    .map((msg) => {
      const isMine = msg.senderId === currentUser.id;
      const statusIcon = isMine ? renderStatusIcon(msg.status) : '';
      const messageDate = new Date(msg.createdAt);
      const dayKey = Number.isNaN(messageDate.getTime())
        ? ''
        : `${messageDate.getFullYear()}-${messageDate.getMonth()}-${messageDate.getDate()}`;
      const dayDivider = dayKey && dayKey !== previousDay
        ? `<div class="message-day-divider"><span>${escapeHtml(formatMessageDay(msg.createdAt))}</span></div>`
        : '';
      if (dayKey) previousDay = dayKey;

      let senderName = '';

      if (isGroup) {
        const sender = conv.participants?.find((p) => p.id === msg.senderId);

        if (sender) {
          senderName = `
            <button
              type="button"
              class="group-message-sender"
              data-sender-id="${msg.senderId}"
              aria-label="Explore messages from ${escapeHtml(sender.displayName)}"
            >
              ${escapeHtml(sender.displayName)}
            </button>`;
        }
      }

      return `
        ${dayDivider}
        <div class="message-bubble ${isMine ? 'mine' : 'theirs'}" data-message-id="${escapeHtml(msg.id)}">
          ${senderName}

          <div class="message-content">
            ${escapeHtml(msg.content)}
          </div>

          <div class="message-meta">
            <span class="message-time">${formatTime(msg.createdAt)}</span>
            ${statusIcon}
          </div>
        </div>`;
    })
    .join('');

  // Make sender names clickable in group conversations.
  if (isGroup) {
    listEl.querySelectorAll('.group-message-sender').forEach((el) => {
      el.addEventListener('click', () => {
        openMessageExplorer(el.dataset.senderId);
      });
    });
  }

  listEl.scrollTop = listEl.scrollHeight;
}

/** Render the status icon for a sent message. */
function renderStatusIcon(status) {
  if (status === 'sent') return '<i class="bi bi-check2" aria-label="Sent"></i>';
  if (status === 'delivered') return '<i class="bi bi-check2-all" aria-label="Delivered"></i>';
  if (status === 'read') return '<i class="bi bi-check2-all text-primary" aria-label="Read"></i>';
  return '';
}

/** Handle sending a message. */
async function handleSend() {
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content || !activeConversationId) return;
  input.value = '';
  try {
    const msg = await sendMessage(activeConversationId, content);
    messages.push(msg);
    renderMessages();
    // Update conversation list
    const conv = conversations.find((c) => c.id === activeConversationId);
    if (conv) {
      conv.lastMessage = msg;
      conv.updatedAt = msg.createdAt;
      renderConversationList();
    }
  } catch (e) {
    const listEl = document.getElementById('message-list');
    if (listEl) {
      const errDiv = document.createElement('div');
      errDiv.className = 'message-send-error';
      errDiv.innerHTML = `<div class="alert alert-danger alert-sm m-2">Message could not be sent. <button class="btn btn-sm btn-link" onclick="this.parentElement.parentElement.remove()">Dismiss</button></div>`;
      listEl.appendChild(errDiv);
    }
  }
}

/** Handle typing indicator. */
function handleTyping() {
  if (!activeConversationId) return;
  // Send typing.start via WebSocket (the backend will relay)
  import('../realtime/websocket-client.js').then(({ sendSocketEvent }) => {
    sendSocketEvent(EventTypes.TYPING_START_SEND, { conversationId: activeConversationId });
  });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    import('../realtime/websocket-client.js').then(({ sendSocketEvent }) => {
      sendSocketEvent(EventTypes.TYPING_STOP_SEND, { conversationId: activeConversationId });
    });
  }, 2000);
}

/** Show the typing indicator. */
function showTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (el) el.style.display = 'flex';
}

/** Hide the typing indicator. */
function hideTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (el) el.style.display = 'none';
}

/** Clean up the chat page. */
export function destroyChatPage() {
  unsubscribeFns.forEach((fn) => fn());
  unsubscribeFns = [];
  activeConversationId = null;
}

export default { initChatPage, destroyChatPage };
