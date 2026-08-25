/**
 * APERTURE - Calls Page Module
 * Renders call history list, incoming call screen, active call screen, and missed call state.
 */
import { getCalls, createCall, acceptCall, rejectCall, endCall } from '../services/call-service.js';
import { eventRouter, EventTypes } from '../realtime/event-router.js';
import { escapeHtml, formatTime, getInitials, avatarColor, queryParam } from '../utils.js';

let activeCallId = null;
let callTimerInterval = null;
let callStartTime = null;
let unsubscribeFns = [];

/** Initialize the calls page. */
export async function initCallsPage(container) {
  renderShell(container);
  await loadCallHistory();

  // Check for call action from URL
  const action = queryParam('action');
  const userId = queryParam('user');
  if (action === 'call' && userId) {
    initiateCall(userId);
  }

  // Subscribe to incoming call events
  unsubscribeFns.push(
    eventRouter.on(EventTypes.CALL_INCOMING, (data) => {
      showIncomingCall(data);
    }),
  );
  unsubscribeFns.push(
    eventRouter.on(EventTypes.CALL_ACCEPTED, (data) => {
      startActiveCall(data.callId);
    }),
  );
  unsubscribeFns.push(
    eventRouter.on(EventTypes.CALL_REJECTED, () => {
      clearCallOverlay();
    }),
  );
  unsubscribeFns.push(
    eventRouter.on(EventTypes.CALL_ENDED, () => {
      endActiveCall();
    }),
  );
}

/** Render the page shell. */
function renderShell(container) {
  container.innerHTML = `
    <div class="calls-page">
      <div class="calls-header">
        <h2 class="h5 mb-3">Calls</h2>
      </div>
      <div id="call-history" class="call-history"></div>
    </div>
    <div id="call-overlay" class="call-overlay" style="display:none;"></div>`;
}

/** Load and render call history. */
async function loadCallHistory() {
  const listEl = document.getElementById('call-history');
  listEl.innerHTML = `<div class="loading-state"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div></div>`;
  try {
    const calls = await getCalls();
    renderCallHistory(calls);
  } catch (e) {
    listEl.innerHTML = `<div class="error-state"><i class="bi bi-exclamation-triangle"></i><p>Could not load call history.</p><button class="btn btn-sm btn-outline-primary" onclick="window.__apertureCallsReload()">Retry</button></div>`;
    window.__apertureCallsReload = () => loadCallHistory();
  }
}

/** Render the call history list. */
function renderCallHistory(calls) {
  const listEl = document.getElementById('call-history');
  if (!calls || calls.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><i class="bi bi-telephone"></i><p>No call history yet.</p></div>`;
    return;
  }
  listEl.innerHTML = calls
    .map((call) => {
      const initials = getInitials(call.displayName);
      const color = avatarColor(call.displayName);
      const directionIcon = call.direction === 'incoming' ? 'bi-arrow-down-left' : 'bi-arrow-up-right';
      const statusBadge = call.status === 'missed' ? '<span class="badge text-bg-danger">Missed</span>' :
                          call.status === 'rejected' ? '<span class="badge text-bg-warning">Rejected</span>' :
                          call.status === 'completed' ? `<span class="text-muted small">${formatDuration(call.duration)}</span>` : '';
      return `
        <div class="call-history-item">
          <div class="avatar avatar-sm" style="background-color:${color}">${initials}</div>
          <div class="call-info">
            <div class="call-name">${escapeHtml(call.displayName)}</div>
            <div class="call-meta">
              <i class="bi ${directionIcon}" aria-hidden="true"></i>
              ${formatTime(call.startedAt)}
              ${statusBadge}
            </div>
          </div>
          <button class="btn btn-sm btn-outline-primary call-back-btn" data-user-id="${call.calleeId || call.callerId}" aria-label="Call back ${escapeHtml(call.displayName)}">
            <i class="bi bi-telephone"></i>
          </button>
        </div>`;
    })
    .join('');
  listEl.querySelectorAll('.call-back-btn').forEach((btn) => {
    btn.addEventListener('click', () => initiateCall(btn.dataset.userId));
  });
}

/** Initiate an outgoing call. */
async function initiateCall(userId) {
  try {
    const call = await createCall(userId);
    showOutgoingCall(call);
  } catch (e) {
    console.error('Failed to initiate call:', e);
  }
}

/** Show the outgoing call overlay. */
function showOutgoingCall(call) {
  activeCallId = call.id;
  const overlay = document.getElementById('call-overlay');
  const initials = getInitials(call.displayName || 'Unknown');
  const color = avatarColor(call.displayName || 'Unknown');
  overlay.innerHTML = `
    <div class="call-screen outgoing-call">
      <div class="call-avatar" style="background-color:${color}">${initials}</div>
      <div class="call-name-large">${escapeHtml(call.displayName || 'Unknown')}</div>
      <div class="call-status-text" id="call-status-text">Calling...</div>
      <div class="call-actions">
        <button class="btn btn-danger call-end-btn" aria-label="Cancel call"><i class="bi bi-telephone-x"></i></button>
      </div>
    </div>`;
  overlay.style.display = 'flex';
  overlay.querySelector('.call-end-btn').addEventListener('click', () => {
    endCall(call.id).then(() => clearCallOverlay());
  });
}

/** Show the incoming call overlay. */
function showIncomingCall(data) {
  activeCallId = data.callId;
  const overlay = document.getElementById('call-overlay');
  const initials = getInitials(data.displayName || 'Unknown');
  const color = avatarColor(data.displayName || 'Unknown');
  overlay.innerHTML = `
    <div class="call-screen incoming-call">
      <div class="call-avatar" style="background-color:${color}">${initials}</div>
      <div class="call-name-large">${escapeHtml(data.displayName || 'Unknown')}</div>
      <div class="call-status-text">Incoming call...</div>
      <div class="call-actions incoming-actions">
        <button class="btn btn-success call-accept-btn" aria-label="Accept call"><i class="bi bi-telephone"></i></button>
        <button class="btn btn-danger call-reject-btn" aria-label="Reject call"><i class="bi bi-telephone-x"></i></button>
      </div>
    </div>`;
  overlay.style.display = 'flex';
  overlay.querySelector('.call-accept-btn').addEventListener('click', async () => {
    await acceptCall(data.callId);
    startActiveCall(data.callId, data);
  });
  overlay.querySelector('.call-reject-btn').addEventListener('click', async () => {
    await rejectCall(data.callId);
    clearCallOverlay();
  });
}

/** Start the active call screen. */
function startActiveCall(callId, callData) {
  activeCallId = callId;
  callStartTime = Date.now();
  const overlay = document.getElementById('call-overlay');
  const name = callData?.displayName || 'Active Call';
  const initials = getInitials(name);
  const color = avatarColor(name);
  overlay.innerHTML = `
    <div class="call-screen active-call">
      <div class="call-avatar" style="background-color:${color}">${initials}</div>
      <div class="call-name-large">${escapeHtml(name)}</div>
      <div class="call-timer" id="call-timer" aria-live="polite">00:00</div>
      <div class="call-controls">
        <button class="btn call-control-btn" id="mute-btn" aria-label="Mute" aria-pressed="false"><i class="bi bi-mic-fill"></i></button>
        <button class="btn call-control-btn" id="speaker-btn" aria-label="Speaker" aria-pressed="false"><i class="bi bi-volume-up-fill"></i></button>
        <button class="btn btn-danger call-end-btn" aria-label="End call"><i class="bi bi-telephone-x-fill"></i></button>
      </div>
    </div>`;
  overlay.style.display = 'flex';

  callTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const timerEl = document.getElementById('call-timer');
    if (timerEl) timerEl.textContent = formatDuration(elapsed);
  }, 1000);

  let isMuted = false;
  overlay.querySelector('#mute-btn').addEventListener('click', async () => {
    const { mediaManager } = await import('../webrtc/media-manager.js');
    isMuted = mediaManager.toggleMute();
    const btn = overlay.querySelector('#mute-btn');
    btn.setAttribute('aria-pressed', String(isMuted));
    btn.querySelector('i').className = isMuted ? 'bi bi-mic-mute-fill' : 'bi bi-mic-fill';
  });

  let isSpeakerOn = true;
  overlay.querySelector('#speaker-btn').addEventListener('click', async () => {
    const { mediaManager } = await import('../webrtc/media-manager.js');
    isSpeakerOn = !isSpeakerOn;
    mediaManager.setSpeakerEnabled(isSpeakerOn);
    const btn = overlay.querySelector('#speaker-btn');
    btn.setAttribute('aria-pressed', String(isSpeakerOn));
    btn.querySelector('i').className = isSpeakerOn ? 'bi bi-volume-up-fill' : 'bi bi-volume-mute-fill';
  });

  overlay.querySelector('.call-end-btn').addEventListener('click', async () => {
    await endCall(callId);
    endActiveCall();
  });
}

/** End the active call and clear overlay. */
function endActiveCall() {
  clearInterval(callTimerInterval);
  callTimerInterval = null;
  callStartTime = null;
  activeCallId = null;
  clearCallOverlay();
  loadCallHistory();
}

/** Clear the call overlay. */
function clearCallOverlay() {
  const overlay = document.getElementById('call-overlay');
  if (overlay) {
    overlay.innerHTML = '';
    overlay.style.display = 'none';
  }
  activeCallId = null;
}

/** Format seconds into M:SS. */
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** Clean up. */
export function destroyCallsPage() {
  clearInterval(callTimerInterval);
  unsubscribeFns.forEach((fn) => fn());
  unsubscribeFns = [];
}

export default { initCallsPage, destroyCallsPage };
