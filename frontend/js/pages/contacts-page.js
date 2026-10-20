/**
 * APERTURE - Friends page
 * Friend requests must be accepted before a direct message or call is allowed.
 */
import { searchUsers } from '../services/user-service.js';
import { createConversation } from '../services/conversation-service.js';
import {
  getFriends,
  getFriendRequests,
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  cancelFriendRequest,
  removeFriend,
} from '../services/friend-service.js';
import { escapeHtml, getInitials, avatarColor, debounce } from '../utils.js';

let friends = [];
let incomingRequests = [];
let outgoingRequests = [];
let currentQuery = '';

export async function initContactsPage(container) {
  renderShell(container);
  await loadRelationships();
  setupSearch();
}

function renderShell(container) {
  container.innerHTML = `
    <div class="contacts-page">
      <div class="contacts-header">
        <h2 class="h5 mb-3">Friends</h2>
        <div class="input-group mb-3">
          <span class="input-group-text"><i class="bi bi-search" aria-hidden="true"></i></span>
          <input type="text" id="contact-search" class="form-control" placeholder="Search people by name or username" aria-label="Search users" autocomplete="off" />
        </div>
      </div>
      <div id="search-results" class="search-results"></div>
      <section class="mb-4">
        <h3 class="h6 mb-2">Incoming friend requests <span class="text-muted" id="incoming-count"></span></h3>
        <div id="incoming-requests-list"></div>
      </section>
      <section class="mb-4">
        <h3 class="h6 mb-2">Sent requests <span class="text-muted" id="outgoing-count"></span></h3>
        <div id="outgoing-requests-list"></div>
      </section>
      <section>
        <h3 class="h6 mb-2">Your friends <span class="text-muted" id="friends-count"></span></h3>
        <div id="contacts-list" class="contacts-list"></div>
      </section>
    </div>`;
}

async function loadRelationships() {
  const friendsEl = document.getElementById('contacts-list');
  if (friendsEl) friendsEl.innerHTML = '<div class="small text-muted py-2">Loading friends...</div>';
  try {
    const [friendList, requestLists] = await Promise.all([getFriends(), getFriendRequests()]);
    friends = Array.isArray(friendList) ? friendList : [];
    incomingRequests = Array.isArray(requestLists?.incoming) ? requestLists.incoming : [];
    outgoingRequests = Array.isArray(requestLists?.outgoing) ? requestLists.outgoing : [];
    renderRequests();
    renderFriends();
    if (currentQuery) await renderSearchResults(currentQuery);
  } catch (error) {
    console.error('[friends] Could not load relationships:', error);
    if (friendsEl) {
      friendsEl.innerHTML = `
        <div class="error-state">
          <p>Could not load friends and requests.</p>
          <button type="button" class="btn btn-sm btn-outline-primary" id="friends-retry-btn">Retry</button>
        </div>`;
      document.getElementById('friends-retry-btn')?.addEventListener('click', loadRelationships);
    }
  }
}

function renderRequestCard(user, type) {
  const displayName = user.displayName || user.username || 'Unknown';
  const initials = getInitials(displayName);
  const color = avatarColor(displayName);
  const requestId = String(user.id || '');
  return `
    <div class="contact-card" data-request-id="${escapeHtml(requestId)}">
      <div class="avatar" style="background-color:${color}">${escapeHtml(initials)}</div>
      <div class="contact-info">
        <div class="contact-name">${escapeHtml(displayName)}</div>
        <div class="contact-username">@${escapeHtml(user.username || '')}</div>
      </div>
      <div class="contact-actions">
        ${type === 'incoming' ? `
          <button type="button" class="btn btn-sm btn-primary request-accept-btn" data-request-id="${escapeHtml(requestId)}">Accept</button>
          <button type="button" class="btn btn-sm btn-outline-secondary request-reject-btn" data-request-id="${escapeHtml(requestId)}">Reject</button>
        ` : `
          <span class="small text-muted me-2">Pending</span>
          <button type="button" class="btn btn-sm btn-outline-secondary request-cancel-btn" data-request-id="${escapeHtml(requestId)}">Cancel</button>
        `}
      </div>
    </div>`;
}

function renderRequests() {
  const incomingEl = document.getElementById('incoming-requests-list');
  const outgoingEl = document.getElementById('outgoing-requests-list');
  if (!incomingEl || !outgoingEl) return;

  document.getElementById('incoming-count').textContent = `(${incomingRequests.length})`;
  document.getElementById('outgoing-count').textContent = `(${outgoingRequests.length})`;

  incomingEl.innerHTML = incomingRequests.length
    ? incomingRequests.map((user) => renderRequestCard(user, 'incoming')).join('')
    : '<div class="small text-muted py-2">No new friend requests.</div>';
  outgoingEl.innerHTML = outgoingRequests.length
    ? outgoingRequests.map((user) => renderRequestCard(user, 'outgoing')).join('')
    : '<div class="small text-muted py-2">No pending sent requests.</div>';

  incomingEl.querySelectorAll('.request-accept-btn').forEach((button) => {
    button.addEventListener('click', () => runRequestAction(button, async () => {
      await acceptFriendRequest(button.dataset.requestId);
      await loadRelationships();
    }));
  });
  incomingEl.querySelectorAll('.request-reject-btn').forEach((button) => {
    button.addEventListener('click', () => runRequestAction(button, async () => {
      await rejectFriendRequest(button.dataset.requestId);
      await loadRelationships();
    }));
  });
  outgoingEl.querySelectorAll('.request-cancel-btn').forEach((button) => {
    button.addEventListener('click', () => runRequestAction(button, async () => {
      await cancelFriendRequest(button.dataset.requestId);
      await loadRelationships();
    }));
  });
}

async function runRequestAction(button, operation) {
  button.disabled = true;
  try {
    await operation();
  } catch (error) {
    console.error('[friends] Request action failed:', error);
    window.alert(error.message || 'Could not update the friend request. Please try again.');
    button.disabled = false;
  }
}

function renderFriends() {
  const listEl = document.getElementById('contacts-list');
  if (!listEl) return;
  document.getElementById('friends-count').textContent = `(${friends.length})`;
  if (!friends.length) {
    listEl.innerHTML = '<div class="empty-state"><i class="bi bi-people"></i><p>No friends yet. Search above to send a friend request.</p></div>';
    return;
  }

  listEl.innerHTML = friends.map((friend) => {
    const name = friend.displayName || friend.username || 'Unknown';
    return `
      <div class="contact-card" data-user-id="${escapeHtml(friend.id)}">
        <div class="avatar" style="background-color:${avatarColor(name)}">${escapeHtml(getInitials(name))}</div>
        <div class="contact-info">
          <div class="contact-name">${escapeHtml(name)}</div>
          <div class="contact-username">@${escapeHtml(friend.username || '')}</div>
        </div>
        <div class="contact-actions">
          <button type="button" class="btn btn-sm btn-outline-primary friend-chat-btn" data-user-id="${escapeHtml(friend.id)}" aria-label="Chat with ${escapeHtml(name)}"><i class="bi bi-chat-dots"></i></button>
          <button type="button" class="btn btn-sm btn-outline-success friend-call-btn" data-user-id="${escapeHtml(friend.id)}" aria-label="Audio call ${escapeHtml(name)}"><i class="bi bi-telephone"></i></button>
          <button type="button" class="btn btn-sm btn-outline-primary friend-video-call-btn" data-user-id="${escapeHtml(friend.id)}" aria-label="Video call ${escapeHtml(name)}"><i class="bi bi-camera-video"></i></button>
          <button type="button" class="btn btn-sm btn-outline-danger friend-remove-btn" data-user-id="${escapeHtml(friend.id)}" aria-label="Remove ${escapeHtml(name)}"><i class="bi bi-person-dash"></i></button>
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.friend-chat-btn').forEach((button) => {
    button.addEventListener('click', () => openChat(button.dataset.userId));
  });
  listEl.querySelectorAll('.friend-call-btn').forEach((button) => {
    button.addEventListener('click', () => callFriend(button.dataset.userId, 'audio'));
  });
  listEl.querySelectorAll('.friend-video-call-btn').forEach((button) => {
    button.addEventListener('click', () => callFriend(button.dataset.userId, 'video'));
  });
  listEl.querySelectorAll('.friend-remove-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const friend = friends.find((item) => String(item.id) === String(button.dataset.userId));
      const name = friend?.displayName || friend?.username || 'this friend';
      const confirmed = window.confirm(`Remove ${name} as a friend? Existing messages will remain, new messages and calls will be blocked, and any active call will end.`);
      if (!confirmed) return;
      await runRequestAction(button, async () => {
        await removeFriend(button.dataset.userId);
        await loadRelationships();
      });
    });
  });
}

function setupSearch() {
  const input = document.getElementById('contact-search');
  if (!input) return;
  const handler = debounce((value) => renderSearchResults(value), 300);
  input.addEventListener('input', (event) => {
    currentQuery = event.target.value.trim();
    handler(currentQuery);
  });
}

async function renderSearchResults(query) {
  const resultsEl = document.getElementById('search-results');
  if (!resultsEl) return;
  if (!query.trim()) {
    resultsEl.innerHTML = '';
    return;
  }
  resultsEl.innerHTML = '<div class="small text-muted py-2">Searching...</div>';
  try {
    const users = await searchUsers(query);
    if (!users.length) {
      resultsEl.innerHTML = '<div class="search-empty"><p class="text-muted small mb-0">No users found.</p></div>';
      return;
    }
    resultsEl.innerHTML = users.map((user) => {
      const name = user.displayName || user.username || 'Unknown';
      const relationship = user.relationshipStatus || 'none';
      let action = '';
      if (relationship === 'friends') {
        action = '<button type="button" class="btn btn-sm btn-outline-secondary" disabled><i class="bi bi-check2"></i> Friends</button>';
      } else if (relationship === 'request_sent') {
        action = '<button type="button" class="btn btn-sm btn-outline-secondary" disabled>Request Sent</button>';
      } else if (relationship === 'request_received') {
        action = `
          <button type="button" class="btn btn-sm btn-primary search-accept-btn" data-request-id="${escapeHtml(user.friendRequestId || '')}">Accept</button>
          <button type="button" class="btn btn-sm btn-outline-secondary search-reject-btn" data-request-id="${escapeHtml(user.friendRequestId || '')}">Reject</button>`;
      } else {
        action = `<button type="button" class="btn btn-sm btn-primary search-add-btn" data-user-id="${escapeHtml(user.id)}"><i class="bi bi-person-plus"></i> Add Friend</button>`;
      }
      return `
        <div class="search-result-item" data-user-id="${escapeHtml(user.id)}">
          <div class="avatar avatar-sm" style="background-color:${avatarColor(name)}">${escapeHtml(getInitials(name))}</div>
          <div class="search-result-info">
            <div class="search-result-name">${escapeHtml(name)}</div>
            <div class="search-result-username">@${escapeHtml(user.username || '')}</div>
          </div>
          <div class="contact-actions">${action}</div>
        </div>`;
    }).join('');

    resultsEl.querySelectorAll('.search-add-btn').forEach((button) => {
      button.addEventListener('click', () => runRequestAction(button, async () => {
        await sendFriendRequest(button.dataset.userId);
        await loadRelationships();
      }));
    });
    resultsEl.querySelectorAll('.search-accept-btn').forEach((button) => {
      button.addEventListener('click', () => runRequestAction(button, async () => {
        await acceptFriendRequest(button.dataset.requestId);
        await loadRelationships();
      }));
    });
    resultsEl.querySelectorAll('.search-reject-btn').forEach((button) => {
      button.addEventListener('click', () => runRequestAction(button, async () => {
        await rejectFriendRequest(button.dataset.requestId);
        await loadRelationships();
      }));
    });
  } catch (error) {
    console.error('[friends] User search failed:', error);
    resultsEl.innerHTML = '<div class="search-empty"><p class="text-danger small mb-0">Search failed. Please try again.</p></div>';
  }
}

async function openChat(userId) {
  try {
    const conversation = await createConversation(userId);
    window.location.href = `app.html?conversation=${encodeURIComponent(conversation.id)}`;
  } catch (error) {
    console.error('[friends] Could not open chat:', error);
    window.alert(error.message || 'Could not open this conversation.');
  }
}

function callFriend(userId, callType) {
  window.location.href = `calls.html?action=call&user=${encodeURIComponent(userId)}&type=${encodeURIComponent(callType)}`;
}

export function destroyContactsPage() {
  currentQuery = '';
}

export default { initContactsPage, destroyContactsPage };
