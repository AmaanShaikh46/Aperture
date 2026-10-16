/**
 * APERTURE - WebRTC Media Manager
 * Manages local media stream (getUserMedia) and audio track controls.
 */

let localStream = null;

/** Request access to the microphone (and optionally camera). */
export async function getLocalStream(withVideo = false) {
  const constraints = {
    audio: true,
    video: withVideo ? { facingMode: 'user' } : false,
  };
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Media devices are not available in this browser.');
  }
  if (localStream) stopLocalStream();
  localStream = await navigator.mediaDevices.getUserMedia(constraints);
  return localStream;
}

/** Get the current local stream (or null). */
export function getStream() {
  return localStream;
}

/** Toggle the microphone mute state. Returns the new muted state. */
export function toggleMute() {
  if (!localStream) return false;
  let muted = false;
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = !track.enabled;
    muted = !track.enabled;
  });
  return muted;
}

/** Set the microphone mute state explicitly. */
export function setMuted(muted) {
  if (!localStream) return;
  localStream.getAudioTracks().forEach((track) => {
    track.enabled = !muted;
  });
}

/** Enable or disable speaker output (toggles audio output on the remote stream). */
export function setSpeakerEnabled(enabled) {
  const remoteMedia = document.querySelectorAll('audio.remote-audio, video.remote-video');
  remoteMedia.forEach((element) => { element.volume = enabled ? 1.0 : 0.0; });
}

/** Toggle local camera tracks. Returns true when video is enabled. */
export function toggleVideo() {
  if (!localStream) return false;
  const tracks = localStream.getVideoTracks();
  if (!tracks.length) return false;
  const enabled = !tracks[0].enabled;
  tracks.forEach((track) => { track.enabled = enabled; });
  return enabled;
}

/** Stop all tracks and release the local stream. */
export function stopLocalStream() {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
}

/** Check if the microphone is currently muted. */
export function isMuted() {
  if (!localStream) return false;
  const track = localStream.getAudioTracks()[0];
  return track ? !track.enabled : false;
}

export const mediaManager = {
  getLocalStream,
  getStream,
  toggleMute,
  setMuted,
  setSpeakerEnabled,
  toggleVideo,
  stopLocalStream,
  isMuted,
};
export default mediaManager;
