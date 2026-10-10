/**
 * APERTURE - Chat Page Module
 * Renders conversation list, chat header, message list, composer,
 * typing indicator, presence, and all empty/loading/error/retry states.
 */
import { getConversations, createConversation } from '../services/conversation-service.js';

import {
  getMessages,
  sendMessage,
  markMessageRead,
  uploadAttachment,
  getAttachmentUrl,
} from '../services/message-service.js';

import { getPresence } from '../services/presence-service.js';
import { auth } from '../services/auth-service.js';
import { eventRouter, EventTypes } from '../realtime/event-router.js';
import { sendSocketEvent } from '../realtime/websocket-client.js';
import {
  escapeHtml,
  formatTime,
  formatDate,
  formatLastSeen,
  formatMessageDay,
  getInitials,
  avatarColor,
  debounce
} from '../utils.js';
import { searchUsers } from '../services/user-service.js';


let currentUser = null;
let activeConversationId = null;
let conversations = [];
let messages = [];
let pendingAttachment = null;
let pendingAttachmentPreviewUrl = null;
let typingTimeout = null;
let unsubscribeFns = [];

let explorerOpen = false;
let explorerSenderId = 'all';
let explorerDate = '';
let explorerTab = 'messages';
let explorerSearch = '';

const attachmentUrlCache = new Map();
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

      let previewText = '<span class="text-muted">No messages yet</span>';

      if (lastMsg) {
        const caption = (lastMsg.content || '').trim();
        const attachments = Array.isArray(lastMsg.attachments)
          ? lastMsg.attachments
          : [];

        if (attachments.length > 0) {
          const attachment = attachments[0];
          const mimeType = attachment.mimeType || '';
          const fileName = attachment.fileName || '';

          let icon = '📎';
          let label = fileName || 'Attachment';

          if (mimeType.startsWith('image/')) {
            icon = '📷';
            label = 'Photo';
          } else if (mimeType.startsWith('video/')) {
            icon = '🎥';
            label = 'Video';
          }

          // Attachment messages may contain a placeholder instead of a caption.
          const hasCaption =
            caption !== '' &&
            caption.toLowerCase() !== 'message';

          const previewLabel = hasCaption
            ? escapeHtml(caption)
            : escapeHtml(label);

          previewText = `${icon} ${previewLabel}`;
        } else if (caption && caption.toLowerCase() !== 'message') {
          previewText = escapeHtml(caption);
        } else {
          previewText = '<span class="text-muted">Message</span>';
        }
      }

      const lastMsgText = previewText;
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

      <button
        id="message-explorer-btn"
        class="btn btn-sm btn-link"
        type="button"
        aria-label="Message Explorer"
        title="Message Explorer"
      >
        <i class="bi bi-search"></i>
      </button>
    </div>

    <div class="message-list" id="message-list">
      <div class="loading-state"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div></div>
    </div>
    <div class="typing-indicator" id="typing-indicator" style="display:none;"><span></span><span></span><span></span></div>
    
    <div class="message-composer" id="message-composer">

      <!-- Attachment button -->
      <button
        type="button"
        id="attach-file-btn"
        class="btn btn-outline-secondary"
        aria-label="Attach a file"
        title="Attach a file"
      >
        <i class="bi bi-paperclip"></i>
      </button>

      <!-- Hidden file picker -->
      <input
        type="file"
        id="attachment-input"
        accept="image/*,video/*,application/pdf,.doc,.docx,.txt,.csv,.xlsx,.ppt,.pptx"
        hidden
      />

      <!-- Selected attachment preview -->
      <div
        id="attachment-preview"
        class="attachment-preview"
        hidden
      >
        <div id="attachment-preview-content"></div>

        <button
          type="button"
          id="remove-attachment-btn"
          class="btn btn-sm btn-outline-secondary"
          aria-label="Remove selected attachment"
          title="Remove attachment"
        >
          <i class="bi bi-x-lg"></i>
        </button>
      </div>

      <!-- Existing message input -->
      <input
        type="text"
        id="message-input"
        class="form-control"
        placeholder="Type a message..."
        aria-label="Type a message"
        autocomplete="off"
      />

      <!-- Existing send button -->
      <button
        id="send-btn"
        class="btn btn-primary"
        aria-label="Send message"
      >
        <i class="bi bi-send-fill"></i>
      </button>

    </div>
    <aside
      id="message-explorer"
      class="message-explorer"
      hidden
    ></aside>`;

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

  document.getElementById('message-explorer-btn')?.addEventListener('click', () => {
    openMessageExplorer('all');
  });

  const input = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');

  sendBtn.addEventListener('click', handleSend);
  const attachFileBtn = document.getElementById('attach-file-btn');
  const attachmentInput = document.getElementById('attachment-input');

  attachFileBtn?.addEventListener('click', () => {
    attachmentInput?.click();
  });

  attachmentInput?.addEventListener('change', () => {
    const file = attachmentInput.files?.[0];

    if (!file) return;

    if (file.size > 50 * 1024 * 1024) {
      alert('File exceeds the 50 MB upload limit.');
      attachmentInput.value = '';
      return;
    }

    // Release any previous preview URL.
    if (pendingAttachmentPreviewUrl) {
      URL.revokeObjectURL(pendingAttachmentPreviewUrl);
      pendingAttachmentPreviewUrl = null;
    }

    pendingAttachment = file;

    const preview = document.getElementById('attachment-preview');
    const previewContent = document.getElementById('attachment-preview-content');

    if (!preview || !previewContent) {
      pendingAttachment = null;
      attachmentInput.value = '';
      alert('The attachment preview could not be displayed.');
      return;
    }

    previewContent.replaceChildren();

    const details = document.createElement('div');
    details.className = 'attachment-preview-details';

    const fileName = document.createElement('div');
    fileName.className = 'fw-semibold';
    fileName.textContent = file.name;

    const fileSize = document.createElement('div');
    fileSize.className = 'small text-muted';
    fileSize.textContent =
      file.size < 1024 * 1024
        ? `${(file.size / 1024).toFixed(1)} KB`
        : `${(file.size / (1024 * 1024)).toFixed(2)} MB`;

    details.append(fileName, fileSize);

    if (file.type.startsWith('image/')) {
      pendingAttachmentPreviewUrl = URL.createObjectURL(file);

      const image = document.createElement('img');
      image.src = pendingAttachmentPreviewUrl;
      image.alt = file.name;
      image.className = 'attachment-selection-image';

      previewContent.append(image, details);
    } else if (file.type.startsWith('video/')) {
      pendingAttachmentPreviewUrl = URL.createObjectURL(file);

      const video = document.createElement('video');
      video.src = pendingAttachmentPreviewUrl;
      video.controls = true;
      video.preload = 'metadata';
      video.className = 'attachment-selection-video';

      previewContent.append(video, details);
    } else {
      const icon = document.createElement('i');
      icon.className = 'bi bi-file-earmark-text attachment-selection-icon';
      icon.setAttribute('aria-hidden', 'true');

      previewContent.append(icon, details);
    }

    preview.hidden = false;
    attachmentInput.value = '';
  });
  const removeAttachmentBtn = document.getElementById('remove-attachment-btn');

  removeAttachmentBtn?.addEventListener('click', () => {
    pendingAttachment = null;

    if (pendingAttachmentPreviewUrl) {
      URL.revokeObjectURL(pendingAttachmentPreviewUrl);
      pendingAttachmentPreviewUrl = null;
    }

    const preview = document.getElementById('attachment-preview');
    const previewContent = document.getElementById('attachment-preview-content');
    const attachmentInput = document.getElementById('attachment-input');

    if (preview) preview.hidden = true;
    if (previewContent) previewContent.replaceChildren();
    if (attachmentInput) attachmentInput.value = '';
  });

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


/** Get the currently active conversation. */
function getActiveConversation() {
  return conversations.find((c) => c.id === activeConversationId);
}

/** Get a participant from the active group conversation. */
function getSenderInfo(senderId) {
  const conv = getActiveConversation();
  return conv?.participants?.find((p) => p.id === senderId) || null;
}

/** Open the message explorer. */
function openMessageExplorer(senderId = 'all') {
  const explorer = document.getElementById('message-explorer');
  if (!explorer) return;

  explorerOpen = true;
  explorerSenderId = senderId;

  document.getElementById('chat-area')?.classList.add('has-message-explorer');

  renderMessageExplorer();
}

/* Render the message explorer. */
function renderMessageExplorer() {
  const explorer = document.getElementById('message-explorer');
  const conv = getActiveConversation();

  if (!explorer || !conv) {
    if (explorer) explorer.hidden = true;
    return;
  }

  const isGroup = conv.type === 'group';

  explorer.hidden = false;

  const participants = conv.participants || [];

let filteredMessages = messages.filter((msg) => {
  const searchText = explorerSearch.trim().toLowerCase();

  const searchMatches =
    !searchText ||
    (msg.content || '').toLowerCase().includes(searchText);

  const senderMatches =
    explorerSenderId === 'all' ||
    msg.senderId === explorerSenderId;

  const messageDate = new Date(msg.createdAt);

  const localDate =
    `${messageDate.getFullYear()}-${String(messageDate.getMonth() + 1).padStart(2, '0')}-${String(messageDate.getDate()).padStart(2, '0')}`;

  const dateMatches =
    !explorerDate ||
    localDate === explorerDate;

  let tabMatches = true;

  if (explorerTab === 'media') {
    tabMatches =
      (Array.isArray(msg.attachments) && msg.attachments.length > 0) ||
      msg.type === 'image' ||
      msg.type === 'video' ||
      msg.type === 'file' ||
      msg.type === 'document' ||
      msg.type === 'media' ||
      !!msg.fileName ||
      !!msg.mimeType;
  }

  if (explorerTab === 'links') {
    tabMatches =
      msg.type === 'link' ||
      /^https?:\/\//i.test(msg.content || '');
  }

  return searchMatches && senderMatches && dateMatches && tabMatches;
});

  explorer.innerHTML = `
    <div class="message-explorer-header">
      <div>
        <strong>Message Explorer</strong>
        <div class="small text-muted">
          Search messages in this conversation
        </div>
      </div>

      <button
        type="button"
        class="btn btn-sm btn-link"
        id="message-explorer-close"
        aria-label="Close Message Explorer"
      >
        <i class="bi bi-x-lg"></i>
      </button>
    </div>

    <div class="message-explorer-filters">
    <input
      type="search"
      id="explorer-search"
      class="form-control form-control-sm"
      placeholder="Search messages..."
      value="${escapeHtml(explorerSearch)}"
    />
    ${
      isGroup
        ? `
          <select id="explorer-sender" class="form-select form-select-sm">
            <option value="all">All participants</option>
            ${participants.map((participant) => `
              <option
                value="${escapeHtml(participant.id)}"
                ${explorerSenderId === participant.id ? 'selected' : ''}
              >
                ${escapeHtml(participant.displayName)}
              </option>
            `).join('')}
          </select>
        `
        : ''
    }
      <input
        type="date"
        id="explorer-date"
        class="form-control form-control-sm"
        value="${escapeHtml(explorerDate)}"
      />
    </div>

    <div class="message-explorer-tabs">
      <button
        type="button"
        class="btn btn-sm ${explorerTab === 'messages' ? 'active' : ''}"
        data-explorer-tab="messages"
      >
        Messages
      </button>

      <button
        type="button"
        class="btn btn-sm ${explorerTab === 'media' ? 'active' : ''}"
        data-explorer-tab="media"
      >
        Media
      </button>

      <button
        type="button"
        class="btn btn-sm ${explorerTab === 'links' ? 'active' : ''}"
        data-explorer-tab="links"
      >
        Links
      </button>
    </div>

    <div class="message-explorer-results">
      ${
        filteredMessages.length
          ? filteredMessages.map((msg) => `
              <button
                type="button"
                class="message-explorer-result"
                data-message-id="${escapeHtml(msg.id)}"
                data-search-text="${escapeHtml(msg.content || '')}"
              >
                <div class="fw-semibold">
                  ${escapeHtml(
                    participants.find((p) => p.id === msg.senderId)?.displayName
                    || (msg.senderId === currentUser.id ? 'You' : conv.participantName)
                    || 'Unknown'
                  )}
                </div>

                <div class="small text-muted">
                  ${
                    (msg.content || '').trim() &&
                    msg.content.trim().toLowerCase() !== 'message'
                      ? escapeHtml(msg.content)
                      : ''
                  }
                </div>

                ${
                  Array.isArray(msg.attachments)
                    ? msg.attachments.map((attachment) => {
                        const mimeType = attachment.mimeType || '';
                        const fileName = attachment.fileName || 'Attachment';

                        let icon = 'bi-paperclip';
                        let label = fileName;

                        if (mimeType.startsWith('image/')) {
                          icon = 'bi-image';
                          label = fileName;
                        } else if (mimeType.startsWith('video/')) {
                          icon = 'bi-film';
                          label = fileName;
                        } else if (mimeType === 'application/pdf') {
                          icon = 'bi-file-earmark-pdf';
                        }

                        return `

                        <div class="message-explorer-attachment small">
                          ${
                            mimeType.startsWith('image/') || mimeType.startsWith('video/')
                              ? `
                                <span
                                  class="message-explorer-thumbnail"
                                  data-explorer-attachment-id="${escapeHtml(attachment.id)}"
                                  data-explorer-mime-type="${escapeHtml(mimeType)}"
                                  aria-hidden="true"
                                >
                                  <i class="bi ${icon}"></i>
                                </span>
                              `
                              : `<i class="bi ${icon} message-explorer-file-icon" aria-hidden="true"></i>`
                          }
                          <span class="message-explorer-attachment-name">${escapeHtml(label)}</span>
                        </div>

                        `;
                      }).join('')
                    : ''
                }

                <div class="small text-muted">
                  ${formatTime(msg.createdAt)}
                </div>
              </button>
            `).join('')
          : `<div class="text-muted small p-3">No matching messages.</div>`
      }
    </div>
  `;

  document
    .getElementById('message-explorer-close')
    ?.addEventListener('click', closeMessageExplorer);

  document
    .getElementById('explorer-sender')
    ?.addEventListener('change', (event) => {
      explorerSenderId = event.target.value;
      renderMessageExplorer();
    });

  document
    .getElementById('explorer-date')
    ?.addEventListener('change', (event) => {
      explorerDate = event.target.value;
      renderMessageExplorer();
    });
  document
    .getElementById('explorer-search')
    ?.addEventListener('input', (event) => {
      explorerSearch = event.target.value;

      const searchText = explorerSearch.trim().toLowerCase();

      document
        .querySelectorAll('.message-explorer-result')
        .forEach((result) => {
          const content = result.textContent.toLowerCase();

          result.hidden = searchText && !content.includes(searchText);
        });
    });

  explorer
    .querySelectorAll('[data-explorer-tab]')
    .forEach((button) => {
      button.addEventListener('click', () => {
        explorerTab = button.dataset.explorerTab;
        renderMessageExplorer();
      });
    });

  explorer
    .querySelectorAll('.message-explorer-result')
    .forEach((result) => {
      result.addEventListener('click', () => {
        jumpToMessage(result.dataset.messageId);
      });
    });
    // Load image and video thumbnails using the existing attachment URL cache.
explorer.querySelectorAll('.message-explorer-thumbnail').forEach(async (thumbnail) => {
  const attachmentId = thumbnail.dataset.explorerAttachmentId;
  const mimeType = thumbnail.dataset.explorerMimeType;

  if (!attachmentId) return;

  try {
    let cached = attachmentUrlCache.get(attachmentId);
    let attachmentUrl;

    if (cached && cached.expiresAt > Date.now()) {
      attachmentUrl = cached.url;
    } else {
      attachmentUrlCache.delete(attachmentId);

      const result = await getAttachmentUrl(attachmentId);

      if (!result?.url) {
        throw new Error('Attachment URL unavailable');
      }

      attachmentUrl = result.url;

      attachmentUrlCache.set(attachmentId, {
        url: attachmentUrl,
        expiresAt: Date.now() + 4 * 60 * 1000,
      });
    }

    const parsedUrl = new URL(attachmentUrl, window.location.origin);

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Invalid attachment URL');
    }

    // The Explorer may have been rerendered while the URL was loading.
    if (!thumbnail.isConnected) return;

    if (mimeType.startsWith('image/')) {
      const image = document.createElement('img');
      image.src = parsedUrl.href;
      image.alt = '';
      image.loading = 'lazy';
      image.className = 'message-explorer-thumbnail-image';
      thumbnail.replaceChildren(image);
    } else if (mimeType.startsWith('video/')) {
      const video = document.createElement('video');
      video.src = parsedUrl.href;
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.className = 'message-explorer-thumbnail-video';
      thumbnail.replaceChildren(video);
    }
  } catch (error) {
    console.error('[chat] Explorer thumbnail failed:', error);
  }
});
}

/** Close the message explorer. */
function closeMessageExplorer() {
  const explorer = document.getElementById('message-explorer');

  explorerOpen = false;
  explorerSenderId = 'all';
  explorerDate = '';
  explorerTab = 'messages';

  document.getElementById('chat-area')?.classList.remove('has-message-explorer');

  if (explorer) {
    explorer.hidden = true;
    explorer.innerHTML = '';
  }
}

/** Jump to and highlight a message in the chat. */
function jumpToMessage(messageId) {
  const messageEl = Array.from(
    document.querySelectorAll('.message-bubble[data-message-id]')
  ).find((element) => element.dataset.messageId === messageId);

  if (!messageEl) return;

  closeMessageExplorer();

  messageEl.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  });

  messageEl.classList.remove('message-highlight');

  requestAnimationFrame(() => {
    messageEl.classList.add('message-highlight');

    setTimeout(() => {
      messageEl.classList.remove('message-highlight');
    }, 1500);
  });
}


/** Render an attachment inside a message bubble. */
async function renderAttachment(attachment, container) {
  const card = document.createElement('div');
  card.className = 'message-attachment';
  card.textContent = 'Loading attachment...';
  container.appendChild(card);

  try {
    const cached = attachmentUrlCache.get(attachment.id);
    let attachmentUrlString;

    // Reuse a URL only while it is safely within its validity period.
    if (cached && cached.expiresAt > Date.now()) {
      attachmentUrlString = cached.url;
    } else {
      attachmentUrlCache.delete(attachment.id);

      const result = await getAttachmentUrl(attachment.id);

      if (!result?.url) {
        throw new Error('Attachment URL unavailable');
      }

      attachmentUrlString = result.url;

      // Backend currently generates signed URLs valid for 5 minutes.
      // Refresh the URL after 4 minutes to avoid using an expired one.
      attachmentUrlCache.set(attachment.id, {
        url: attachmentUrlString,
        expiresAt: Date.now() + 4 * 60 * 1000,
      });
    }

    const attachmentUrl = new URL(
      attachmentUrlString,
      window.location.origin
    );

    if (!['http:', 'https:'].includes(attachmentUrl.protocol)) {
      throw new Error('Invalid attachment URL');
    }

    card.replaceChildren();

    const mimeType = attachment.mimeType || '';
    const fileName = attachment.fileName || 'Download attachment';
    const safeName = fileName.replace(/[\r\n]/g, ' ');

    if (mimeType.startsWith('image/')) {
      const image = document.createElement('img');

      image.src = attachmentUrl.href;
      image.alt = safeName;
      image.loading = 'lazy';
      image.className = 'message-media-preview';
      image.tabIndex = 0;
      image.setAttribute('role', 'button');
      image.setAttribute('aria-label', `View image: ${safeName}`);

      const openViewer = () =>
        openImageViewer(attachmentUrl.href, safeName);

      image.addEventListener('click', openViewer);

      image.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openViewer();
        }
      });

      card.appendChild(image);

    } else if (mimeType.startsWith('video/')) {
      const video = document.createElement('video');

      video.src = attachmentUrl.href;
      video.controls = true;
      video.preload = 'metadata';
      video.className = 'message-media-preview';
      video.setAttribute('aria-label', safeName);

      card.appendChild(video);

    } else {
      const link = document.createElement('a');

      link.href = attachmentUrl.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `📎 ${safeName}`;
      link.className = 'message-file-link';

      card.appendChild(link);
    }

  } catch (error) {
    console.error('[chat] Attachment preview failed:', error);

    card.textContent =
      'Attachment unavailable. Try reopening the conversation.';
  }
}

/** Open an image in an accessible overlay viewer. */
function openImageViewer(imageUrl, fileName) {
  let viewer = document.getElementById('image-viewer');

  if (!viewer) {
    viewer = document.createElement('div');
    viewer.id = 'image-viewer';
    viewer.className = 'image-viewer';
    viewer.hidden = true;

    viewer.innerHTML = `
      <div
        class="image-viewer-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Image viewer"
      >
        <button
          type="button"
          class="image-viewer-close"
          aria-label="Close image viewer"
          title="Close"
        >
          &times;
        </button>
        <img class="image-viewer-image" alt="" />
        <div class="image-viewer-filename"></div>
      </div>
    `;

    document.body.appendChild(viewer);

    viewer.addEventListener('click', (event) => {
      if (
        event.target === viewer ||
        event.target.closest('.image-viewer-close')
      ) {
        viewer.hidden = true;
        document.removeEventListener('keydown', handleViewerKeydown);
      }
    });
  }

  const image = viewer.querySelector('.image-viewer-image');
  const filename = viewer.querySelector('.image-viewer-filename');

  image.src = imageUrl;
  image.alt = fileName;
  filename.textContent = fileName;

  viewer.hidden = false;

  viewer.querySelector('.image-viewer-close').focus();

  document.addEventListener('keydown', handleViewerKeydown);
}

/** Close the image viewer using Escape. */
function handleViewerKeydown(event) {
  if (event.key !== 'Escape') return;

  const viewer = document.getElementById('image-viewer');

  if (viewer && !viewer.hidden) {
    viewer.hidden = true;
    document.removeEventListener('keydown', handleViewerKeydown);
  }
}


/** Rendr the msg list. */
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
        ? `<div class="message-day-divider">
             <span>${escapeHtml(formatMessageDay(msg.createdAt))}</span>
           </div>`
        : '';

      if (dayKey) previousDay = dayKey;

      let senderName = '';

      if (isGroup) {
        const sender = conv.participants?.find(
          (p) => p.id === msg.senderId
        );

        if (sender) {
          senderName = `
            <button
              type="button"
              class="group-message-sender"
              data-sender-id="${escapeHtml(msg.senderId)}"
              aria-label="Explore messages from ${escapeHtml(sender.displayName)}"
            >
              ${escapeHtml(sender.displayName)}
            </button>`;
        }
      }

      return `
        ${dayDivider}

        <div
          class="message-bubble ${isMine ? 'mine' : 'theirs'}"
          data-message-id="${escapeHtml(msg.id)}"
        >
          ${senderName}

          <div class="message-content">
            ${msg.content ? escapeHtml(msg.content) : ''}
          </div>
          <div class="message-attachments" data-attachments-for="${escapeHtml(msg.id)}"></div>

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
    // Load attachment previews after the message bubbles are rendered.
  listEl.querySelectorAll('.message-attachments[data-attachments-for]').forEach((container) => {
    const messageId = container.dataset.attachmentsFor;
    const message = messages.find((item) => item.id === messageId);

    if (!message?.attachments?.length) {
      container.remove();
      return;
    }

    message.attachments.forEach((attachment) => {
      // Avoid creating duplicate previews for the same attachment.
      if (container.querySelector(`[data-attachment-id="${CSS.escape(attachment.id)}"]`)) {
        return;
      }

      const wrapper = document.createElement('div');
      wrapper.dataset.attachmentId = attachment.id;
      container.appendChild(wrapper);

      renderAttachment(attachment, wrapper);
    });
  });
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
  const sendBtn = document.getElementById('send-btn');
  const content = input.value.trim();
  const conversationId = activeConversationId;

  if (!conversationId || (!content && !pendingAttachment)) return;

  const file = pendingAttachment;

  sendBtn.disabled = true;

  try {
    if (file) {
      await uploadAttachment(conversationId, file, content);

      // Clear the selection only after the upload succeeds.
      pendingAttachment = null;

      if (pendingAttachmentPreviewUrl) {
        URL.revokeObjectURL(pendingAttachmentPreviewUrl);
        pendingAttachmentPreviewUrl = null;
      }

      const preview = document.getElementById('attachment-preview');
      const previewContent = document.getElementById('attachment-preview-content');

      if (preview) preview.hidden = true;
      if (previewContent) previewContent.replaceChildren();

      input.value = '';

      if (activeConversationId === conversationId) {
        await loadMessages(conversationId);
      }

      return;
    }

    const sent = sendSocketEvent(EventTypes.MESSAGE_SEND, {
      conversationId,
      content,
    });

    if (!sent) {
      throw new Error('Not connected. Please try sending again.');
    }

    input.value = '';
  } catch (error) {
    console.error('[chat] Message send failed:', error);
    alert(error.message || 'Unable to send. Please try again.');
  } finally {
    sendBtn.disabled = false;
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
