/**
 * APERTURE - Contacts Page Module
 * Search users, list contacts, add/remove contacts, open chat, call contact.
 */
import { searchUsers } from '../services/user-service.js';
import { getContacts, addContact, removeContact } from '../services/contact-service.js';
import { createConversation } from '../services/conversation-service.js';
import { escapeHtml, getInitials, avatarColor, debounce } from '../utils.js';

let contacts = [];

/** Initialize the contacts page. */
export async function initContactsPage(container) {
  renderShell(container);
  await loadContacts();
  setupSearch();
}

/** Render the page shell. */
function renderShell(container) {
  container.innerHTML = `
    <div class="contacts-page">
      <div class="contacts-header">
        <h2 class="h5 mb-3">Contacts</h2>
        <div class="input-group mb-3">
          <span class="input-group-text"><i class="bi bi-search" aria-hidden="true"></i></span>
          <input type="text" id="contact-search" class="form-control" placeholder="Search users..." aria-label="Search users" autocomplete="off" />
        </div>
      </div>
      <div id="search-results" class="search-results"></div>
      <div id="contacts-list" class="contacts-list"></div>
    </div>`;
}

/** Load and render contacts. */
async function loadContacts() {
  const listEl = document.getElementById('contacts-list');
  listEl.innerHTML = `<div class="loading-state"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div></div>`;
  try {
    contacts = await getContacts();
    renderContacts();
  } catch (e) {
    listEl.innerHTML = `<div class="error-state"><i class="bi bi-exclamation-triangle"></i><p>Could not load contacts.</p><button class="btn btn-sm btn-outline-primary" onclick="window.__apertureContactsReload()">Retry</button></div>`;
    window.__apertureContactsReload = () => loadContacts();
  }
}

/** Render the contacts list. */
function renderContacts() {
  const listEl = document.getElementById('contacts-list');
  if (!contacts || contacts.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><i class="bi bi-people"></i><p>No contacts yet. Search above to add someone.</p></div>`;
    return;
  }
  listEl.innerHTML = contacts
    .map((contact) => {
      const initials = getInitials(contact.displayName);
      const color = avatarColor(contact.displayName);
      return `
        <div class="contact-card" data-user-id="${contact.id}">
          <div class="avatar" style="background-color:${color}">${initials}</div>
          <div class="contact-info">
            <div class="contact-name">${escapeHtml(contact.displayName)}</div>
            <div class="contact-username">@${escapeHtml(contact.username || '')}</div>
          </div>
          <div class="contact-actions">
            <button class="btn btn-sm btn-outline-primary contact-chat-btn" data-user-id="${contact.id}" aria-label="Chat with ${escapeHtml(contact.displayName)}"><i class="bi bi-chat-dots"></i></button>
            <button class="btn btn-sm btn-outline-success contact-call-btn" data-user-id="${contact.id}" aria-label="Call ${escapeHtml(contact.displayName)}"><i class="bi bi-telephone"></i></button>
            <button class="btn btn-sm btn-outline-danger contact-remove-btn" data-user-id="${contact.id}" aria-label="Remove ${escapeHtml(contact.displayName)}"><i class="bi bi-person-dash"></i></button>
          </div>
        </div>`;
    })
    .join('');

  listEl.querySelectorAll('.contact-chat-btn').forEach((btn) => {
    btn.addEventListener('click', () => openChat(btn.dataset.userId));
  });
  listEl.querySelectorAll('.contact-call-btn').forEach((btn) => {
    btn.addEventListener('click', () => callContact(btn.dataset.userId));
  });
  listEl.querySelectorAll('.contact-remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => removeContactHandler(btn.dataset.userId));
  });
}

/** Setup search functionality. */
function setupSearch() {
  const input = document.getElementById('contact-search');
  const resultsEl = document.getElementById('search-results');
  const debouncedSearch = debounce(async (query) => {
    if (!query.trim()) {
      resultsEl.innerHTML = '';
      return;
    }
    try {
      const users = await searchUsers(query);
      if (!users || users.length === 0) {
        resultsEl.innerHTML = `<div class="search-empty"><p class="text-muted small mb-0">No users found.</p></div>`;
        return;
      }
      resultsEl.innerHTML = users
        .map((user) => {
          const initials = getInitials(user.displayName);
          const color = avatarColor(user.displayName);
          const isContact = contacts.find((c) => c.id === user.id);
          return `
            <div class="search-result-item" data-user-id="${user.id}">
              <div class="avatar avatar-sm" style="background-color:${color}">${initials}</div>
              <div class="search-result-info">
                <div class="search-result-name">${escapeHtml(user.displayName)}</div>
                <div class="search-result-username">@${escapeHtml(user.username || '')}</div>
              </div>
              <button class="btn btn-sm ${isContact ? 'btn-outline-secondary' : 'btn-primary'} add-contact-btn" data-user-id="${user.id}" ${isContact ? 'disabled' : ''}>
                ${isContact ? '<i class="bi bi-check2"></i> Added' : '<i class="bi bi-person-plus"></i> Add'}
              </button>
            </div>`;
        })
        .join('');
      resultsEl.querySelectorAll('.add-contact-btn').forEach((btn) => {
        btn.addEventListener('click', () => addContactHandler(btn.dataset.userId));
      });
    } catch (e) {
      resultsEl.innerHTML = `<div class="search-empty"><p class="text-danger small mb-0">Search failed.</p></div>`;
    }
  }, 300);
  input.addEventListener('input', (e) => debouncedSearch(e.target.value));
}

/** Add a contact. */
async function addContactHandler(userId) {
  try {
    await addContact(userId);
    await loadContacts();
    document.getElementById('contact-search').value = '';
    document.getElementById('search-results').innerHTML = '';
  } catch (e) {
    console.error('Failed to add contact:', e);
  }
}

/** Remove a contact. */
async function removeContactHandler(userId) {
  try {
    await removeContact(userId);
    contacts = contacts.filter((c) => c.id !== userId);
    renderContacts();
  } catch (e) {
    console.error('Failed to remove contact:', e);
  }
}

/** Open a chat with a user. */
async function openChat(userId) {
  try {
    const conv = await createConversation(userId);
    window.location.href = `app.html?conversation=${conv.id}`;
  } catch (e) {
    console.error('Failed to create conversation:', e);
  }
}

/** Call a contact. */
async function callContact(userId) {
  window.location.href = `calls.html?action=call&user=${userId}`;
}

/** Clean up. */
export function destroyContactsPage() {}

export default { initContactsPage, destroyContactsPage };
