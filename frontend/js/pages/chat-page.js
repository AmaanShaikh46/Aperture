/**
 * APERTURE - Chat Page Module
 * Renders conversation list, chat header, message list, composer,
 * typing indicator, presence, and all empty/loading/error/retry states.
 */
import { getConversations, createConversation } from '../services/conversation-service.js';
import { getMessages, sendMessage, markMessageRead } from '../services/message-service.js';
import { getPresence } from '../services/presence-service.js';
import { auth } from '../services/auth-service.js';
import { eventRouter, EventTypes } from '../realtime/event-router.js';
import { sendSocketEvent } from '../realtime/websocket-client.js';
import { escapeHtml, formatTime, formatDate, formatLastSeen, getInitials, avatarColor, debounce } from '../utils.js';
import { searchUsers } from '../services/user-service.js';

let currentUser = null;
let activeConversationId = null;
let conversations = [];
let messages = [];
let typingTimeout = null;
let unsubscribeFns = [];

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

  document
    .getElementById('new-chat-btn')
    .addEventListener('click', openNewChatSearch);

  await loadConversations();

  // Subscribe to real-time events.
  unsubscribeFns.push(
    eventRouter.on(EventTypes.MESSAGE_NEW, (msg) => {
      if (msg.conversationId === activeConversationId) {
        messages.push(msg);
        renderMessages();
        markMessageRead(msg.id).catch(() => {});
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



        <div class="conversation-list-header d-flex justify-content-between align-items-center">
          <h2 class="h6 mb-0">Chats</h2>
          <button
            id="new-chat-btn"
            class="btn btn-sm btn-primary"
            aria-label="New chat"
          >
            <i class="bi bi-plus-lg"></i>
            New Chat
          </button>
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


function openNewChatSearch() {
  const listEl = document.getElementById('conversation-list');

  listEl.innerHTML = `
    <div class="p-3">
      <div class="d-flex align-items-center mb-3">
        <button
          id="new-chat-back"
          class="btn btn-sm btn-outline-secondary me-2"
          aria-label="Back to chats"
        >
          <i class="bi bi-arrow-left"></i>
        </button>
        <strong>New Chat</strong>
      </div>

      <input
        type="text"
        id="new-chat-search"
        class="form-control"
        placeholder="Search username or name..."
        autocomplete="off"
      />

      <div id="new-chat-results" class="mt-3"></div>
    </div>
  `;

  document
    .getElementById('new-chat-back')
    .addEventListener('click', renderConversationList);

  const input = document.getElementById('new-chat-search');

  input.addEventListener(
    'input',
    debounce(async (event) => {
      const query = event.target.value.trim();
      const resultsEl = document.getElementById('new-chat-results');

      if (!query) {
        resultsEl.innerHTML = '';
        return;
      }

      try {
        const users = await searchUsers(query);

        if (!users.length) {
          resultsEl.innerHTML = `
            <div class="text-muted small">
              No users found.
            </div>
          `;
          return;
        }

        resultsEl.innerHTML = users
          .map((user) => `
            <button
              class="w-100 border-0 bg-transparent text-start p-2 d-flex align-items-center new-chat-user"
              data-user-id="${user.id}"
            >
              <div
                class="avatar avatar-sm me-2"
                style="background-color:${avatarColor(user.displayName)}"
              >
                ${getInitials(user.displayName)}
              </div>

              <div>
                <div class="fw-semibold">
                  ${escapeHtml(user.displayName)}
                </div>
                <div class="text-muted small">
                  @${escapeHtml(user.username || '')}
                </div>
              </div>
            </button>
          `)
          .join('');

        resultsEl.querySelectorAll('.new-chat-user').forEach((button) => {
          button.addEventListener('click', async () => {
            const conversation = await createConversation(
              button.dataset.userId
            );

            await loadConversations();
            await openConversation(conversation.id);
          });
        });
      } catch (error) {
        console.error('[chat] User search failed:', error);

        resultsEl.innerHTML = `
          <div class="text-danger small">
            Search failed.
          </div>
        `;
      }
    }, 300)
  );

  input.focus();
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
  renderConversationList();
  const chatArea = document.getElementById('chat-area');
  chatArea.innerHTML = `
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
      <div class="loading-state"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div></div>
    </div>
    <div class="typing-indicator" id="typing-indicator" style="display:none;"><span></span><span></span><span></span></div>
    <div class="message-composer" id="message-composer">
      <input type="text" id="message-input" class="form-control" placeholder="Type a message..." aria-label="Type a message" autocomplete="off" />
      <button id="send-btn" class="btn btn-primary" aria-label="Send message"><i class="bi bi-send-fill"></i></button>
    </div>`;

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
    try {
      const presence = await getPresence(conv.participantId);
      const statusEl = document.getElementById('chat-header-status');
      if (presence.presence === 'online') {
        statusEl.innerHTML = '<span class="presence-dot online"></span> Online';
      } else {
        statusEl.innerHTML = `<span class="presence-dot offline"></span> Last seen ${formatLastSeen(presence.lastSeen)}`;
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
      if (m.senderId !== currentUser.id) markMessageRead(m.id).catch(() => {});
    });
  } catch (e) {
    listEl.innerHTML = `<div class="error-state"><i class="bi bi-exclamation-triangle"></i><p>Could not load messages.</p><button class="btn btn-sm btn-outline-primary" onclick="window.__apertureMsgReload('${conversationId}')">Retry</button></div>`;
    window.__apertureMsgReload = (id) => loadMessages(id);
  }
}

/** Render the message list. */
function renderMessages() {
  const listEl = document.getElementById('message-list');
  if (!listEl) return;
  if (!messages || messages.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><i class="bi bi-chat"></i><p>No messages yet. Say hello!</p></div>`;
    return;
  }
  listEl.innerHTML = messages
    .map((msg) => {
      const isMine = msg.senderId === currentUser.id;
      const statusIcon = isMine ? renderStatusIcon(msg.status) : '';
      return `
        <div class="message-bubble ${isMine ? 'mine' : 'theirs'}">
          <div class="message-content">${escapeHtml(msg.content)}</div>
          <div class="message-meta">
            <span class="message-time">${formatTime(msg.createdAt)}</span>
            ${statusIcon}
          </div>
        </div>`;
    })
    .join('');
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

  const sent = sendSocketEvent(EventTypes.MESSAGE_SEND, {
    conversationId: activeConversationId,
    content,
  });

  if (!sent) {
    console.warn('[chat] WebSocket is not connected.');
    return;
  }

  input.value = '';
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
