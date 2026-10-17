/**
 * APERTURE - Chat Page Module
 * Renders conversation list, chat header, message list, composer,
 * typing indicator, presence, and all empty/loading/error/retry states.
 */
import {
  getConversations,
  createConversation,
  createGroupConversation,
  renameGroupConversation,
  addGroupParticipants,
  removeGroupParticipant,
  transferGroupAdmin,
  leaveGroupConversation,
} from '../services/conversation-service.js';

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
import { startOutgoingCall } from '../webrtc/call-controller.js';


let currentUser = null;
let activeConversationId = null;
let conversations = [];
let messages = [];
let pendingAttachment = null;
let pendingAttachmentPreviewUrl = null;
let typingTimeout = null;
let unsubscribeFns = [];

const MESSAGE_PAGE_SIZE = 50;
let messagesLoadGeneration = 0;
let messagePaginationConversationId = null;
let nextMessageCursor = null;
let hasOlderMessages = false;
let loadingOlderMessages = false;

let explorerOpen = false;
let explorerSenderId = 'all';
let explorerDate = '';
let explorerTab = 'messages';
let explorerSearch = '';

const attachmentUrlCache = new Map();

/** Prepare a server message for safe, incremental receipt UI updates. */
function prepareMessageForUi(message) {
  const prepared = { ...message };
  const hasReceiptCoverage = Array.isArray(message.receipts) && message.receipts.length > 0;
  prepared.receipts = Array.isArray(message.receipts)
    ? message.receipts.map((receipt) => ({ ...receipt }))
    : [];
  // Trust the server's explicit flag. Legacy messages can acquire one receipt
  // when read, but that single row is not complete group coverage.
  prepared._receiptCoverageKnown = message._receiptCoverageKnown
    ?? message.receiptTrackingEnabled
    ?? hasReceiptCoverage;
  return prepared;
}

/** Merge duplicate/new-message payloads without regressing a read receipt. */
function mergeMessageUpdate(existing, incoming) {
  const merged = { ...existing, ...incoming };
  const receipts = new Map();
  for (const receipt of (existing.receipts || [])) {
    if (receipt?.userId) receipts.set(String(receipt.userId), { ...receipt });
  }
  for (const receipt of (incoming.receipts || [])) {
    if (!receipt?.userId) continue;
    const key = String(receipt.userId);
    const previous = receipts.get(key);
    receipts.set(key, {
      ...previous,
      ...receipt,
      status: previous?.status === 'read' || receipt.status === 'read' ? 'read' : 'unread',
      readAt: previous?.readAt || receipt.readAt || null,
    });
  }
  merged.receipts = [...receipts.values()];
  const statusRank = { sent: 0, delivered: 1, read: 2 };
  if ((statusRank[existing.status] ?? -1) > (statusRank[incoming.status] ?? -1)) {
    merged.status = existing.status;
  }
  const trackingFlag = incoming.receiptTrackingEnabled ?? existing.receiptTrackingEnabled;
  if (typeof trackingFlag === 'boolean') {
    merged.receiptTrackingEnabled = trackingFlag;
    merged._receiptCoverageKnown = trackingFlag;
  } else {
    merged._receiptCoverageKnown = Boolean(
      existing._receiptCoverageKnown || incoming._receiptCoverageKnown ||
      (Array.isArray(incoming.receipts) && incoming.receipts.length > 0)
    );
  }
  return merged;
}

/** Merge, de-duplicate, and chronologically order loaded/live message pages. */
function mergeAndSortMessages(...groups) {
  const unique = new Map();
  groups.flat().forEach((message) => {
    if (!message?.id) return;
    const id = String(message.id);
    unique.set(id, unique.has(id) ? mergeMessageUpdate(unique.get(id), message) : message);
  });
  return [...unique.values()].sort((a, b) => {
    const aTime = Date.parse(a.createdAt);
    const bTime = Date.parse(b.createdAt);
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** Apply a server message.read event to just that recipient's receipt row. */
function applyReadReceiptEvent(data) {
  if (!data?.messageId || !data?.userId) return;
  const msg = messages.find((item) => String(item.id) === String(data.messageId));
  if (!msg) return;
  if (data.conversationId && String(data.conversationId) !== String(msg.conversationId)) return;

  if (!Array.isArray(msg.receipts)) msg.receipts = [];
  const userId = String(data.userId);
  let receipt = msg.receipts.find((item) => String(item.userId) === userId);
  if (receipt) {
    receipt.status = 'read';
    receipt.readAt = receipt.readAt || data.readAt || null;
  } else {
    // We retain the event for legacy messages, but don't claim full group
    // coverage when the migrated database has no historic recipient rows.
    msg.receipts.push({ userId, status: 'read', readAt: data.readAt || null });
  }

  const conv = conversations.find(
    (item) => String(item.id) === String(msg.conversationId)
  );
  if (conv?.type === 'direct') msg.status = 'read';
  renderMessages();
}

/** Render group message read counts with a per-member tooltip. */
function renderGroupReceiptSummary(message, conversation) {
  if (!message._receiptCoverageKnown || !Array.isArray(message.receipts)) return '';
  const receipts = message.receipts.filter((receipt) => receipt?.userId);
  if (receipts.length === 0) return '';

  const participants = conversation?.participants || [];
  const participantName = (userId) => {
    const participant = participants.find(
      (item) => String(item.id) === String(userId)
    );
    return participant?.displayName || `Member ${String(userId).slice(0, 8)}`;
  };
  const readReceipts = receipts.filter((receipt) => receipt.status === 'read');
  const unreadReceipts = receipts.filter((receipt) => receipt.status !== 'read');
  const details = [];
  if (readReceipts.length) {
    details.push(`Read by: ${readReceipts.map((receipt) => participantName(receipt.userId)).join(', ')}`);
  }
  if (unreadReceipts.length) {
    details.push(`Not yet read by: ${unreadReceipts.map((receipt) => participantName(receipt.userId)).join(', ')}`);
  }
  const title = details.join(' | ') || 'No read receipts yet';
  const label = `${readReceipts.length} of ${receipts.length} recipients have read this message. ${title}`;
  return `<span class="message-read-summary" title="${escapeHtml(title)}" aria-label="${escapeHtml(label)}">${readReceipts.length}/${receipts.length} read</span>`;
}

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
    eventRouter.on(EventTypes.MESSAGE_NEW, (incomingMessage) => {
      if (!incomingMessage?.id || !incomingMessage?.conversationId) return;

      const msg = prepareMessageForUi(incomingMessage);
      const conversationId = String(msg.conversationId);
      const isIncoming = String(msg.senderId) !== String(currentUser.id);

      if (conversationId === String(activeConversationId)) {
        // The server fans message.new out to every participant, including the
        // sender. Upsert by ID so reconnects/echoes cannot duplicate bubbles.
        const existingIndex = messages.findIndex(
          (item) => String(item.id) === String(msg.id)
        );
        if (existingIndex >= 0) {
          messages[existingIndex] = mergeMessageUpdate(messages[existingIndex], msg);
        } else {
          messages.push(msg);
        }
        renderMessages();
        if (isIncoming) markMessageRead(msg.id).catch(() => {});
      } else {
        const conv = conversations.find(
          (item) => String(item.id) === conversationId
        );
        if (conv) {
          conv.lastMessage = msg;
          // A sender's own WebSocket echo must not increase their unread count.
          if (isIncoming) conv.unreadCount = (conv.unreadCount || 0) + 1;
          renderConversationList();
        }
      }
    }),
  );
  unsubscribeFns.push(
    eventRouter.on(EventTypes.MESSAGE_DELIVERED, (data) => {
      const msg = messages.find((m) => String(m.id) === String(data.messageId));
      if (msg) { msg.status = 'delivered'; renderMessages(); }
    }),
  );
  unsubscribeFns.push(
    eventRouter.on(EventTypes.MESSAGE_READ, (data) => {
      applyReadReceiptEvent(data);
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

  unsubscribeFns.push(
    eventRouter.on(EventTypes.PROFILE_UPDATED, (profile) => {
      handleProfileUpdated(profile);
    }),
  );
  unsubscribeFns.push(
  eventRouter.on(EventTypes.GROUP_UPDATED, (payload) => {
    handleGroupUpdated(payload);
    }),
  );
  unsubscribeFns.push(
    eventRouter.on('group.members_added', (payload) => {
      handleGroupMembersAdded(payload);
    }),
  );
  unsubscribeFns.push(
    eventRouter.on('group.members_removed', (payload) => {
      handleGroupMembersRemoved(payload);
    }),
  );
  unsubscribeFns.push(
    eventRouter.on('group.role_updated', (payload) => {
      handleGroupRoleUpdated(payload);
    }),
  );
}


/**
 * Apply a realtime profile update to conversations currently loaded in chat.
 */
function handleProfileUpdated(profile) {
  if (!profile || !profile.userId) return;

  const userId = String(profile.userId);
  const displayName =
    typeof profile.displayName === 'string' && profile.displayName.trim()
      ? profile.displayName.trim()
      : profile.username || 'Unknown';

  const avatarUrl =
    typeof profile.avatarUrl === 'string' ? profile.avatarUrl : '';

  let activeConversationAffected = false;

  conversations.forEach((conv) => {
    // Update the other participant's details in direct conversations.
    if (String(conv.participantId) === userId) {
      conv.participantName = displayName;
      conv.participantAvatar = avatarUrl;

      if (conv.id === activeConversationId) {
        activeConversationAffected = true;
      }
    }

    // Update the member's details in every group conversation.
    if (Array.isArray(conv.participants)) {
      conv.participants.forEach((participant) => {
        if (String(participant.id) === userId) {
          participant.displayName = displayName;
          participant.avatarUrl = avatarUrl;

          if (conv.id === activeConversationId) {
            activeConversationAffected = true;
          }
        }
      });
    }
  });

  // Re-render the list so updated names and avatars appear.
  renderConversationList();

  if (!activeConversationAffected) return;

  const activeConv = conversations.find(
    (conv) => conv.id === activeConversationId,
  );

  if (!activeConv) return;

  const nameEl = document.getElementById('chat-header-name');
  const avatarEl = document.getElementById('chat-header-avatar');

  if (activeConv.type === 'group') {
    // Preserve the group's name and avatar.
    const statusEl = document.getElementById('chat-header-status');

    if (statusEl && Array.isArray(activeConv.participants)) {
      const names = activeConv.participants
        .filter(
          (participant) =>
            String(participant.id) !== String(currentUser?.id),
        )
        .map(
          (participant) =>
            participant.displayName || participant.username || 'Unknown',
        );

      const visibleNames = names.slice(0, 3);
      const extraCount = names.length - visibleNames.length;

      statusEl.textContent =
        visibleNames.join(', ') +
        (extraCount > 0 ? ` +${extraCount} more` : '');

      statusEl.title = names.join(', ');
    }
  } else if (String(activeConv.participantId) === userId) {
    // Refresh the active direct-chat header.
    if (nameEl) nameEl.textContent = displayName;

    if (avatarEl) {
      renderPersonAvatar(avatarEl, displayName, avatarUrl);
    }
  }

  // Keep sender names current in an open group conversation.
  document
    .querySelectorAll('.group-message-sender')
    .forEach((senderEl) => {
      if (String(senderEl.dataset.senderId) === userId) {
        senderEl.textContent = displayName;
      }
    });
}

/** Apply a real-time group update to the conversation UI. */
function handleGroupUpdated(payload) {
  if (
    !payload ||
    !payload.conversationId ||
    typeof payload.name !== 'string'
  ) {
    return;
  }

  const conversationId = String(payload.conversationId);

  const conversation = conversations.find(
    (item) => String(item.id) === conversationId
  );

  if (!conversation || conversation.type !== 'group') {
    return;
  }

  conversation.name = payload.name;
  conversation.participantName = payload.name;

  if (payload.updatedAt) {
    conversation.updatedAt = payload.updatedAt;
  }

  // Update the conversation list.
  renderConversationList();

  // Update the open chat header, if this group is active.
  if (String(activeConversationId) === conversationId) {
    const headerName = document.getElementById('chat-header-name');

    if (headerName) {
      headerName.textContent = payload.name;
    }
  }

  // Update the open Group Info panel, if one is displayed.
  const groupInfoOverlay = document.getElementById('group-info-overlay');

  const groupInfoName = groupInfoOverlay?.querySelector(
    '.group-info-summary h3'
  );

  if (groupInfoName) {
    groupInfoName.textContent = payload.name;
  }
}

/** Apply a real-time group membership update. */
async function handleGroupMembersAdded(payload) {
  if (!payload || !payload.conversationId) return;

  const conversationId = String(payload.conversationId);

  let conversation = conversations.find(
    (item) => String(item.id) === conversationId
  );

  // A newly added user may not have this conversation loaded yet.
  if (!conversation) {
    const addedMemberIds = Array.isArray(payload.addedMemberIds)
      ? payload.addedMemberIds.map(String)
      : [];

    if (addedMemberIds.includes(String(currentUser?.id))) {
      await loadConversations();
    }

    return;
  }

  if (conversation.type !== 'group') return;

  // Apply the authoritative participant list returned by the backend.
  if (Array.isArray(payload.participants)) {
    conversation.participants = payload.participants;
  }

  if (typeof payload.name === 'string') {
    conversation.name = payload.name;
    conversation.participantName = payload.name;
  }

  if (payload.updatedAt) {
    conversation.updatedAt = payload.updatedAt;
  }

  renderConversationList();

  // Refresh the active chat header without reloading the page.
  if (String(activeConversationId) === conversationId) {
    const headerName = document.getElementById('chat-header-name');
    const statusEl = document.getElementById('chat-header-status');

    if (headerName) {
      headerName.textContent =
        conversation.name || conversation.participantName || 'Unnamed Group';
    }

    const participants = Array.isArray(conversation.participants)
      ? conversation.participants
      : [];

    const otherNames = participants
      .filter(
        (participant) =>
          String(participant.id) !== String(currentUser?.id)
      )
      .map(
        (participant) =>
          participant.displayName || participant.username || 'Unknown'
      );

    if (statusEl) {
      const visibleNames = otherNames.slice(0, 3);
      const extraCount = otherNames.length - visibleNames.length;

      statusEl.textContent = [
        `${participants.length} ${
          participants.length === 1 ? 'member' : 'members'
        }`,
        visibleNames.join(', ') +
          (extraCount > 0 ? ` +${extraCount} more` : ''),
      ].filter(Boolean).join(' · ');

      statusEl.title = otherNames.join(', ');
    }
  }

  // Refresh an open Group Info panel, but don't interrupt the add-members
  // form currently being used by the administrator.
  const overlay = document.getElementById('group-info-overlay');
  const addMembersPanel = document.getElementById('group-add-members-panel');

  if (overlay && addMembersPanel?.hidden !== false) {
    overlay.querySelector('.group-info-close')?.click();
    openGroupInfo(conversation);
  }
}


/** Apply a real-time group membership removal. */
async function handleGroupMembersRemoved(payload) {
  if (!payload?.conversationId || !payload?.removedMemberId) return;

  const conversationId = String(payload.conversationId);
  const removedMemberId = String(payload.removedMemberId);
  const currentUserWasRemoved = removedMemberId === String(currentUser?.id);

  if (currentUserWasRemoved) {
    // The REST response and WebSocket event can both report the same departure.
    const alreadyRemoved =
      !conversations.some((item) => String(item.id) === conversationId) &&
      String(activeConversationId) !== conversationId;
    if (alreadyRemoved) return;

    const removedName = payload.name || 'this group';

    document
      .getElementById('group-info-overlay')
      ?.querySelector('.group-info-close')
      ?.click();

    conversations = conversations.filter(
      (item) => String(item.id) !== conversationId
    );

    if (String(activeConversationId) === conversationId) {
      activeConversationId = null;
      messages = [];
      explorerOpen = false;
      explorerSenderId = 'all';
      explorerDate = '';
      explorerSearch = '';

      if (pendingAttachmentPreviewUrl) {
        URL.revokeObjectURL(pendingAttachmentPreviewUrl);
        pendingAttachmentPreviewUrl = null;
      }
      pendingAttachment = null;

      const chatArea = document.getElementById('chat-area');
      if (chatArea) {
        chatArea.classList.remove('has-message-explorer');
        chatArea.innerHTML = `
          <div class="chat-empty-state">
            <i class="bi bi-chat-dots" aria-hidden="true"></i>
            <p>Select a conversation to start chatting</p>
          </div>`;
      }
    }

    renderConversationList();
    window.alert(payload.leftBySelf ? `You left "${removedName}".` : `You were removed from "${removedName}".`);
    return;
  }

  const conversation = conversations.find(
    (item) => String(item.id) === conversationId
  );

  if (!conversation || conversation.type !== 'group') {
    await loadConversations();
    return;
  }

  if (Array.isArray(payload.participants)) {
    conversation.participants = payload.participants;
  }
  if (typeof payload.name === 'string') {
    conversation.name = payload.name;
    conversation.participantName = payload.name;
  }
  if (payload.updatedAt) {
    conversation.updatedAt = payload.updatedAt;
  }

  renderConversationList();

  if (String(activeConversationId) === conversationId) {
    const headerName = document.getElementById('chat-header-name');
    const statusEl = document.getElementById('chat-header-status');
    const participants = Array.isArray(conversation.participants)
      ? conversation.participants
      : [];
    const otherNames = participants
      .filter((participant) => String(participant.id) !== String(currentUser?.id))
      .map((participant) => participant.displayName || participant.username || 'Unknown');

    if (headerName) {
      headerName.textContent = conversation.name || conversation.participantName || 'Unnamed Group';
    }
    if (statusEl) {
      const visibleNames = otherNames.slice(0, 3);
      const extraCount = otherNames.length - visibleNames.length;
      statusEl.textContent = [
        `${participants.length} ${participants.length === 1 ? 'member' : 'members'}`,
        visibleNames.join(', ') + (extraCount > 0 ? ` +${extraCount} more` : ''),
      ].filter(Boolean).join(' · ');
      statusEl.title = otherNames.join(', ');
    }
  }

  const overlay = document.getElementById('group-info-overlay');
  const addMembersPanel = overlay?.querySelector('#group-add-members-panel');
  if (overlay && addMembersPanel?.hidden !== false) {
    overlay.querySelector('.group-info-close')?.click();
    openGroupInfo(conversation);
  }
}


/** Apply real-time group administrator transfer to the conversation UI. */
async function handleGroupRoleUpdated(payload) {
  if (!payload?.conversationId || !Array.isArray(payload.participants)) return;

  const conversationId = String(payload.conversationId);
  let conversation = conversations.find(
    (item) => String(item.id) === conversationId
  );

  if (!conversation) {
    await loadConversations();
    conversation = conversations.find(
      (item) => String(item.id) === conversationId
    );
  }
  if (!conversation || conversation.type !== 'group') return;

  conversation.participants = payload.participants;
  if (typeof payload.name === 'string') {
    conversation.name = payload.name;
    conversation.participantName = payload.name;
  }
  if (payload.updatedAt) conversation.updatedAt = payload.updatedAt;

  renderConversationList();

  if (String(activeConversationId) === conversationId) {
    const headerName = document.getElementById('chat-header-name');
    const statusEl = document.getElementById('chat-header-status');
    const names = payload.participants
      .filter((participant) => String(participant.id) !== String(currentUser?.id))
      .map((participant) => participant.displayName || participant.username || 'Unknown');
    const visibleNames = names.slice(0, 3);
    const extraCount = names.length - visibleNames.length;

    if (headerName) headerName.textContent = conversation.name || 'Unnamed Group';
    if (statusEl) {
      statusEl.textContent = [
        `${payload.participants.length} ${payload.participants.length === 1 ? 'member' : 'members'}`,
        visibleNames.join(', ') + (extraCount > 0 ? ` +${extraCount} more` : ''),
      ].filter(Boolean).join(' · ');
      statusEl.title = names.join(', ');
    }
  }

  // Re-render Group Info so admin-only controls immediately follow the new role.
  const overlay = document.getElementById('group-info-overlay');
  const addMembersPanel = overlay?.querySelector('#group-add-members-panel');
  if (overlay && addMembersPanel?.hidden !== false) {
    overlay.querySelector('.group-info-close')?.click();
    openGroupInfo(conversation);
  }
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
        <div class="flex-grow-1">
        <strong>New Chat</strong>
        <div class="small text-muted">Start a conversation or create a group</div>
          </div>

          <button
            type="button"
            id="new-group-btn"
            class="btn btn-sm btn-outline-primary"
          >
            <i class="bi bi-people"></i>
            Create Group
          </button>
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

  document
  .getElementById('new-group-btn')
  .addEventListener('click', openGroupCreation);

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



/** Render the group-creation interface. */
function openGroupCreation() {
  const listEl = document.getElementById('conversation-list');

  const selectedUsers = new Map();

  listEl.innerHTML = `
    <div class="p-3">
      <div class="d-flex align-items-center mb-3">
        <button
          type="button"
          id="group-create-back"
          class="btn btn-sm btn-outline-secondary me-2"
          aria-label="Back to chats"
        >
          <i class="bi bi-arrow-left"></i>
        </button>

        <strong>Create Group</strong>
      </div>

      <label for="group-name" class="form-label">Group name</label>

      <input
        id="group-name"
        type="text"
        class="form-control mb-3"
        maxlength="100"
        placeholder="Enter a group name"
        autocomplete="off"
      />

      <label for="group-user-search" class="form-label">
        Add participants
      </label>

      <input
        id="group-user-search"
        type="search"
        class="form-control"
        placeholder="Search by name or username..."
        autocomplete="off"
      />

      <div id="group-selected-users" class="mt-3"></div>

      <div id="group-user-results" class="mt-3"></div>

      <div id="group-create-error" class="text-danger small mt-2"></div>

      <button
        type="button"
        id="group-create-submit"
        class="btn btn-primary w-100 mt-3"
        disabled
      >
        <i class="bi bi-people"></i>
        Create Group
      </button>
    </div>
  `;

  const nameInput = document.getElementById('group-name');
  const searchInput = document.getElementById('group-user-search');
  const selectedEl = document.getElementById('group-selected-users');
  const resultsEl = document.getElementById('group-user-results');
  const errorEl = document.getElementById('group-create-error');
  const submitButton = document.getElementById('group-create-submit');

  document
    .getElementById('group-create-back')
    .addEventListener('click', openNewChatSearch);

  function renderSelectedUsers() {
    if (selectedUsers.size === 0) {
      selectedEl.innerHTML = `
        <div class="small text-muted">No participants selected.</div>
      `;
    } else {
      selectedEl.innerHTML = `
        <div class="small fw-semibold mb-2">
          Selected participants (${selectedUsers.size})
        </div>

        <div class="d-flex flex-wrap gap-2">
          ${[...selectedUsers.values()].map((user) => `
            <button
              type="button"
              class="btn btn-sm btn-outline-secondary"
              data-remove-group-user="${escapeHtml(user.id)}"
              aria-label="Remove ${escapeHtml(user.displayName)}"
            >
              ${escapeHtml(user.displayName)}
              <i class="bi bi-x"></i>
            </button>
          `).join('')}
        </div>
      `;
    }

    selectedEl
      .querySelectorAll('[data-remove-group-user]')
      .forEach((button) => {
        button.addEventListener('click', () => {
          selectedUsers.delete(button.dataset.removeGroupUser);
          errorEl.textContent = '';
          renderSelectedUsers();
          renderUserResults();
        });
      });

    submitButton.disabled =
      !nameInput.value.trim() ||
      selectedUsers.size < 1;
  }

  function renderUserResults(users = []) {
    resultsEl.innerHTML = users.map((user) => {
      const selected = selectedUsers.has(user.id);

      return `
        <button
          type="button"
          class="w-100 border-0 bg-transparent text-start p-2 d-flex align-items-center"
          data-group-user-id="${escapeHtml(user.id)}"
          ${selected ? 'disabled' : ''}
        >
          <div
            class="avatar avatar-sm me-2"
            style="background-color:${avatarColor(user.displayName)}"
          >
            ${getInitials(user.displayName)}
          </div>

          <div class="flex-grow-1">
            <div class="fw-semibold">
              ${escapeHtml(user.displayName)}
            </div>
            <div class="text-muted small">
              @${escapeHtml(user.username || '')}
            </div>
          </div>

          <i class="bi ${selected ? 'bi-check-circle-fill' : 'bi-plus-circle'}"></i>
        </button>
      `;
    }).join('');

    resultsEl
      .querySelectorAll('[data-group-user-id]')
      .forEach((button) => {
        button.addEventListener('click', () => {
          const user = users.find(
            (item) => item.id === button.dataset.groupUserId
          );

          if (!user || selectedUsers.has(user.id)) return;

          selectedUsers.set(user.id, user);
          errorEl.textContent = '';

          renderSelectedUsers();
          renderUserResults(users);
        });
      });
  }

  const searchUsersDebounced = debounce(async (event) => {
    const query = event.target.value.trim();

    errorEl.textContent = '';

    if (!query) {
      resultsEl.innerHTML = '';
      return;
    }

    resultsEl.innerHTML = `
      <div class="small text-muted">Searching...</div>
    `;

    try {
      const users = await searchUsers(query);

      if (!users.length) {
        resultsEl.innerHTML = `
          <div class="small text-muted">No users found.</div>
        `;
        return;
      }

      // Exclude the logged-in user from selectable participants.
      const eligibleUsers = users.filter(
        (user) => user.id !== currentUser.id
      );

      renderUserResults(eligibleUsers);
    } catch (error) {
      console.error('[chat] Group participant search failed:', error);

      resultsEl.innerHTML = `
        <div class="text-danger small">
          Could not search users. Please try again.
        </div>
      `;
    }
  }, 300);

  searchInput.addEventListener('input', searchUsersDebounced);

  nameInput.addEventListener('input', renderSelectedUsers);

  submitButton.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    const participantIds = [...selectedUsers.keys()];

    if (!name) {
      errorEl.textContent = 'Enter a group name.';
      nameInput.focus();
      return;
    }

    if (participantIds.length < 1) {
      errorEl.textContent = 'Select at least two other people.';
      return;
    }

    submitButton.disabled = true;
    submitButton.innerHTML = `
      <span class="spinner-border spinner-border-sm me-2"></span>
      Creating group...
    `;

    errorEl.textContent = '';

    try {
      const conversation = await createGroupConversation(
        name,
        participantIds
      );

      await loadConversations();
      await openConversation(conversation.id);
    } catch (error) {
      console.error('[chat] Group creation failed:', error);

      errorEl.textContent =
        error.message || 'Could not create the group. Please try again.';

      submitButton.innerHTML = `
        <i class="bi bi-people"></i>
        Create Group
      `;

      renderSelectedUsers();
    }
  });

  renderSelectedUsers();
  nameInput.focus();
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
/** Render direct and group conversations distinctly. */
function renderConversationList() {
  const listEl = document.getElementById('conversation-list');

  if (!conversations || conversations.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <i class="bi bi-chat-square-text"></i>
        <p>No conversations yet</p>
      </div>
    `;
    return;
  }

  listEl.innerHTML = conversations
    .map((conv) => {
      const isActive = conv.id === activeConversationId;
      const isGroup = conv.type === 'group';

      const displayName = isGroup
        ? (conv.name || conv.participantName || 'Unnamed Group')
        : (conv.participantName || 'Unknown');

      const participants = Array.isArray(conv.participants)
        ? conv.participants
        : [];

      const memberCount = participants.length;

      const initials = getInitials(displayName);
      const color = avatarColor(displayName);
      const lastMsg = conv.lastMessage;

      let previewText = isGroup && memberCount > 0
        ? `<span class="text-muted">${memberCount} members · No messages yet</span>`
        : '<span class="text-muted">No messages yet</span>';

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

          const hasCaption =
            caption !== '' &&
            caption.toLowerCase() !== 'message';

          const previewLabel = hasCaption
            ? escapeHtml(caption)
            : escapeHtml(label);

          previewText = `${icon} ${previewLabel}`;
        } else if (
          caption &&
          caption.toLowerCase() !== 'message'
        ) {
          previewText = escapeHtml(caption);
        } else {
          previewText = '<span class="text-muted">Message</span>';
        }

        // Prefix the latest message with its sender in group chats.
        if (isGroup) {
          const sender = participants.find(
            (participant) => participant.id === lastMsg.senderId
          );

          const senderName =
            lastMsg.senderId === currentUser?.id
              ? 'You'
              : sender?.displayName;

          if (senderName) {
            previewText = `
              <span class="conversation-sender-prefix">
                ${escapeHtml(senderName)}:
              </span>
              ${previewText}
            `;
          }
        }
      }

      const lastMsgTime = lastMsg
        ? formatDate(lastMsg.createdAt)
        : '';

      const unread = conv.unreadCount > 0
        ? `
          <span class="badge bg-primary rounded-pill">
            ${conv.unreadCount}
          </span>
        `
        : '';

      const avatar = isGroup
        ? `
          <div
            class="avatar conversation-group-avatar"
            aria-hidden="true"
          >
            <i class="bi bi-people-fill"></i>
          </div>
        `
        : `<div
          class="avatar conversation-person-avatar"
          style="background-color:${color}"
        >
          ${initials}
        </div>`;

      return `
        <div
          class="conversation-item ${isActive ? 'active' : ''}"
          data-conversation-id="${escapeHtml(conv.id)}"
          role="button"
          tabindex="0"
          aria-label="Open ${isGroup ? 'group' : 'conversation'}: ${escapeHtml(displayName)}"
        >
          ${avatar}

          <div class="conversation-meta">
            <div class="conversation-top-row">
              <div class="conversation-name-wrap">
                <span class="conversation-name">
                  ${escapeHtml(displayName)}
                </span>

                ${
                  isGroup
                    ? '<span class="conversation-kind">GROUP</span>'
                    : ''
                }
              </div>

              <span class="conversation-time">
                ${lastMsgTime}
              </span>
            </div>

            <div class="conversation-bottom-row">
              <span class="conversation-preview">
                ${previewText}
              </span>

              ${unread}
            </div>
          </div>
        </div>
      `;
    })
    .join('');

    // Load real profile pictures for direct conversations.
  listEl.querySelectorAll('.conversation-item').forEach((item) => {
    const conversation = conversations.find(
      (conv) => conv.id === item.dataset.conversationId
    );

    const avatarElement = item.querySelector(
      '.conversation-person-avatar'
    );

    if (!conversation || !avatarElement) return;

    renderPersonAvatar(
      avatarElement,
      conversation.participantName,
      conversation.participantAvatar
    );
  });

  listEl.querySelectorAll('.conversation-item').forEach((el) => {
    el.addEventListener('click', () => {
      openConversation(el.dataset.conversationId);
    });

    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openConversation(el.dataset.conversationId);
      }
    });
  });
}

/**
 * Render a user's profile picture with a safe initials fallback.
 *
 * The avatar URL comes from the backend profile record.
 * Failed image loads gracefully fall back to initials.
 */
function renderPersonAvatar(element, displayName, avatarUrl) {
  if (!element) return;

  const name = displayName || 'Unknown';
  const initials = getInitials(name);

  element.classList.remove('conversation-group-avatar');
  element.style.backgroundColor = avatarColor(name);
  element.style.overflow = 'hidden';
  element.replaceChildren();
  element.textContent = initials;
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', `${name}'s profile picture`);

  if (!avatarUrl || typeof avatarUrl !== 'string') {
    return;
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(avatarUrl, window.location.origin);
  } catch {
    return;
  }

  // Profile avatars must use HTTPS, except for same-origin local development.
  if (
    parsedUrl.protocol !== 'https:' &&
    parsedUrl.origin !== window.location.origin
  ) {
    return;
  }

  const image = new Image();

  image.alt = '';
  image.className = 'avatar-image';
  image.loading = 'eager';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';

  image.addEventListener('load', () => {
    element.replaceChildren(image);
  }, { once: true });

  image.addEventListener('error', () => {
    element.replaceChildren();
    element.textContent = initials;
  }, { once: true });

  image.src = parsedUrl.href;
}

/** Open a conversation and load its messages. */
async function openConversation(conversationId) {
  activeConversationId = conversationId;

  document
    .querySelector('.chat-shell')
    ?.classList.add('has-active-conversation');

  const selectedConversation = conversations.find(
    (conversation) => String(conversation.id) === String(conversationId)
  );
  // Calling is one-to-one only; never show call controls for group conversations.
  const callTargetUserId = selectedConversation && selectedConversation.type !== 'group'
    && selectedConversation.participantId
    ? String(selectedConversation.participantId)
    : null;
  const callTargetName = selectedConversation?.participantName || 'contact';
  renderConversationList();
  const chatArea = document.getElementById('chat-area');
  chatArea.innerHTML = `
    <div class="chat-header" id="chat-header">
    <div class="chat-header-info">
      <button
        type="button"
        id="chat-back-btn"
        class="chat-back-btn btn btn-sm btn-link"
        aria-label="Back to conversations"
        title="Back to conversations"
      >
        <i class="bi bi-arrow-left" aria-hidden="true"></i>
      </button>

      <div class="avatar" id="chat-header-avatar"></div>
        <div>
          <div class="chat-header-name" id="chat-header-name">Loading...</div>
          <div class="chat-header-status" id="chat-header-status">...</div>
        </div>
      </div>

      ${callTargetUserId ? `
        <div class="chat-header-call-actions" role="group" aria-label="Call controls">
          <button
            id="chat-audio-call-btn"
            class="btn btn-sm btn-link"
            type="button"
            aria-label="Audio call ${escapeHtml(callTargetName)}"
            title="Audio call"
          >
            <i class="bi bi-telephone" aria-hidden="true"></i>
          </button>
          <button
            id="chat-video-call-btn"
            class="btn btn-sm btn-link"
            type="button"
            aria-label="Video call ${escapeHtml(callTargetName)}"
            title="Video call"
          >
            <i class="bi bi-camera-video" aria-hidden="true"></i>
          </button>
        </div>
      ` : ''}

      <button
        id="group-info-btn"
        class="btn btn-sm btn-link"
        type="button"
        aria-label="Group information"
        title="Group information"
        hidden
      >
        <i class="bi bi-info-circle"></i>
      </button>

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

    document
  .getElementById('chat-back-btn')
  ?.addEventListener('click', () => {
    document
      .querySelector('.chat-shell')
      ?.classList.remove('has-active-conversation');
  });

    const conv = conversations.find((c) => c.id === conversationId);

    if (conv) {
      const isGroup = conv.type === 'group';

            const groupInfoBtn = document.getElementById('group-info-btn');

      if (groupInfoBtn && isGroup) {
        groupInfoBtn.hidden = false;
        groupInfoBtn.addEventListener('click', () => {
          openGroupInfo(conv);
        });
      }

      const displayName = isGroup
      
        ? (conv.name || conv.participantName || 'Unnamed Group')
        : (conv.participantName || 'Unknown');

      const nameEl = document.getElementById('chat-header-name');
      const avatarEl = document.getElementById('chat-header-avatar');
      const statusEl = document.getElementById('chat-header-status');

      nameEl.textContent = displayName;

      if (isGroup) {
        // Display a group icon instead of an individual's initials.
        avatarEl.classList.add('conversation-group-avatar');
        avatarEl.innerHTML = '<i class="bi bi-people-fill" aria-hidden="true"></i>';
        avatarEl.setAttribute('aria-label', 'Group conversation');

        // Use the participants supplied by the backend.
        const participants = Array.isArray(conv.participants)
          ? conv.participants
          : [];

        const participantNames = participants
          .map((participant) =>
            (participant.displayName || participant.username || '').trim()
          )
          .filter(Boolean);

        const memberCount = participants.length;
        const visibleNames = participantNames.slice(0, 3);
        const additionalCount = Math.max(
          participantNames.length - visibleNames.length,
          0
        );

        let memberSummary = visibleNames.join(', ');

        if (additionalCount > 0) {
          memberSummary += ` +${additionalCount} more`;
        }

        // Example: "3 members · Amaan, Ishwarsingh, Shivratn"
        statusEl.textContent = [
          `${memberCount} ${memberCount === 1 ? 'member' : 'members'}`,
          memberSummary,
        ].filter(Boolean).join(' · ');

        // Expose the complete names when the subtitle is truncated.
        statusEl.title = participantNames.join(', ');
        statusEl.setAttribute('aria-label', statusEl.textContent);
      } else {
        // Preserve the existing direct-chat avatar behavior.
        // Display the contact's profile picture, with initials as fallback.
        renderPersonAvatar(
          avatarEl,
          displayName,
          conv.participantAvatar
        );
        // Presence applies to individual conversations, not groups.
        statusEl.textContent = '';

        if (conv.participantId) {
          try {
            const presence = await getPresence(conv.participantId);

            if (presence.presence === 'online') {
              statusEl.innerHTML =
                '<span class="presence-dot online"></span> Online';
            } else {
              statusEl.textContent =
                `Last seen ${formatLastSeen(presence.lastSeen)}`;
            }
          } catch (error) {
            // A presence lookup failure must not prevent the chat from opening.
            statusEl.textContent = '';
          }
        }
      }

      conv.unreadCount = 0;
      renderConversationList();
    }

  await loadMessages(conversationId);

  document.getElementById('message-explorer-btn')?.addEventListener('click', () => {
    openMessageExplorer('all');
  });

  // Reuse the shared call controller so chat-header calls follow the same
  // authenticated REST lifecycle, WebSocket signaling, and media cleanup.
  document.getElementById('chat-audio-call-btn')?.addEventListener('click', () => {
    void startOutgoingCall(callTargetUserId, 'audio');
  });
  document.getElementById('chat-video-call-btn')?.addEventListener('click', () => {
    void startOutgoingCall(callTargetUserId, 'video');
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
/** Display information about a group conversation. */
function openGroupInfo(conversation) {
  if (!conversation || conversation.type !== 'group') return;

  // Remove any previously opened panel.
  document.getElementById('group-info-overlay')?.remove();

  const participants = Array.isArray(conversation.participants)
    ? conversation.participants
    : [];

  const groupName =
    conversation.name || conversation.participantName || 'Unnamed Group';

  const currentMembership = participants.find(
  (participant) => String(participant.id) === String(currentUser?.id)
  );

  const canRename =
    String(currentMembership?.role).toLowerCase() === 'admin';


  const overlay = document.createElement('div');
  overlay.id = 'group-info-overlay';
  overlay.className = 'group-info-overlay';

  overlay.innerHTML = `
    <section
      class="group-info-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="group-info-title"
      tabindex="-1"
    >
      <header class="group-info-header">
        <h2 id="group-info-title">Group Info</h2>

        <button
          type="button"
          class="group-info-close"
          aria-label="Close group information"
        >
          <i class="bi bi-x-lg" aria-hidden="true"></i>
        </button>
      </header>

      <div class="group-info-body">
        <div class="group-info-summary">
          <div class="group-info-icon" aria-hidden="true">
            <i class="bi bi-people-fill"></i>
          </div>

          <h3>${escapeHtml(groupName)}</h3>

          <p>
            ${participants.length}
            ${participants.length === 1 ? 'member' : 'members'}
          </p>
        </div>
                ${
                canRename
                  ? `
                    <div class="d-grid gap-2 mb-4">
                      <button
                        type="button"
                        id="group-info-rename-btn"
                        class="btn btn-outline-primary"
                      >
                        <i class="bi bi-pencil me-2"></i>
                        Rename Group
                      </button>

                      <button
                        type="button"
                        id="group-info-add-members-btn"
                        class="btn btn-outline-primary"
                      >
                        <i class="bi bi-person-plus me-2"></i>
                        Add Members
                      </button>
                    </div>
                  `
                  : ''
                }
                <div class="d-grid gap-2 mb-4">
                  <button
                    type="button"
                    id="group-info-leave-btn"
                    class="btn btn-outline-danger"
                  >
                    <i class="bi bi-box-arrow-left me-2"></i>
                    Leave Group
                  </button>
                  ${canRename ? '<div class="small text-muted">Transfer admin rights to another member before leaving.</div>' : ''}
                </div>
                <div id="group-add-members-panel" class="mb-4" hidden>
            <label for="group-add-members-search" class="form-label">
              Search for people
            </label>

            <input
              id="group-add-members-search"
              type="search"
              class="form-control"
              placeholder="Search by name or username..."
              autocomplete="off"
            />

            <div
              id="group-add-members-error"
              class="small text-danger mt-2"
              role="status"
              aria-live="polite"
            ></div>

            <div id="group-add-members-selected" class="mt-3"></div>

            <div id="group-add-members-results" class="mt-3"></div>

            <div class="d-flex gap-2 mt-3">
              <button
                type="button"
                id="group-add-members-submit"
                class="btn btn-primary flex-grow-1"
                disabled
              >
                <i class="bi bi-person-plus me-1"></i>
                Add Selected
              </button>

              <button
                type="button"
                id="group-add-members-cancel"
                class="btn btn-outline-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        
        <h4 class="group-info-members-title">Members</h4>

        <div class="group-info-member-list">
          ${
            participants.length
              ? participants.map((participant) => {
                  const name =
                    participant.displayName ||
                    participant.username ||
                    'Unknown';

                  const isCurrentUser =
                    String(participant.id) === String(currentUser?.id);

                  const role =
                    String(participant.role).toLowerCase() === 'admin'
                      ? 'Admin'
                      : 'Member';

                  return `
                    <div class="group-info-member">
                      <div
                        class="avatar avatar-sm group-info-member-avatar"
                        data-group-info-member-id="${escapeHtml(participant.id)}"
                        style="background-color:${avatarColor(name)}"
                      >
                        ${escapeHtml(getInitials(name))}
                      </div>

                      <div class="group-info-member-details">
                        <div class="group-info-member-name">
                          ${escapeHtml(name)}
                          ${
                            isCurrentUser
                              ? '<span class="group-info-you-label">You</span>'
                              : ''
                          }
                        </div>
                      </div>

                      <span
                        class="group-info-role ${
                          role === 'Admin' ? 'group-info-role-admin' : ''
                        }"
                      >
                        ${role}
                      </span>
                      ${
                        canRename && !isCurrentUser && role === 'Member'
                          ? `
                            <button
                              type="button"
                              class="btn btn-sm btn-outline-primary ms-2"
                              data-transfer-group-admin="${escapeHtml(participant.id)}"
                              aria-label="Transfer administration to ${escapeHtml(name)}"
                              title="Make admin and transfer administration"
                            >
                              <i class="bi bi-shield-check" aria-hidden="true"></i>
                            </button>
                            <button
                              type="button"
                              class="btn btn-sm btn-outline-danger ms-1"
                              data-remove-group-member="${escapeHtml(participant.id)}"
                              aria-label="Remove ${escapeHtml(name)} from group"
                              title="Remove member"
                            >
                              <i class="bi bi-person-dash" aria-hidden="true"></i>
                            </button>
                          `
                          : ''
                      }
                    </div>
                  `;
                }).join('')
              : '<p class="text-muted">No members found.</p>'
          }
        </div>
      </div>
    </section>
  `;

  document.body.appendChild(overlay);

  // Render participant profile photos using the existing avatar function.
  participants.forEach((participant) => {
    const avatarElement = Array.from(
      overlay.querySelectorAll('[data-group-info-member-id]')
    ).find(
      (element) =>
        element.dataset.groupInfoMemberId === String(participant.id)
    );

    if (avatarElement) {
      renderPersonAvatar(
        avatarElement,
        participant.displayName || participant.username || 'Unknown',
        participant.avatarUrl
      );
    }
  });

  const closePanel = () => {
    overlay.remove();
    document.removeEventListener('keydown', handleEscape);
  };

  const renameButton = overlay.querySelector('#group-info-rename-btn');

renameButton?.addEventListener('click', async () => {
  const newName = window.prompt('Enter the new group name:', groupName);

  if (newName === null) return;

  const trimmedName = newName.trim();

  if (!trimmedName) {
    window.alert('Group name cannot be empty.');
    return;
  }

  if (trimmedName.length > 100) {
    window.alert('Group name cannot exceed 100 characters.');
    return;
  }

  renameButton.disabled = true;

  try {
    const updatedConversation = await renameGroupConversation(
      conversation.id,
      trimmedName
    );

    conversation.name = updatedConversation.name || trimmedName;
    conversation.participantName = conversation.name;
    conversation.updatedAt =
      updatedConversation.updatedAt || new Date().toISOString();

    renderConversationList();

    if (activeConversationId === conversation.id) {
      const headerName = document.getElementById('chat-header-name');

      if (headerName) {
        headerName.textContent = conversation.name;
      }
    }

    closePanel();
    openGroupInfo(conversation);
  } catch (error) {
    window.alert(error.message || 'Could not rename the group.');
  } finally {
    if (renameButton.isConnected) {
      renameButton.disabled = false;
    }
  }
});
const addMembersButton = overlay.querySelector(
  '#group-info-add-members-btn'
);

const addMembersPanel = overlay.querySelector(
  '#group-add-members-panel'
);

const addMembersSearch = overlay.querySelector(
  '#group-add-members-search'
);

const addMembersResults = overlay.querySelector(
  '#group-add-members-results'
);

const addMembersSelected = overlay.querySelector(
  '#group-add-members-selected'
);

const addMembersError = overlay.querySelector(
  '#group-add-members-error'
);

const addMembersSubmit = overlay.querySelector(
  '#group-add-members-submit'
);

const addMembersCancel = overlay.querySelector(
  '#group-add-members-cancel'
);

const existingMemberIds = new Set(
  participants.map((participant) => String(participant.id))
);

const remainingCapacity = Math.max(0, 101 - participants.length);
const selectedMembers = new Map();

let displayedUsers = [];
let searchRequestNumber = 0;

function renderSelectedMembers() {
  if (selectedMembers.size === 0) {
    addMembersSelected.innerHTML =
      '<div class="small text-muted">No people selected.</div>';
  } else {
    addMembersSelected.innerHTML = `
      <div class="small fw-semibold mb-2">
        Selected (${selectedMembers.size})
      </div>

      <div class="d-flex flex-wrap gap-2">
        ${[...selectedMembers.values()].map((user) => `
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            data-remove-added-member="${escapeHtml(user.id)}"
          >
            ${escapeHtml(user.displayName || user.username || 'Unknown')}
            <i class="bi bi-x"></i>
          </button>
        `).join('')}
      </div>
    `;
  }

  addMembersSelected
    .querySelectorAll('[data-remove-added-member]')
    .forEach((button) => {
      button.addEventListener('click', () => {
        selectedMembers.delete(button.dataset.removeAddedMember);
        addMembersError.textContent = '';

        renderSelectedMembers();
        renderAvailableUsers(displayedUsers);
      });
    });

  addMembersSubmit.disabled =
    selectedMembers.size === 0 ||
    selectedMembers.size > remainingCapacity;
}

function renderAvailableUsers(users = []) {
  displayedUsers = users;

  addMembersResults.innerHTML = users.length
    ? users.map((user) => {
        const id = String(user.id);
        const isSelected = selectedMembers.has(id);

        return `
          <button
            type="button"
            class="w-100 border-0 bg-transparent text-start p-2 d-flex align-items-center"
            data-add-member-user-id="${escapeHtml(id)}"
            ${isSelected ? 'disabled' : ''}
          >
            <div
              class="avatar avatar-sm me-2"
              style="background-color:${avatarColor(user.displayName || user.username || 'Unknown')}"
              aria-hidden="true"
            >
              ${escapeHtml(getInitials(user.displayName || user.username || 'Unknown'))}
            </div>

            <div class="flex-grow-1">
              <div class="fw-semibold">
                ${escapeHtml(user.displayName || 'Unknown')}
              </div>
              <div class="small text-muted">
                @${escapeHtml(user.username || '')}
              </div>
            </div>

            <i class="bi ${
              isSelected ? 'bi-check-circle-fill' : 'bi-plus-circle'
            }"></i>
          </button>
        `;
      }).join('')
    : '<div class="small text-muted">No eligible users found.</div>';

  addMembersResults
    .querySelectorAll('[data-add-member-user-id]')
    .forEach((button) => {
      button.addEventListener('click', () => {
        const user = displayedUsers.find(
          (item) => String(item.id) === button.dataset.addMemberUserId
        );

        if (!user || selectedMembers.has(String(user.id))) return;

        if (selectedMembers.size >= remainingCapacity) {
          addMembersError.textContent =
            'This group has reached its membership limit.';
          return;
        }

        selectedMembers.set(String(user.id), user);
        addMembersError.textContent = '';

        renderSelectedMembers();
        renderAvailableUsers(displayedUsers);
      });
    });
}

addMembersButton?.addEventListener('click', () => {
  addMembersPanel.hidden = false;
  addMembersButton.hidden = true;

  if (remainingCapacity === 0) {
    addMembersError.textContent =
      'This group has reached the 101-member limit.';
    addMembersSubmit.disabled = true;
  }

  addMembersSearch.focus();
});

addMembersCancel?.addEventListener('click', () => {
  addMembersPanel.hidden = true;
  addMembersButton.hidden = false;
  addMembersError.textContent = '';
  addMembersSearch.value = '';
  addMembersResults.innerHTML = '';
  selectedMembers.clear();
  displayedUsers = [];

  renderSelectedMembers();
});

addMembersSearch?.addEventListener(
  'input',
  debounce(async (event) => {
    const query = event.target.value.trim();
    const requestNumber = ++searchRequestNumber;

    addMembersError.textContent = '';

    if (!query) {
      renderAvailableUsers([]);
      return;
    }

    addMembersResults.innerHTML =
      '<div class="small text-muted">Searching...</div>';

    try {
      const users = await searchUsers(query);

      // Ignore responses from older searches.
      if (requestNumber !== searchRequestNumber || !addMembersPanel.isConnected) {
        return;
      }

      const eligibleUsers = users.filter((user) => {
        const id = String(user.id);

        return (
          id !== String(currentUser?.id) &&
          !existingMemberIds.has(id)
        );
      });

      renderAvailableUsers(eligibleUsers);
    } catch (error) {
      if (requestNumber !== searchRequestNumber) return;

      console.error('[chat] Add-member search failed:', error);

      addMembersResults.innerHTML =
        '<div class="small text-danger">Search failed. Please try again.</div>';
    }
  }, 300)
);

addMembersSubmit?.addEventListener('click', async () => {
  const participantIds = [...selectedMembers.keys()];

  if (!participantIds.length) {
    addMembersError.textContent = 'Select at least one person.';
    return;
  }

  if (participantIds.length > remainingCapacity) {
    addMembersError.textContent =
      'The selected members exceed the group size limit.';
    return;
  }

  addMembersSubmit.disabled = true;
  addMembersSubmit.innerHTML = `
    <span class="spinner-border spinner-border-sm me-2"></span>
    Adding members...
  `;

  addMembersError.textContent = '';

  try {
    const updatedConversation = await addGroupParticipants(
      conversation.id,
      participantIds
    );

    if (Array.isArray(updatedConversation.participants)) {
      conversation.participants = updatedConversation.participants;
    }

    if (typeof updatedConversation.name === 'string') {
      conversation.name = updatedConversation.name;
      conversation.participantName = updatedConversation.name;
    }

    if (updatedConversation.updatedAt) {
      conversation.updatedAt = updatedConversation.updatedAt;
    }

    renderConversationList();

    // Rebuild Group Info from the updated authoritative participant list.
    closePanel();
    openGroupInfo(conversation);
  } catch (error) {
    console.error('[chat] Adding group members failed:', error);

    addMembersError.textContent =
      error.message || 'Could not add members. Please try again.';
  } finally {
    if (addMembersSubmit.isConnected) {
      addMembersSubmit.innerHTML = `
        <i class="bi bi-person-plus me-1"></i>
        Add Selected
      `;

      addMembersSubmit.disabled =
        selectedMembers.size === 0 ||
        selectedMembers.size > remainingCapacity;
    }
  }
});


  // Admins can remove regular members, but never themselves or another admin.
  overlay.querySelectorAll('[data-remove-group-member]').forEach((button) => {
    button.addEventListener('click', async () => {
      const memberId = String(button.dataset.removeGroupMember || '');
      const target = participants.find(
        (participant) => String(participant.id) === memberId
      );
      if (!target) return;

      const targetName = target.displayName || target.username || 'this member';
      if (!window.confirm(`Remove ${targetName} from this group?`)) return;

      button.disabled = true;
      try {
        const updatedConversation = await removeGroupParticipant(
          conversation.id,
          memberId
        );

        if (Array.isArray(updatedConversation.participants)) {
          conversation.participants = updatedConversation.participants;
        }
        if (updatedConversation.updatedAt) {
          conversation.updatedAt = updatedConversation.updatedAt;
        }

        renderConversationList();
        closePanel();
        openGroupInfo(conversation);
      } catch (error) {
        window.alert(error.message || 'Could not remove this member.');
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
  });

  // The current admin can transfer administration to a regular member.
  overlay.querySelectorAll('[data-transfer-group-admin]').forEach((button) => {
    button.addEventListener('click', async () => {
      const targetId = String(button.dataset.transferGroupAdmin || '');
      const target = participants.find(
        (participant) => String(participant.id) === targetId
      );
      if (!target) return;

      const targetName = target.displayName || target.username || 'this member';
      if (!window.confirm(`Transfer group administration to ${targetName}? You will become a regular member and can no longer rename the group, add members, or remove members.`)) return;

      button.disabled = true;
      try {
        const result = await transferGroupAdmin(conversation.id, targetId);
        if (Array.isArray(result.participants)) {
          conversation.participants = result.participants;
        }
        if (result.updatedAt) conversation.updatedAt = result.updatedAt;
        renderConversationList();
        closePanel();
        openGroupInfo(conversation);
      } catch (error) {
        window.alert(error.message || 'Could not transfer group administration.');
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
  });

  // A regular member can leave. The backend independently rejects admins.
  overlay.querySelector('#group-info-leave-btn')?.addEventListener('click', async (event) => {
    if (canRename) {
      window.alert('Transfer admin rights to another member before leaving the group.');
      return;
    }

    if (!window.confirm(`Leave "${groupName}"? You will lose access to this group's messages and attachments.`)) return;

    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await leaveGroupConversation(conversation.id);
      handleGroupMembersRemoved({ ...result, leftBySelf: true });
    } catch (error) {
      window.alert(error.message || 'Could not leave the group.');
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });

  const handleEscape = (event) => {
    if (event.key === 'Escape') {
      closePanel();
    }
  };

  overlay
    .querySelector('.group-info-close')
    .addEventListener('click', closePanel);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      closePanel();
    }
  });

  document.addEventListener('keydown', handleEscape);

  overlay.querySelector('.group-info-dialog').focus();
}

/** Bind top-scroll pagination once for each rendered message list. */
function bindMessagePagination(listEl) {
  if (!listEl || listEl.dataset.paginationBound === 'true') return;
  listEl.dataset.paginationBound = 'true';
  listEl.addEventListener('scroll', () => {
    if (listEl.scrollTop <= 80) {
      loadOlderMessages(activeConversationId);
    }
  }, { passive: true });
}

/** Capture a visible message so prepending history doesn't jump the viewport. */
function captureMessageScrollAnchor(listEl) {
  const listTop = listEl.getBoundingClientRect().top;
  for (const bubble of listEl.querySelectorAll('.message-bubble')) {
    const rect = bubble.getBoundingClientRect();
    if (rect.bottom > listTop) {
      return { id: bubble.dataset.messageId, top: rect.top };
    }
  }
  return null;
}

function restoreMessageScrollAnchor(listEl, anchor) {
  if (!anchor?.id) return;
  const bubble = [...listEl.querySelectorAll('.message-bubble')]
    .find((item) => String(item.dataset.messageId) === String(anchor.id));
  if (!bubble) return;
  listEl.scrollTop += bubble.getBoundingClientRect().top - anchor.top;
}

function markIncomingMessagesRead(pageMessages) {
  pageMessages.forEach((message) => {
    if (String(message.senderId) === String(currentUser.id)) return;
    const ownReceipt = Array.isArray(message.receipts)
      ? message.receipts.find((receipt) => String(receipt.userId) === String(currentUser.id))
      : null;
    if (ownReceipt?.status === 'read') return;
    markMessageRead(message.id).catch(() => {});
  });
}

/** Load the newest page of a conversation. */
async function loadMessages(conversationId) {
  const listEl = document.getElementById('message-list');
  if (!listEl) return;

  const generation = ++messagesLoadGeneration;
  messagePaginationConversationId = String(conversationId);
  nextMessageCursor = null;
  hasOlderMessages = false;
  loadingOlderMessages = false;
  listEl.dataset.loadingOlder = 'false';
  delete listEl.dataset.loadOlderError;
  // Remove a previously open conversation's messages while preserving any
  // same-conversation messages already in memory (for refresh after an upload).
  messages = messages.filter(
    (message) => String(message.conversationId) === String(conversationId)
  );
  if (messages.length === 0) {
    listEl.innerHTML = '<div class="empty-state"><p>Loading messages…</p></div>';
  } else {
    renderMessages({ mode: 'preserve' });
  }
  bindMessagePagination(listEl);

  try {
    const page = await getMessages(conversationId, { limit: MESSAGE_PAGE_SIZE });
    // Ignore responses that arrive after the user has switched conversations.
    if (generation !== messagesLoadGeneration || String(activeConversationId) !== String(conversationId)) return;

    const pageItems = (Array.isArray(page) ? page : (page?.items || []))
      .map(prepareMessageForUi);
    // Keep live messages that arrived while the history request was in flight.
    messages = mergeAndSortMessages(pageItems, messages);
    nextMessageCursor = page?.nextCursor || null;
    hasOlderMessages = Boolean(page?.hasMore && nextMessageCursor);
    renderMessages({ mode: 'bottom' });
    markIncomingMessagesRead(messages);
  } catch (e) {
    if (generation !== messagesLoadGeneration || String(activeConversationId) !== String(conversationId)) return;
    listEl.innerHTML = `<div class="error-state"><i class="bi bi-exclamation-triangle"></i><p>Could not load messages.</p><button class="btn btn-sm btn-outline-primary" onclick="window.__apertureMsgReload('${conversationId}')">Retry</button></div>`;
    window.__apertureMsgReload = (id) => loadMessages(id);
  }
}

/** Load the page immediately older than the oldest loaded message. */
async function loadOlderMessages(conversationId) {
  if (!conversationId || String(conversationId) !== messagePaginationConversationId) return;
  if (loadingOlderMessages || !hasOlderMessages || !nextMessageCursor) return;

  const listEl = document.getElementById('message-list');
  if (!listEl) return;

  const generation = messagesLoadGeneration;
  const cursor = nextMessageCursor;
  const anchor = captureMessageScrollAnchor(listEl);
  loadingOlderMessages = true;
  listEl.dataset.loadingOlder = 'true';
  delete listEl.dataset.loadOlderError;

  try {
    const page = await getMessages(conversationId, {
      limit: MESSAGE_PAGE_SIZE,
      cursor,
    });
    if (generation !== messagesLoadGeneration || String(activeConversationId) !== String(conversationId)) return;

    const pageItems = Array.isArray(page) ? page : (page?.items || []);
    const knownIds = new Set(messages.map((message) => String(message.id)));
    const olderMessages = pageItems
      .map(prepareMessageForUi)
      .filter((message) => !knownIds.has(String(message.id)));

    // Realtime events can arrive during the request; keep them and deduplicate.
    messages = mergeAndSortMessages(olderMessages, messages);

    nextMessageCursor = page?.nextCursor || null;
    hasOlderMessages = Boolean(page?.hasMore && nextMessageCursor);
    listEl.dataset.loadingOlder = 'false';
    delete listEl.dataset.loadOlderError;
    renderMessages({ mode: 'anchor', anchor });
    markIncomingMessagesRead(olderMessages);
  } catch (error) {
    if (generation === messagesLoadGeneration) {
      listEl.dataset.loadingOlder = 'false';
      listEl.dataset.loadOlderError = 'true';
      console.error('[chat] Could not load older messages:', error);
    }
  } finally {
    if (generation === messagesLoadGeneration) {
      loadingOlderMessages = false;
      listEl.dataset.loadingOlder = 'false';
    }
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

      image.alt = safeName;
      image.loading = 'lazy';
      image.className = 'message-media-preview';
      image.width = 640;
      image.height = 480;
      image.tabIndex = 0;
      image.src = attachmentUrl.href;
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


/** Render the message list while retaining the reader's current scroll position. */
function renderMessages(options = {}) {
  const listEl = document.getElementById('message-list');
  if (!listEl) return;

  const mode = options.mode || 'auto';
  const previousScrollTop = listEl.scrollTop;
  const wasNearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight <= 120;

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
      const isMine = String(msg.senderId) === String(currentUser.id);
      const statusIcon = isMine ? renderStatusIcon(msg.status) : '';
      const receiptSummary = isMine && isGroup
        ? renderGroupReceiptSummary(msg, conv)
        : '';

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
            ${receiptSummary}
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

  if (mode === 'bottom' || (mode === 'auto' && wasNearBottom)) {
    listEl.scrollTop = listEl.scrollHeight;
  } else if (mode === 'anchor') {
    restoreMessageScrollAnchor(listEl, options.anchor);
  } else {
    // Read-receipt and delivery updates should not yank someone away from older
    // messages they are currently reading.
    listEl.scrollTop = previousScrollTop;
  }
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
  messagesLoadGeneration += 1;
  messagePaginationConversationId = null;
  nextMessageCursor = null;
  hasOlderMessages = false;
  loadingOlderMessages = false;
}

export default { initChatPage, destroyChatPage };
