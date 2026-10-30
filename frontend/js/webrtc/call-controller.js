/**
 * APERTURE - One-to-one WebRTC call controller.
 * Keeps call signaling and media lifecycle alive while users move between app pages.
 */
import { createCall, acceptCall, rejectCall, endCall } from '../services/call-service.js';
import { eventRouter, EventTypes } from '../realtime/event-router.js';
import { isWebSocketConnected, onWebSocketStateChange } from '../realtime/websocket-client.js';
import { sendOffer, sendAnswer, sendCallAssistMessage } from './signaling.js';
import {
  createPeerConnection,
  createOffer,
  createAnswer,
  addLocalTrack,
  replaceLocalVideoTrack,
  setRemoteDescription,
  addIceCandidate,
  getRemoteStream,
  onRemoteTrack,
  onConnectionStateChange,
  closePeerConnection,
  getPeerConnection,
} from './peer-connection.js';
import { mediaManager } from './media-manager.js';
import { videoAssistController } from '../assist/video-assist-controller.js';
import { escapeHtml, getInitials, avatarColor } from '../utils.js';

let initialized = false;
let subscriptions = [];
let currentCall = null;
let outgoingRequestPending = false;
const pendingLifecycleEvents = new Map();
let callTimer = null;
let callStartedAt = null;
let ringTimeout = null;
let speakerEnabled = true;
let assistCallHandler = null;
let callAssistMode = false;
let lastAssistMessageId = null;
let lastAssistMessageText = '';
const pendingAssistMessages = new Map();

function notify(message, variant = 'warning') {
  let notice = document.getElementById('aperture-call-notice');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'aperture-call-notice';
    notice.className = 'call-notice';
    notice.setAttribute('role', 'alert');
    notice.setAttribute('aria-live', 'assertive');
    document.body.appendChild(notice);
  }
  notice.textContent = message;
  notice.dataset.variant = variant;
  notice.hidden = false;
  clearTimeout(notice._dismissTimer);
  notice._dismissTimer = setTimeout(() => { notice.hidden = true; }, 5000);
}

function ensureOverlay() {
  let overlay = document.getElementById('call-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'call-overlay';
    overlay.className = 'call-overlay';
    overlay.style.display = 'none';
    document.body.appendChild(overlay);
  }
  return overlay;
}

function displayName(call) {
  return call?.displayName || 'Unknown';
}

function showOverlay(markup) {
  const overlay = ensureOverlay();
  overlay.innerHTML = markup;
  overlay.style.display = 'flex';
  return overlay;
}

function renderOutgoing() {
  if (!currentCall) return;
  const name = displayName(currentCall);
  const color = avatarColor(name);
  const initials = getInitials(name);
  showOverlay(`
    <section class="call-screen outgoing-call" role="dialog" aria-modal="true" aria-label="Outgoing call">
      <div class="call-avatar" style="background-color:${color}">${escapeHtml(initials)}</div>
      <div class="call-name-large">${escapeHtml(name)}</div>
      <div class="call-status-text" id="call-status-text">${currentCall.callType === 'video' ? 'Video calling' : 'Audio calling'} ${escapeHtml(name)}…</div>
      <div class="call-actions">
        <button class="btn btn-danger call-end-btn" type="button" aria-label="Cancel call"><i class="bi bi-telephone-x"></i></button>
      </div>
    </section>`);
  document.querySelector('#call-overlay .call-end-btn')?.addEventListener('click', () => finishCurrentCall(true));
}

function renderIncoming() {
  if (!currentCall) return;
  const name = displayName(currentCall);
  const color = avatarColor(name);
  const initials = getInitials(name);
  const kind = currentCall.callType === 'video' ? 'video' : 'audio';
  showOverlay(`
    <section class="call-screen incoming-call" role="dialog" aria-modal="true" aria-label="Incoming ${kind} call">
      <div class="call-avatar" style="background-color:${color}">${escapeHtml(initials)}</div>
      <div class="call-name-large">${escapeHtml(name)}</div>
      <div class="call-status-text">Incoming ${kind} call…</div>
      <div class="call-actions incoming-actions">
        <button class="btn btn-success call-accept-btn" type="button" aria-label="Accept call"><i class="bi bi-telephone"></i></button>
        <button class="btn btn-danger call-reject-btn" type="button" aria-label="Reject call"><i class="bi bi-telephone-x"></i></button>
      </div>
    </section>`);
  document.querySelector('#call-overlay .call-accept-btn')?.addEventListener('click', acceptIncomingCall);
  document.querySelector('#call-overlay .call-reject-btn')?.addEventListener('click', rejectIncomingCall);
}

function renderActive() {
  if (!currentCall) return;
  clearInterval(callTimer);
  callStartedAt = Date.now();
  callAssistMode = false;
  lastAssistMessageId = null;
  lastAssistMessageText = '';
  const name = displayName(currentCall);
  const color = avatarColor(name);
  const initials = getInitials(name);
  const isVideo = currentCall.callType === 'video';
  const mediaMarkup = isVideo
    ? `<div class="call-normal-view" data-call-normal-view>
         <div class="call-media video-call-media">
           <video id="remote-video" class="remote-video" autoplay playsinline aria-label="Remote video"></video>
           <video id="local-video" class="local-video" autoplay muted playsinline aria-label="Your video"></video>
         </div>
       </div>
       <section class="call-assist-view" data-call-assist-view hidden aria-label="Video Assist workspace">
         <div class="call-assist-peer-preview">
           <video id="assist-remote-video" autoplay muted playsinline aria-label="Other participant video"></video>
           <span>Video call</span>
         </div>
         <div id="call-video-assist-root" class="call-video-assist-root"></div>
       </section>
       <section id="call-assist-received-message" class="call-assist-received-message" hidden aria-label="Last received sign message">
         <div class="call-assist-message-heading">
           <span><i class="bi bi-chat-square-text me-1"></i> Last sign message</span>
           <span class="call-assist-message-status" data-call-assist-message-status aria-live="polite"></span>
         </div>
         <p id="call-assist-received-text" class="call-assist-received-text" aria-live="polite"></p>
         <button type="button" class="btn btn-sm btn-outline-primary" id="call-assist-replay" aria-label="Speak the last sign message again"><i class="bi bi-volume-up me-1"></i> Speak again</button>
       </section>`
    : `<audio id="remote-audio" class="remote-audio" autoplay playsinline></audio><div class="call-media video-call-media audio-upgrade-media" hidden><video id="remote-video" class="remote-video" autoplay playsinline aria-label="Remote video"></video><video id="local-video" class="local-video" autoplay muted playsinline aria-label="Your video"></video></div>`;

  const overlay = showOverlay(`
    <section class="call-screen active-call ${isVideo ? 'video-call-screen' : 'audio-call-screen'}" role="dialog" aria-modal="true" aria-label="Active call">
      ${isVideo ? '' : `<div class="call-avatar" style="background-color:${color}">${escapeHtml(initials)}</div>`}
      <div class="call-name-large">${escapeHtml(name)}</div>
      <div class="call-status-text" id="call-status-text">Connecting…</div>
      <div class="call-timer" id="call-timer" aria-live="polite">00:00</div>
      ${mediaMarkup}
      <div class="call-controls" aria-label="Call controls">
        <button class="btn call-control-btn" id="mute-btn" type="button" aria-label="Mute microphone" aria-pressed="false"><i class="bi bi-mic-fill"></i></button>
        <button class="btn call-control-btn" id="camera-btn" type="button" aria-label="Turn camera on" aria-pressed="false"><i class="bi bi-camera-video-off-fill"></i></button>
        ${isVideo ? '<button class="btn call-control-btn" id="switch-camera-btn" type="button" aria-label="Switch camera" title="Switch camera" hidden><i class="bi bi-camera-reverse-fill"></i></button>' : ''}
        <button class="btn call-control-btn" id="speaker-btn" type="button" aria-label="Mute speaker" aria-pressed="false"><i class="bi bi-volume-up-fill"></i></button>
        ${isVideo ? '<button class="btn call-control-btn call-assist-mode-btn" id="assist-mode-btn" type="button" aria-label="Enter Video Assist mode" aria-pressed="false"><i class="bi bi-hand-index-thumb"></i><span>Assist</span></button>' : ''}
        <button class="btn btn-danger call-end-btn" type="button" aria-label="End call"><i class="bi bi-telephone-x-fill"></i></button>
      </div>
    </section>`);

  const localStream = mediaManager.getStream();
  const localVideo = overlay.querySelector('#local-video');
  if (localVideo && localStream) localVideo.srcObject = localStream;
  const cameraButton = overlay.querySelector('#camera-btn');
  const cameraInitiallyOn = isVideo && Boolean(localStream?.getVideoTracks().some((track) => track.enabled && track.readyState === 'live'));
  if (cameraButton && cameraInitiallyOn) {
    cameraButton.setAttribute('aria-pressed', 'true');
    cameraButton.setAttribute('aria-label', 'Turn camera off');
    cameraButton.innerHTML = '<i class="bi bi-camera-video-fill"></i>';
  }
  attachRemoteStream(getRemoteStream());
  mediaManager.setSpeakerEnabled(speakerEnabled);

  if (isVideo) {
    const assistRoot = overlay.querySelector('#call-video-assist-root');
    videoAssistController.init(assistRoot, {
      mode: 'call',
      streamProvider: () => mediaManager.getStream(),
      resetDraft: true,
      onSendDraft: (text, options = {}) => sendAssistDraft(text, Boolean(options.speak)),
    });
    void refreshCameraSwitchButton();
  }

  overlay.querySelector('#mute-btn')?.addEventListener('click', () => {
    const muted = mediaManager.toggleMute();
    const button = overlay.querySelector('#mute-btn');
    button?.setAttribute('aria-pressed', String(muted));
    if (button) button.innerHTML = muted ? '<i class="bi bi-mic-mute-fill"></i>' : '<i class="bi bi-mic-fill"></i>';
    button?.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
  });
  overlay.querySelector('#camera-btn')?.addEventListener('click', async () => {
    const button = overlay.querySelector('#camera-btn');
    if (!button || !currentCall) return;
    button.disabled = true;
    try {
      let enabled;
      const stream = mediaManager.getStream();
      const tracks = stream?.getVideoTracks() || [];
      if (tracks.length) {
        enabled = !tracks[0].enabled;
        tracks.forEach((track) => { track.enabled = enabled; });
        if (!enabled && callAssistMode) {
          videoAssistController.stop();
          videoAssistController.setStatusMessage('Camera is off. Turn it on to resume sign recognition.', 'muted');
        }
      } else {
        const peer = getPeerConnection();
        if (!peer || peer.signalingState !== 'stable') throw new Error('Call negotiation is busy. Please try turning the camera on again.');
        // Acquire only video so a camera permission failure never disrupts the active microphone.
        const cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
        const track = cameraStream.getVideoTracks()[0];
        if (!track || !stream) throw new Error('The camera did not provide a usable video track.');
        stream.addTrack(track);
        await addLocalTrack(track, stream);
        enabled = true;
        const localVideoEl = document.querySelector('#call-overlay #local-video');
        if (localVideoEl) localVideoEl.srcObject = stream;
        const pc = getPeerConnection();
        if (pc?.signalingState === 'stable') {
          const offer = await createOffer();
          requireSendResult(sendOffer(currentCall.id, offer), 'camera upgrade offer');
        } else {
          throw new Error('Call negotiation is busy. Please try turning the camera on again.');
        }
      }
      const media = document.querySelector('#call-overlay .audio-upgrade-media');
      const remoteHasVideo = Boolean(getRemoteStream()?.getVideoTracks().some((track) => track.readyState === 'live'));
      if (media) media.hidden = !enabled && !remoteHasVideo;
      button.setAttribute('aria-pressed', String(enabled));
      button.innerHTML = enabled ? '<i class="bi bi-camera-video-fill"></i>' : '<i class="bi bi-camera-video-off-fill"></i>';
      button.setAttribute('aria-label', enabled ? 'Turn camera off' : 'Turn camera on');
      if (currentCall?.callType === 'video') {
        if (enabled && callAssistMode) {
          videoAssistController.refreshStream();
          videoAssistController.setStatusMessage('Camera is on. Start hands-free when you are ready.', 'muted');
        }
        void refreshCameraSwitchButton();
      }
    } catch (error) {
      console.warn('[calls] Camera toggle failed:', error);
      notify(error?.message || 'Could not enable the camera. Your audio call is still active.');
    } finally {
      button.disabled = false;
    }
  });
  overlay.querySelector('#switch-camera-btn')?.addEventListener('click', switchCamera);
  overlay.querySelector('#assist-mode-btn')?.addEventListener('click', () => setCallAssistMode(!callAssistMode));
  overlay.querySelector('#speaker-btn')?.addEventListener('click', () => {
    speakerEnabled = !speakerEnabled;
    mediaManager.setSpeakerEnabled(speakerEnabled);
    const button = overlay.querySelector('#speaker-btn');
    button?.setAttribute('aria-pressed', String(!speakerEnabled));
    if (button) button.innerHTML = speakerEnabled ? '<i class="bi bi-volume-up-fill"></i>' : '<i class="bi bi-volume-mute-fill"></i>';
    button?.setAttribute('aria-label', speakerEnabled ? 'Mute speaker' : 'Unmute speaker');
    if (!speakerEnabled && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const status = overlay.querySelector('[data-call-assist-message-status]');
      if (status && lastAssistMessageText) status.textContent = 'Speaker muted · message remains visible';
    }
  });
  overlay.querySelector('#call-assist-replay')?.addEventListener('click', () => {
    if (lastAssistMessageText) speakReceivedAssistMessage(lastAssistMessageText, true);
  });
  overlay.querySelector('.call-end-btn')?.addEventListener('click', () => finishCurrentCall(true));

  callTimer = setInterval(() => {
    const timer = document.querySelector('#call-overlay #call-timer');
    if (timer && callStartedAt) timer.textContent = formatDuration(Math.floor((Date.now() - callStartedAt) / 1000));
  }, 1000);
}

function createAssistMessageId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sendAssistDraft(text, speak) {
  if (!currentCall || currentCall.callType !== 'video' || currentCall.status !== 'accepted') {
    return Promise.reject(new Error('Video Assist messages can only be sent during an active video call.'));
  }
  if (!isWebSocketConnected()) {
    return Promise.reject(new Error('Realtime connection is unavailable. Reconnect before sending.'));
  }

  const callId = currentCall.id;
  const messageId = createAssistMessageId();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingAssistMessages.delete(messageId);
      reject(new Error('Delivery confirmation timed out. Check whether the other participant received the message before sending it again.'));
    }, 12_000);
    pendingAssistMessages.set(messageId, { callId, resolve, reject, timeout });
    try {
      const sent = sendCallAssistMessage(callId, messageId, text, speak);
      if (sent === false) throw new Error('Realtime connection was lost; could not send the sign message.');
    } catch (error) {
      clearTimeout(timeout);
      pendingAssistMessages.delete(messageId);
      reject(error);
    }
  });
}

function setCallAssistMode(enabled) {
  if (!currentCall || currentCall.callType !== 'video') return;
  callAssistMode = Boolean(enabled);
  const overlay = document.getElementById('call-overlay');
  const normalView = overlay?.querySelector('[data-call-normal-view]');
  const assistView = overlay?.querySelector('[data-call-assist-view]');
  const button = overlay?.querySelector('#assist-mode-btn');
  if (normalView) normalView.hidden = callAssistMode;
  if (assistView) assistView.hidden = !callAssistMode;
  if (button) {
    button.setAttribute('aria-pressed', String(callAssistMode));
    button.setAttribute('aria-label', callAssistMode ? 'Return to normal video call' : 'Enter Video Assist mode');
    button.innerHTML = callAssistMode
      ? '<i class="bi bi-camera-video me-1"></i><span>Video call</span>'
      : '<i class="bi bi-hand-index-thumb me-1"></i><span>Assist</span>';
  }
  videoAssistController.setVisible(callAssistMode);
  if (callAssistMode) {
    const cameraIsOn = mediaManager.getStream()?.getVideoTracks().some((track) => track.enabled && track.readyState === 'live');
    if (!cameraIsOn) videoAssistController.setStatusMessage('Turn your camera on using the call controls before starting hands-free.', 'muted');
  }
}

async function refreshCameraSwitchButton() {
  const button = document.querySelector('#call-overlay #switch-camera-btn');
  if (!button) return;
  if (currentCall?.callType !== 'video' || !navigator.mediaDevices?.enumerateDevices) {
    button.hidden = true;
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === 'videoinput' && device.deviceId);
    button.hidden = cameras.length < 2;
    button.disabled = cameras.length < 2;
    if (cameras.length >= 2) button.title = `Switch camera (${cameras.length} available)`;
  } catch (error) {
    console.warn('[calls] Could not enumerate cameras:', error);
    button.hidden = true;
  }
}

async function switchCamera() {
  const button = document.querySelector('#call-overlay #switch-camera-btn');
  const stream = mediaManager.getStream();
  const oldTrack = stream?.getVideoTracks()[0];
  if (!button || !stream || !oldTrack || currentCall?.callType !== 'video') return;
  const switchingCallId = currentCall.id;
  button.disabled = true;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (currentCall?.id !== switchingCallId) return;
    const cameras = devices.filter((device) => device.kind === 'videoinput' && device.deviceId);
    if (cameras.length < 2) {
      button.hidden = true;
      return;
    }
    const currentDeviceId = oldTrack.getSettings?.().deviceId || '';
    const currentIndex = cameras.findIndex((device) => device.deviceId === currentDeviceId);
    const nextIndex = currentIndex < 0 ? 1 : (currentIndex + 1) % cameras.length;
    const nextDevice = cameras[nextIndex];
    const replacementStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: { exact: nextDevice.deviceId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    const newTrack = replacementStream.getVideoTracks()[0];
    if (!newTrack) throw new Error('The selected camera did not provide a video track.');
    if (currentCall?.id !== switchingCallId) { newTrack.stop(); return; }
    newTrack.enabled = oldTrack.enabled;
    try {
      await replaceLocalVideoTrack(newTrack);
      if (currentCall?.id !== switchingCallId) { newTrack.stop(); return; }
    } catch (error) {
      newTrack.stop();
      throw error;
    }
    stream.removeTrack(oldTrack);
    stream.addTrack(newTrack);
    oldTrack.stop();
    videoAssistController.refreshStream();
    const localVideo = document.querySelector('#call-overlay #local-video');
    if (localVideo) localVideo.srcObject = stream;
    button.title = nextDevice.label || 'Switch camera';
    notify(`Camera switched${nextDevice.label ? ` to ${nextDevice.label}` : ''}.`, 'success');
  } catch (error) {
    console.error('[calls] Camera switch failed:', error);
    notify(error?.message || 'Could not switch cameras. Your current camera remains selected.');
  } finally {
    button.disabled = false;
    void refreshCameraSwitchButton();
  }
}

function speakReceivedAssistMessage(text, isReplay = false) {
  const status = document.querySelector('#call-overlay [data-call-assist-message-status]');
  if (!speakerEnabled) {
    if (status) status.textContent = 'Unmute the speaker to play this message.';
    return;
  }
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
    if (status) status.textContent = 'Speech is unavailable in this browser.';
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-IN';
    utterance.onstart = () => { if (status) status.textContent = 'Speaking…'; };
    utterance.onend = () => { if (status) status.textContent = 'Voice playback finished'; };
    utterance.onerror = (event) => {
      if (status) status.textContent = event?.error === 'not-allowed'
        ? 'Tap “Speak again” to allow spoken playback.'
        : 'Could not play speech. Tap “Speak again” to retry.';
    };
    window.speechSynthesis.speak(utterance);
    if (status) status.textContent = isReplay ? 'Playing last message…' : 'Starting spoken playback…';
  } catch (error) {
    console.warn('[calls] Remote speech playback failed:', error);
    if (status) status.textContent = 'Tap “Speak again” to retry spoken playback.';
  }
}

function onCallAssistMessage(payload) {
  if (!currentCall || currentCall.callType !== 'video' || payload?.callId !== currentCall.id) return;
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text || text.length > 5000 || (payload.messageId && payload.messageId === lastAssistMessageId)) return;
  lastAssistMessageId = payload.messageId || null;
  lastAssistMessageText = text;
  const card = document.querySelector('#call-overlay #call-assist-received-message');
  const message = document.querySelector('#call-overlay #call-assist-received-text');
  if (message) message.textContent = text;
  if (card) card.hidden = false;
  const status = document.querySelector('#call-overlay [data-call-assist-message-status]');
  if (status) status.textContent = payload.speak ? 'Spoken message requested' : 'Text message';
  if (payload.speak && speakerEnabled) speakReceivedAssistMessage(text);
  else if (payload.speak && status) status.textContent = 'Message received · speaker is muted';
}

function onCallAssistMessageSent(payload) {
  if (!currentCall || payload?.callId !== currentCall.id) return;
  const pending = payload?.messageId ? pendingAssistMessages.get(payload.messageId) : null;
  if (pending && pending.callId === payload.callId) {
    clearTimeout(pending.timeout);
    pendingAssistMessages.delete(payload.messageId);
    pending.resolve(true);
  }
  videoAssistController.setStatusMessage('Message delivered to the other participant.', 'success');
}

function onCallAssistMessageError(payload) {
  if (!currentCall) return;
  if (payload?.callId && payload.callId !== currentCall.id) return;
  const detail = payload?.detail || 'Could not send the sign message.';
  const pending = payload?.messageId ? pendingAssistMessages.get(payload.messageId) : null;
  if (pending && (!payload?.callId || pending.callId === payload.callId)) {
    clearTimeout(pending.timeout);
    pendingAssistMessages.delete(payload.messageId);
    pending.reject(new Error(detail));
  }
  videoAssistController.setStatusMessage(detail, 'error');
  notify(detail);
}

function formatDuration(seconds) {
  const mins = Math.floor(Math.max(0, seconds) / 60);
  const secs = Math.max(0, seconds) % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function attachRemoteStream(stream) {
  if (!stream) return;
  const hasRemoteVideo = stream.getVideoTracks().length > 0;
  const videoTargets = document.querySelectorAll('#call-overlay #remote-video, #call-overlay #assist-remote-video');
  const audioTarget = document.querySelector('#call-overlay #remote-audio');
  const upgradedMedia = document.querySelector('#call-overlay .audio-upgrade-media');
  if (upgradedMedia && hasRemoteVideo) upgradedMedia.hidden = false;
  if (hasRemoteVideo && audioTarget) { audioTarget.pause(); audioTarget.srcObject = null; }

  const targets = hasRemoteVideo ? [...videoTargets] : [audioTarget].filter(Boolean);
  targets.forEach((target) => {
    if (target.srcObject !== stream) target.srcObject = stream;
    target.volume = speakerEnabled ? 1 : 0;
    const playPromise = target.play?.();
    if (playPromise?.catch) {
      playPromise.catch(() => {
        const status = document.querySelector('#call-overlay #call-status-text');
        if (status) status.textContent = 'Connected. Tap the media area if audio does not start.';
      });
    }
  });
}

async function preparePeer() {
  if (!currentCall) throw new Error('No active call session.');
  await mediaManager.getLocalStream(currentCall.callType === 'video');
  await createPeerConnection(currentCall.id);
  const localVideo = document.querySelector('#call-overlay #local-video');
  if (localVideo) localVideo.srcObject = mediaManager.getStream();
  const tracks = mediaManager.getStream()?.getVideoTracks() || [];
  const cameraButton = document.querySelector('#call-overlay #camera-btn');
  const cameraOn = tracks.some((track) => track.enabled && track.readyState === 'live');
  if (cameraButton && currentCall.callType === 'video') {
    cameraButton.setAttribute('aria-pressed', String(cameraOn));
    cameraButton.setAttribute('aria-label', cameraOn ? 'Turn camera off' : 'Turn camera on');
    cameraButton.innerHTML = cameraOn ? '<i class="bi bi-camera-video-fill"></i>' : '<i class="bi bi-camera-video-off-fill"></i>';
  }
  if (currentCall.callType === 'video') void refreshCameraSwitchButton();
}

function requireSendResult(result, label) {
  if (result === false) throw new Error(`Realtime connection was lost; could not send the ${label}.`);
}

async function startOutgoingCall(userId, callType = 'audio') {
  if (currentCall || outgoingRequestPending) {
    notify('Finish your current call before starting another one.');
    return;
  }
  if (!userId) return;

  outgoingRequestPending = true;
  try {
    if (!isWebSocketConnected()) {
      const connected = await waitForWebSocket(10_000);
      if (!connected) throw new Error('Realtime connection is unavailable. Reconnect and try again.');
    }

    const call = await createCall(userId, callType);
    currentCall = {
      id: call.id,
      role: 'caller',
      callType: call.callType || callType,
      displayName: call.displayName || 'Calling…',
      avatarUrl: call.avatarUrl || null,
      status: call.status || 'ringing',
    };
    speakerEnabled = true;
    outgoingRequestPending = false;
    renderOutgoing();

    const pendingEvent = pendingLifecycleEvents.get(call.id);
    pendingLifecycleEvents.delete(call.id);
    if (pendingEvent) {
      if (pendingEvent.type === EventTypes.CALL_ACCEPTED) await onAccepted(pendingEvent.payload);
      else if (pendingEvent.type === EventTypes.CALL_REJECTED) onRejected(pendingEvent.payload);
      else if (pendingEvent.type === EventTypes.CALL_ENDED) onEnded(pendingEvent.payload);
      if (!currentCall || currentCall.id !== call.id) return;
    }

    clearTimeout(ringTimeout);
    if (currentCall.status === 'ringing') {
      ringTimeout = setTimeout(async () => {
        if (currentCall?.id === call.id && currentCall.status === 'ringing') {
          notify('No answer. The call has been cancelled.', 'secondary');
          await finishCurrentCall(true);
        }
      }, 45_000);
    }
  } catch (error) {
    outgoingRequestPending = false;
    pendingLifecycleEvents.clear();
    console.error('[calls] Could not start call:', error);
    notify(error.message || 'Could not start the call.');
  }
}

function waitForWebSocket(timeoutMs) {
  if (isWebSocketConnected()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    let finished = false;
    const finish = (connected) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve(connected);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    unsubscribe = onWebSocketStateChange((state) => {
      if (state === 'connected') finish(true);
    });
    if (finished) unsubscribe();
  });
}

async function acceptIncomingCall() {
  if (!currentCall || currentCall.role !== 'callee' || currentCall.status !== 'ringing') return;
  const incoming = { ...currentCall };
  try {
    // Create the peer connection before accepting. Once the backend notifies the
    // caller, it may immediately send an SDP offer and ICE candidates.
    await preparePeer();
    await acceptCall(incoming.id);
    if (!currentCall || currentCall.id !== incoming.id) return;
    clearTimeout(ringTimeout);
    currentCall.status = 'accepted';
    renderActive();
  } catch (error) {
    console.error('[calls] Could not accept call:', error);
    closePeerConnection();
    mediaManager.stopLocalStream();
    if (currentCall?.id === incoming.id) {
      currentCall.status = 'ringing';
      renderIncoming();
    }
    notify(error.message || 'Could not access the microphone/camera or accept the call.');
  }
}

async function rejectIncomingCall() {
  if (!currentCall || currentCall.role !== 'callee') return;
  const callId = currentCall.id;
  try {
    await rejectCall(callId);
  } catch (error) {
    console.error('[calls] Could not reject call:', error);
    notify(error.message || 'Could not reject the call.');
  } finally {
    cleanupCall(false);
  }
}

async function onAccepted(payload) {
  if ((!currentCall || currentCall.id !== payload?.callId) && outgoingRequestPending && payload?.callId) {
    pendingLifecycleEvents.set(payload.callId, { type: EventTypes.CALL_ACCEPTED, payload });
    return;
  }
  if (!currentCall || currentCall.id !== payload?.callId || currentCall.role !== 'caller') return;
  clearTimeout(ringTimeout);
  currentCall.status = 'accepted';
  currentCall.displayName = payload.displayName || currentCall.displayName;
  currentCall.avatarUrl = payload.avatarUrl || currentCall.avatarUrl;
  renderActive();
  try {
    await preparePeer();
    const localVideoTracks = mediaManager.getStream()?.getVideoTracks() || [];
    const cameraEnabled = localVideoTracks.some((track) => track.enabled && track.readyState === 'live');
    const cameraButton = document.querySelector('#call-overlay #camera-btn');
    if (cameraButton) {
      cameraButton.setAttribute('aria-pressed', String(cameraEnabled));
      cameraButton.setAttribute('aria-label', cameraEnabled ? 'Turn camera off' : 'Turn camera on');
      cameraButton.innerHTML = cameraEnabled ? '<i class="bi bi-camera-video-fill"></i>' : '<i class="bi bi-camera-video-off-fill"></i>';
    }
    if (currentCall.callType === 'video') void refreshCameraSwitchButton();
    const offer = await createOffer();
    requireSendResult(sendOffer(currentCall.id, offer), 'offer');
  } catch (error) {
    console.error('[calls] Offer setup failed:', error);
    notify(error.message || 'Could not establish the call.');
    await finishCurrentCall(true);
  }
}

async function onOffer(payload) {
  if (!currentCall || currentCall.id !== payload?.callId || currentCall.status !== 'accepted') return;
  try {
    await setRemoteDescription(payload.offer);
    const answer = await createAnswer();
    requireSendResult(sendAnswer(currentCall.id, answer), 'answer');
  } catch (error) {
    console.error('[calls] Could not process offer:', error);
    const peer = getPeerConnection();
    if (peer?.connectionState === 'connected') {
      notify('The camera change could not be negotiated. Your existing call remains active.');
      return;
    }
    notify('Could not establish the call connection.');
    await finishCurrentCall(true);
  }
}

async function onAnswer(payload) {
  if (!currentCall || currentCall.id !== payload?.callId) return;
  try {
    await setRemoteDescription(payload.answer);
  } catch (error) {
    console.error('[calls] Could not process answer:', error);
    const peer = getPeerConnection();
    if (peer?.connectionState === 'connected') {
      notify('The camera change could not be negotiated. Your existing call remains active.');
      return;
    }
    notify('Could not complete call negotiation.');
    await finishCurrentCall(true);
  }
}

async function onIceCandidate(payload) {
  if (!currentCall || currentCall.id !== payload?.callId || !payload.candidate) return;
  try {
    await addIceCandidate(payload.candidate);
  } catch (error) {
    console.warn('[calls] Ignoring an ICE candidate that could not be added:', error);
  }
}

function onIncoming(payload) {
  if (!payload?.callId) return;
  if (currentCall || outgoingRequestPending) {
    if (currentCall?.id === payload.callId) return;
    // One active call per account. Decline an additional incoming call rather
    // than replacing the current session and leaking its media tracks.
    rejectCall(payload.callId).catch((error) => console.warn('[calls] Busy decline failed:', error));
    return;
  }
  currentCall = {
    id: payload.callId,
    role: 'callee',
    callType: payload.callType === 'video' ? 'video' : 'audio',
    displayName: payload.displayName || 'Unknown',
    avatarUrl: payload.avatarUrl || null,
    status: 'ringing',
  };
  renderIncoming();
}

function onRejected(payload) {
  if ((!currentCall || currentCall.id !== payload?.callId) && outgoingRequestPending && payload?.callId) {
    pendingLifecycleEvents.set(payload.callId, { type: EventTypes.CALL_REJECTED, payload });
    return;
  }
  if (!currentCall || (payload?.callId && currentCall.id !== payload.callId)) return;
  notify('The call was declined.', 'secondary');
  cleanupCall(true);
}

function onEnded(payload) {
  if ((!currentCall || currentCall.id !== payload?.callId) && outgoingRequestPending && payload?.callId) {
    pendingLifecycleEvents.set(payload.callId, { type: EventTypes.CALL_ENDED, payload });
    return;
  }
  if (!currentCall || (payload?.callId && currentCall.id !== payload.callId)) return;
  cleanupCall(true);
}

function onCallError(payload) {
  const detail = payload?.detail || 'Call signaling failed.';
  const status = document.querySelector('#call-overlay #call-status-text');
  if (status) status.textContent = detail;
  else notify(detail);
}

async function finishCurrentCall(notifyServer) {
  const callId = currentCall?.id;
  if (!callId) return;
  if (notifyServer) {
    try {
      await endCall(callId);
    } catch (error) {
      console.error('[calls] End request failed:', error);
      notify('Call ended locally, but the server could not be notified. Check your connection.');
    }
  }
  cleanupCall(true);
}

function cleanupCall(refreshHistory) {
  const overlay = document.getElementById('call-overlay');
  pendingAssistMessages.forEach((pending) => {
    clearTimeout(pending.timeout);
    pending.reject(new Error('The call ended before message delivery was confirmed.'));
  });
  pendingAssistMessages.clear();
  videoAssistController.destroy();
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  callAssistMode = false;
  lastAssistMessageId = null;
  lastAssistMessageText = '';
  clearTimeout(ringTimeout);
  ringTimeout = null;
  clearInterval(callTimer);
  callTimer = null;
  callStartedAt = null;
  closePeerConnection();
  mediaManager.stopLocalStream();
  if (overlay) {
    overlay.innerHTML = '';
    overlay.style.display = 'none';
  }
  currentCall = null;
  outgoingRequestPending = false;
  speakerEnabled = true;
  window.dispatchEvent(new CustomEvent('aperture:call-finished'));
  if (refreshHistory) window.dispatchEvent(new CustomEvent('aperture:call-history-refresh'));
}

/**
 * Attach the UI/signaling lifecycle to a call already created by Voice Assist.
 * Do not call createCall here: the Assist API has already persisted the call and
 * notified the recipient. This ensures the caller sees the ringing screen and
 * can receive the existing call.accepted event using the same call ID.
 */
function attachExistingOutgoingCall(call) {
  // The Assist API uses `callId` in its JSON response, while the regular
  // call controller stores the identifier as `id`. Normalize at this boundary
  // so confirmed Voice Assist calls enter the same lifecycle as regular calls.
  if (call && !call.id && call.callId) call = { ...call, id: call.callId };
  if (!call?.id) throw new Error('Voice Assist did not return a call ID.');
  if (currentCall?.id === call.id) return true;
  if (currentCall || outgoingRequestPending) {
    notify('Finish your current call before starting another one.');
    return false;
  }

  currentCall = {
    id: call.id,
    role: 'caller',
    callType: call.callType === 'video' ? 'video' : 'audio',
    displayName: call.displayName || call.recipient?.displayName || call.recipientName || 'Unknown contact',
    avatarUrl: call.avatarUrl || null,
    status: call.status || 'ringing',
  };
  speakerEnabled = true;
  renderOutgoing();

  const pendingEvent = pendingLifecycleEvents.get(call.id);
  pendingLifecycleEvents.delete(call.id);
  if (pendingEvent) {
    if (pendingEvent.type === EventTypes.CALL_ACCEPTED) {
      onAccepted(pendingEvent.payload).catch((error) => {
        console.error('[calls] Could not resume Voice Assist call:', error);
      });
    } else if (pendingEvent.type === EventTypes.CALL_REJECTED) {
      onRejected(pendingEvent.payload);
    } else if (pendingEvent.type === EventTypes.CALL_ENDED) {
      onEnded(pendingEvent.payload);
    }
  }

  clearTimeout(ringTimeout);
  if (currentCall?.id === call.id && currentCall.status === 'ringing') {
    ringTimeout = setTimeout(async () => {
      if (currentCall?.id === call.id && currentCall.status === 'ringing') {
        notify('No answer. The call has been cancelled.', 'secondary');
        await finishCurrentCall(true);
      }
    }, 45_000);
  }
  return true;
}

export function initializeCallRuntime() {
  if (initialized) return;
  initialized = true;
  ensureOverlay();

  onRemoteTrack((stream) => attachRemoteStream(stream));
  onConnectionStateChange((state) => {
    const status = document.querySelector('#call-overlay #call-status-text');
    if (!status) return;
    if (state === 'connected') status.textContent = 'Connected';
    else if (state === 'connecting' || state === 'new') status.textContent = 'Connecting…';
    else if (state === 'disconnected') status.textContent = 'Connection interrupted…';
    else if (state === 'failed') status.textContent = 'Connection failed';
  });

  assistCallHandler = (event) => {
    try { attachExistingOutgoingCall(event.detail); }
    catch (error) { console.error('[calls] Could not attach Voice Assist call:', error); notify(error.message || 'Could not open the call screen.'); }
  };
  window.addEventListener('aperture:assist-call-created', assistCallHandler);

  subscriptions = [
    eventRouter.on(EventTypes.CALL_INCOMING, onIncoming),
    eventRouter.on(EventTypes.CALL_ACCEPTED, onAccepted),
    eventRouter.on(EventTypes.CALL_REJECTED, onRejected),
    eventRouter.on(EventTypes.CALL_ENDED, onEnded),
    eventRouter.on(EventTypes.CALL_OFFER, onOffer),
    eventRouter.on(EventTypes.CALL_ANSWER, onAnswer),
    eventRouter.on(EventTypes.CALL_ICE, onIceCandidate),
    eventRouter.on(EventTypes.CALL_ASSIST_MESSAGE, onCallAssistMessage),
    eventRouter.on(EventTypes.CALL_ASSIST_MESSAGE_SENT, onCallAssistMessageSent),
    eventRouter.on(EventTypes.CALL_ASSIST_MESSAGE_ERROR, onCallAssistMessageError),
    eventRouter.on(EventTypes.CALL_ERROR, onCallError),
  ];
}

export async function destroyCallRuntime() {
  if (!initialized) return;
  if (currentCall) await finishCurrentCall(false);
  subscriptions.forEach((unsubscribe) => unsubscribe());
  subscriptions = [];
  if (assistCallHandler) window.removeEventListener('aperture:assist-call-created', assistCallHandler);
  assistCallHandler = null;
  initialized = false;
}

export { startOutgoingCall, attachExistingOutgoingCall };
export default { initializeCallRuntime, destroyCallRuntime, startOutgoingCall, attachExistingOutgoingCall };
