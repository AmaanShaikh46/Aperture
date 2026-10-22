/**
 * APERTURE - Profile Page Module
 * Profile identity, avatar upload, local preferences, theme, and sign-out.
 */
import {
  getCurrentUser,
  updateProfile,
  uploadProfileAvatar,
} from '../services/user-service.js';
import { auth } from '../services/auth-service.js';
import { getInitials, avatarColor, showToast } from '../utils.js';
import { getPresenceSettings, updatePresenceSettings } from '../services/presence-service.js';

const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
const AVATAR_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

let currentUser = null;
let isSavingProfile = false;
let isUploadingAvatar = false;

/** Initialize the profile page. */
export async function initProfilePage(container) {
  renderShell(container);
  await loadProfile();
  await loadPresencePreference();
  setupEventListeners();
}

/** Render the page shell. */
function renderShell(container) {
  container.innerHTML = `
    <div class="profile-page">
      <div class="profile-header">
        <div class="profile-avatar" id="profile-avatar" role="img" aria-label="Profile picture"></div>
        <button
          type="button"
          id="profile-avatar-change-btn"
          class="btn btn-sm btn-outline-primary mt-3"
        >
          <i class="bi bi-camera" aria-hidden="true"></i>
          Change photo
        </button>
        <input
          type="file"
          id="profile-avatar-input"
          class="visually-hidden"
          accept="image/jpeg,image/png,image/webp"
          aria-label="Choose profile picture"
        />
        <div class="form-text mt-2">JPEG, PNG, or WebP. Maximum size: 5 MB.</div>
        <h2 class="h5 mt-3" id="profile-name">Loading...</h2>
        <p class="text-muted small" id="profile-username"></p>
      </div>

      <div class="profile-section">
        <h3 class="section-title">Account</h3>
        <div class="profile-field">
          <label for="profile-display-name" class="form-label">Display Name</label>
          <input type="text" id="profile-display-name" class="form-control" maxlength="80" autocomplete="name" />
        </div>
        <div class="profile-field">
          <label for="profile-username-field" class="form-label">Username</label>
          <input type="text" id="profile-username-field" class="form-control" minlength="3" maxlength="30" pattern="[A-Za-z0-9_]+" autocomplete="username" aria-describedby="profile-username-help" />
          <div id="profile-username-help" class="form-text">3–30 characters; letters, numbers, and underscores only.</div>
        </div>
        <div class="profile-field">
          <label for="profile-email" class="form-label">Email</label>
          <input type="email" id="profile-email" class="form-control" readonly aria-readonly="true" />
          <div class="form-text">Email is managed by your authentication account.</div>
        </div>
        <div class="profile-field">
          <label for="profile-about" class="form-label">About</label>
          <textarea id="profile-about" class="form-control" rows="2" maxlength="250"></textarea>
          <div class="form-text">Up to 250 characters.</div>
        </div>
        <div id="profile-save-error" class="text-danger small mb-2" role="alert"></div>
        <button id="save-profile-btn" class="btn btn-primary mt-2">
          <i class="bi bi-check2" aria-hidden="true"></i>
          Save Changes
        </button>
      </div>

      <div class="profile-section">
        <h3 class="section-title">Privacy</h3>
        <div class="profile-field-row">
          <div>
            <div class="field-label">Share last seen</div>
            <div class="field-desc">Let accepted friends see when you're online or when you were last online.</div>
          </div>
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" id="setting-share-last-seen" checked disabled aria-describedby="presence-setting-status" />
            <label class="form-check-label" for="setting-share-last-seen" aria-label="Share last seen"></label>
          </div>
        </div>
        <div id="presence-setting-status" class="small text-muted" role="status" aria-live="polite"></div>
      </div>

      <div class="profile-section">
        <h3 class="section-title">Notifications</h3>
        <div class="profile-field-row">
          <div>
            <div class="field-label">Message Notifications</div>
            <div class="field-desc">Get notified of new messages</div>
          </div>
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" id="setting-msg-notif" checked />
            <label class="form-check-label" for="setting-msg-notif" aria-label="Message notifications"></label>
          </div>
        </div>
        <div class="profile-field-row">
          <div>
            <div class="field-label">Call Notifications</div>
            <div class="field-desc">Get notified of incoming calls</div>
          </div>
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" id="setting-call-notif" checked />
            <label class="form-check-label" for="setting-call-notif" aria-label="Call notifications"></label>
          </div>
        </div>
      </div>

      <div class="profile-section">
        <h3 class="section-title">Aperture Assist</h3>
        <div class="profile-field-row">
          <div>
            <div class="field-label">Voice Feedback</div>
            <div class="field-desc">Read responses aloud</div>
          </div>
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" id="setting-voice-feedback" checked />
            <label class="form-check-label" for="setting-voice-feedback" aria-label="Voice feedback"></label>
          </div>
        </div>
        <div class="profile-field-row">
          <div>
            <div class="field-label">Auto-confirm Low Risk</div>
            <div class="field-desc">Skip confirmation for low-risk actions</div>
          </div>
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" id="setting-auto-confirm" />
            <label class="form-check-label" for="setting-auto-confirm" aria-label="Auto-confirm low risk"></label>
          </div>
        </div>
      </div>

      <div class="profile-section">
        <h3 class="section-title">Theme</h3>
        <div class="theme-selector">
          <button class="btn btn-outline-primary theme-btn" data-theme="light"><i class="bi bi-sun" aria-hidden="true"></i> Light</button>
          <button class="btn btn-outline-primary theme-btn" data-theme="dark"><i class="bi bi-moon-stars" aria-hidden="true"></i> Dark</button>
          <button class="btn btn-outline-primary theme-btn" data-theme="system"><i class="bi bi-circle-half" aria-hidden="true"></i> System</button>
        </div>
      </div>

      <div class="profile-section danger-section">
        <button id="logout-btn" class="btn btn-outline-danger w-100"><i class="bi bi-box-arrow-right" aria-hidden="true"></i> Log Out</button>
      </div>
    </div>`;
}

function renderAvatar(user) {
  const avatarEl = document.getElementById('profile-avatar');
  if (!avatarEl) return;

  const displayName = user?.displayName || user?.username || 'User';
  avatarEl.replaceChildren();
  avatarEl.style.backgroundColor = avatarColor(displayName);
  avatarEl.style.overflow = 'hidden';
  avatarEl.textContent = '';

  if (user?.avatarUrl) {
    const image = document.createElement('img');
    image.className = 'profile-avatar-image';
    image.alt = `${displayName}'s profile picture`;
    image.style.display = 'block';
    image.style.width = '100%';
    image.style.height = '100%';
    image.style.objectFit = 'cover';
    image.style.borderRadius = 'inherit';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => {
      if (image.parentNode === avatarEl) {
        avatarEl.replaceChildren();
        avatarEl.textContent = getInitials(displayName);
      }
    }, { once: true });
    image.src = user.avatarUrl;
    avatarEl.appendChild(image);
    avatarEl.setAttribute('aria-label', `${displayName}'s profile picture`);
  } else {
    avatarEl.textContent = getInitials(displayName);
    avatarEl.setAttribute('aria-label', `${displayName}'s initials`);
  }
}

function renderProfileIdentity(user) {
  const displayName = user.displayName || user.username || 'User';
  document.getElementById('profile-name').textContent = displayName;
  document.getElementById('profile-username').textContent = user.username
    ? `@${user.username}`
    : 'Choose a username';
  renderAvatar(user);
}

/** Load the user's persisted profile. */
async function loadProfile() {
  try {
    currentUser = await getCurrentUser();
    renderProfileIdentity(currentUser);
    document.getElementById('profile-display-name').value = currentUser.displayName || '';
    document.getElementById('profile-username-field').value = currentUser.username || '';
    document.getElementById('profile-email').value = currentUser.email || '';
    document.getElementById('profile-about').value = currentUser.about || '';
  } catch (error) {
    console.error('[profile] Could not load profile:', error);
    const saveButton = document.getElementById('save-profile-btn');
    if (saveButton) saveButton.disabled = true;
    const message = error?.message || 'Could not load your profile.';
    document.getElementById('profile-save-error').textContent = message;
    showToast(message, 'danger');
  }
}

async function loadPresencePreference() {
  const toggle = document.getElementById('setting-share-last-seen');
  const status = document.getElementById('presence-setting-status');
  if (!toggle) return;
  try {
    const settings = await getPresenceSettings();
    toggle.checked = settings.shareLastSeen !== false;
    toggle.disabled = false;
    if (status) status.textContent = '';
  } catch (error) {
    toggle.checked = false;
    toggle.disabled = true;
    if (status) status.textContent = 'Privacy setting unavailable. Try reloading the page.';
    console.error('[profile] Could not load presence privacy setting:', error);
  }
}

function setButtonBusy(button, busy, busyText, normalHtml) {
  if (!button) return;
  button.disabled = busy;
  button.innerHTML = busy ? `
    <span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>
    ${busyText}
  ` : normalHtml;
}

/** Setup event listeners. */
function setupEventListeners() {
  const saveButton = document.getElementById('save-profile-btn');
  const avatarButton = document.getElementById('profile-avatar-change-btn');
  const avatarInput = document.getElementById('profile-avatar-input');

  saveButton.addEventListener('click', async () => {
    if (isSavingProfile || !currentUser) return;

    const data = {
      displayName: document.getElementById('profile-display-name').value.trim(),
      username: document.getElementById('profile-username-field').value.trim(),
      about: document.getElementById('profile-about').value.trim(),
    };
    const errorEl = document.getElementById('profile-save-error');
    errorEl.textContent = '';

    if (!data.displayName) {
      errorEl.textContent = 'Display name cannot be empty.';
      document.getElementById('profile-display-name').focus();
      return;
    }
    if (data.username && !/^[A-Za-z0-9_]{3,30}$/.test(data.username)) {
      errorEl.textContent = 'Username must be 3–30 characters using letters, numbers, and underscores.';
      document.getElementById('profile-username-field').focus();
      return;
    }
    if (data.about.length > 250) {
      errorEl.textContent = 'About must be 250 characters or fewer.';
      document.getElementById('profile-about').focus();
      return;
    }

    isSavingProfile = true;
    setButtonBusy(saveButton, true, 'Saving...', ' <i class="bi bi-check2" aria-hidden="true"></i> Save Changes ');

    try {
      currentUser = await updateProfile(data);
      renderProfileIdentity(currentUser);
      document.getElementById('profile-about').value = currentUser.about || '';
      document.getElementById('profile-username-field').value = currentUser.username || '';
      window.dispatchEvent(new CustomEvent('aperture:profile-updated', { detail: { user: currentUser } }));
      showToast('Profile updated.', 'success');
    } catch (error) {
      console.error('[profile] Could not save profile:', error);
      errorEl.textContent = error?.message || 'Could not save your profile. Please try again.';
      showToast(errorEl.textContent, 'danger');
    } finally {
      isSavingProfile = false;
      setButtonBusy(saveButton, false, '', '<i class="bi bi-check2" aria-hidden="true"></i> Save Changes');
    }
  });

  avatarButton.addEventListener('click', () => avatarInput.click());
  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files?.[0];
    if (!file || isUploadingAvatar) return;

    if (!AVATAR_MIME_TYPES.has(file.type)) {
      showToast('Choose a JPEG, PNG, or WebP image.', 'danger');
      avatarInput.value = '';
      return;
    }
    if (file.size === 0 || file.size > MAX_AVATAR_SIZE) {
      showToast('Choose an image that is greater than 0 bytes and no larger than 5 MB.', 'danger');
      avatarInput.value = '';
      return;
    }

    isUploadingAvatar = true;
    avatarButton.disabled = true;
    avatarButton.innerHTML = '<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span> Uploading...';

    try {
      currentUser = await uploadProfileAvatar(file);
      renderProfileIdentity(currentUser);
      window.dispatchEvent(new CustomEvent('aperture:profile-updated', { detail: { user: currentUser } }));
      showToast('Profile picture updated.', 'success');
    } catch (error) {
      console.error('[profile] Avatar upload failed:', error);
      showToast(error?.message || 'Could not upload your profile picture.', 'danger');
    } finally {
      isUploadingAvatar = false;
      avatarButton.disabled = false;
      avatarButton.innerHTML = '<i class="bi bi-camera" aria-hidden="true"></i> Change photo';
      avatarInput.value = '';
    }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await auth.signOut();
    window.location.href = 'login.html';
  });

  // Theme selection remains a client-side preference.
  document.querySelectorAll('.theme-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const theme = button.dataset.theme;
      import('../utils.js').then(({ applyTheme }) => applyTheme(theme));
      document.querySelectorAll('.theme-btn').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
    });
  });

  const currentTheme = localStorage.getItem('aperture-theme') || 'system';
  document.querySelectorAll('.theme-btn').forEach((button) => {
    if (button.dataset.theme === currentTheme) button.classList.add('active');
  });

  // Presence privacy is persisted by the backend and enforced for API/WebSocket data.
  const presenceToggle = document.getElementById('setting-share-last-seen');
  const presenceStatus = document.getElementById('presence-setting-status');
  presenceToggle?.addEventListener('change', async () => {
    if (presenceToggle.disabled) return;
    const requestedValue = presenceToggle.checked;
    presenceToggle.disabled = true;
    if (presenceStatus) presenceStatus.textContent = 'Saving…';
    try {
      const saved = await updatePresenceSettings(requestedValue);
      presenceToggle.checked = saved.shareLastSeen !== false;
      if (presenceStatus) presenceStatus.textContent = 'Privacy setting saved.';
    } catch (error) {
      presenceToggle.checked = !requestedValue;
      if (presenceStatus) presenceStatus.textContent = 'Could not save this setting. Please try again.';
      showToast('Could not save your presence privacy setting.', 'danger');
    } finally {
      presenceToggle.disabled = false;
    }
  });

  // Other preferences remain browser-local, as before.
  const localSettings = [
    'setting-msg-notif', 'setting-call-notif',
    'setting-voice-feedback', 'setting-auto-confirm',
  ];
  localSettings.forEach((id) => {
    const element = document.getElementById(id);
    if (!element) return;
    const storedValue = localStorage.getItem(`aperture-${id}`);
    if (storedValue !== null) element.checked = storedValue === 'true';
    element.addEventListener('change', () => {
      localStorage.setItem(`aperture-${id}`, String(element.checked));
    });
  });
}

/** Clean up. */
export function destroyProfilePage() {
  isSavingProfile = false;
  isUploadingAvatar = false;
}

export default { initProfilePage, destroyProfilePage };
