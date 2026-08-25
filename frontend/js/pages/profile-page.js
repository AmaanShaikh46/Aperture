/**
 * APERTURE - Profile Page Module
 * Avatar, display name, username, email, about, presence/notification/assist settings, logout.
 */
import { getCurrentUser, updateProfile } from '../services/user-service.js';
import { auth } from '../services/auth-service.js';
import { getInitials, avatarColor, showToast } from '../utils.js';

let currentUser = null;

/** Initialize the profile page. */
export async function initProfilePage(container) {
  renderShell(container);
  await loadProfile();
  setupEventListeners();
}

/** Render the page shell. */
function renderShell(container) {
  container.innerHTML = `
    <div class="profile-page">
      <div class="profile-header">
        <div class="profile-avatar" id="profile-avatar"></div>
        <h2 class="h5 mt-3" id="profile-name">Loading...</h2>
        <p class="text-muted small" id="profile-username"></p>
      </div>

      <div class="profile-section">
        <h3 class="section-title">Account</h3>
        <div class="profile-field">
          <label for="profile-display-name" class="form-label">Display Name</label>
          <input type="text" id="profile-display-name" class="form-control" />
        </div>
        <div class="profile-field">
          <label for="profile-username-field" class="form-label">Username</label>
          <input type="text" id="profile-username-field" class="form-control" />
        </div>
        <div class="profile-field">
          <label class="form-label">Email</label>
          <input type="email" id="profile-email" class="form-control" readonly />
        </div>
        <div class="profile-field">
          <label for="profile-about" class="form-label">About</label>
          <textarea id="profile-about" class="form-control" rows="2"></textarea>
        </div>
        <button id="save-profile-btn" class="btn btn-primary mt-2">Save Changes</button>
      </div>

      <div class="profile-section">
        <h3 class="section-title">Privacy</h3>
        <div class="profile-field-row">
          <div>
            <div class="field-label">Online Status</div>
            <div class="field-desc">Show when you're online</div>
          </div>
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" id="setting-online-status" checked />
            <label class="form-check-label" for="setting-online-status" aria-label="Online status"></label>
          </div>
        </div>
        <div class="profile-field-row">
          <div>
            <div class="field-label">Last Seen</div>
            <div class="field-desc">Show your last seen time</div>
          </div>
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" id="setting-last-seen" checked />
            <label class="form-check-label" for="setting-last-seen" aria-label="Last seen"></label>
          </div>
        </div>
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
          <button class="btn btn-outline-primary theme-btn" data-theme="light"><i class="bi bi-sun"></i> Light</button>
          <button class="btn btn-outline-primary theme-btn" data-theme="dark"><i class="bi bi-moon-stars"></i> Dark</button>
          <button class="btn btn-outline-primary theme-btn" data-theme="system"><i class="bi bi-circle-half"></i> System</button>
        </div>
      </div>

      <div class="profile-section danger-section">
        <button id="logout-btn" class="btn btn-outline-danger w-100"><i class="bi bi-box-arrow-right"></i> Log Out</button>
      </div>
    </div>`;
}

/** Load the user's profile. */
async function loadProfile() {
  try {
    currentUser = await getCurrentUser();
    const avatarEl = document.getElementById('profile-avatar');
    avatarEl.textContent = getInitials(currentUser.displayName);
    avatarEl.style.backgroundColor = avatarColor(currentUser.displayName);
    document.getElementById('profile-name').textContent = currentUser.displayName;
    document.getElementById('profile-username').textContent = `@${currentUser.username || ''}`;
    document.getElementById('profile-display-name').value = currentUser.displayName || '';
    document.getElementById('profile-username-field').value = currentUser.username || '';
    document.getElementById('profile-email').value = currentUser.email || '';
    document.getElementById('profile-about').value = currentUser.about || '';
  } catch (e) {
    showToast('Could not load profile.', 'danger');
  }
}

/** Setup event listeners. */
function setupEventListeners() {
  document.getElementById('save-profile-btn').addEventListener('click', async () => {
    const data = {
      displayName: document.getElementById('profile-display-name').value.trim(),
      username: document.getElementById('profile-username-field').value.trim(),
      about: document.getElementById('profile-about').value.trim(),
    };
    try {
      await updateProfile(data);
      currentUser = await getCurrentUser();
      document.getElementById('profile-name').textContent = currentUser.displayName;
      document.getElementById('profile-username').textContent = `@${currentUser.username || ''}`;
      const avatarEl = document.getElementById('profile-avatar');
      avatarEl.textContent = getInitials(currentUser.displayName);
      avatarEl.style.backgroundColor = avatarColor(currentUser.displayName);
      showToast('Profile updated.', 'success');
    } catch (e) {
      showToast('Could not save profile.', 'danger');
    }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await auth.signOut();
    window.location.href = 'login.html';
  });

  // Theme buttons
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      import('../utils.js').then(({ applyTheme }) => applyTheme(theme));
      document.querySelectorAll('.theme-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Highlight current theme
  const currentTheme = localStorage.getItem('aperture-theme') || 'system';
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    if (btn.dataset.theme === currentTheme) btn.classList.add('active');
  });

  // Save settings to localStorage
  const settings = ['setting-online-status', 'setting-last-seen', 'setting-msg-notif', 'setting-call-notif', 'setting-voice-feedback', 'setting-auto-confirm'];
  settings.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const stored = localStorage.getItem(`aperture-${id}`);
    if (stored !== null) el.checked = stored === 'true';
    el.addEventListener('change', () => {
      localStorage.setItem(`aperture-${id}`, String(el.checked));
    });
  });
}

/** Clean up. */
export function destroyProfilePage() {}

export default { initProfilePage, destroyProfilePage };
