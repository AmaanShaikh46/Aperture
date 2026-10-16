/**
 * APERTURE - Calls Page Module
 * Displays call history; the shared call controller handles incoming/outgoing calls
 * even while the user is viewing another page of the application.
 */
import { getCalls } from '../services/call-service.js';
import { initializeCallRuntime, startOutgoingCall } from '../webrtc/call-controller.js';
import { escapeHtml, formatTime, getInitials, avatarColor, queryParam } from '../utils.js';

let historyRefreshHandler = null;

export async function initCallsPage(container) {
  renderShell(container);
  initializeCallRuntime();
  historyRefreshHandler = () => loadCallHistory();
  window.addEventListener('aperture:call-history-refresh', historyRefreshHandler);
  await loadCallHistory();

  const action = queryParam('action');
  const userId = queryParam('user');
  const callType = queryParam('type') === 'video' ? 'video' : 'audio';
  if (action === 'call' && userId) {
    startOutgoingCall(userId, callType);
  }
}

function renderShell(container) {
  container.innerHTML = `
    <div class="calls-page">
      <div class="calls-header">
        <h2 class="h5 mb-3">Calls</h2>
      </div>
      <div id="call-history" class="call-history"></div>
    </div>`;
}

async function loadCallHistory() {
  const listEl = document.getElementById('call-history');
  if (!listEl) return;
  listEl.innerHTML = `<div class="loading-state"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div></div>`;
  try {
    renderCallHistory(await getCalls());
  } catch (error) {
    console.error('[calls] Could not load call history:', error);
    if (!document.getElementById('call-history')) return;
    listEl.innerHTML = `<div class="error-state"><i class="bi bi-exclamation-triangle"></i><p>Could not load call history.</p><button class="btn btn-sm btn-outline-primary" id="calls-retry-btn" type="button">Retry</button></div>`;
    document.getElementById('calls-retry-btn')?.addEventListener('click', loadCallHistory);
  }
}

function statusMarkup(call) {
  if (call.status === 'missed') return '<span class="badge text-bg-danger">Missed</span>';
  if (call.status === 'rejected') return '<span class="badge text-bg-warning">Rejected</span>';
  if (call.status === 'cancelled') return '<span class="badge text-bg-secondary">Cancelled</span>';
  if (call.status === 'completed') return `<span class="text-muted small">${formatDuration(call.duration)}</span>`;
  if (call.status === 'accepted') return '<span class="badge text-bg-success">Connected</span>';
  return '<span class="badge text-bg-secondary">Ringing</span>';
}

function renderCallHistory(calls) {
  const listEl = document.getElementById('call-history');
  if (!listEl) return;
  if (!Array.isArray(calls) || calls.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><i class="bi bi-telephone"></i><p>No call history yet.</p></div>`;
    return;
  }
  listEl.innerHTML = calls.map((call) => {
    const name = call.displayName || 'Unknown';
    const initials = getInitials(name);
    const color = avatarColor(name);
    const directionIcon = call.direction === 'incoming' ? 'bi-arrow-down-left' : 'bi-arrow-up-right';
    const otherUserId = call.direction === 'incoming' ? call.callerId : call.calleeId;
    return `
      <div class="call-history-item">
        <div class="avatar avatar-sm" style="background-color:${color}">${escapeHtml(initials)}</div>
        <div class="call-info">
          <div class="call-name">${escapeHtml(name)}</div>
          <div class="call-meta">
            <i class="bi ${directionIcon}" aria-hidden="true"></i>
            ${call.startedAt ? formatTime(call.startedAt) : ''}
            <span class="badge text-bg-light">${call.callType === 'video' ? 'Video' : 'Audio'}</span>
            ${statusMarkup(call)}
          </div>
        </div>
        <div class="call-history-actions">
          <button class="btn btn-sm btn-outline-primary call-back-btn" data-user-id="${escapeHtml(otherUserId || '')}" data-call-type="audio" aria-label="Audio call ${escapeHtml(name)}" ${otherUserId ? '' : 'disabled'}><i class="bi bi-telephone"></i></button>
          <button class="btn btn-sm btn-outline-primary call-video-btn" data-user-id="${escapeHtml(otherUserId || '')}" data-call-type="video" aria-label="Video call ${escapeHtml(name)}" ${otherUserId ? '' : 'disabled'}><i class="bi bi-camera-video"></i></button>
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.call-back-btn, .call-video-btn').forEach((button) => {
    button.addEventListener('click', () => startOutgoingCall(button.dataset.userId, button.dataset.callType));
  });
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export function destroyCallsPage() {
  if (historyRefreshHandler) {
    window.removeEventListener('aperture:call-history-refresh', historyRefreshHandler);
    historyRefreshHandler = null;
  }
}

export default { initCallsPage, destroyCallsPage };
