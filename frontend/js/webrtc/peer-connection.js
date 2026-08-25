/**
 * APERTURE - WebRTC Peer Connection
 * Wraps RTCPeerConnection lifecycle: offer/answer, ICE, remote track handling.
 */
import { getIceServers } from '../services/call-service.js';
import { mediaManager } from './media-manager.js';
import { signaling } from './signaling.js';

let pc = null;
let remoteStream = null;
let onRemoteTrackCb = null;
let onStateChangeCb = null;

/** Create a new RTCPeerConnection with ICE servers from the backend. */
export async function createPeerConnection() {
  if (pc) closePeerConnection();
  const iceServers = await getIceServers();
  pc = new RTCPeerConnection({ iceServers });

  remoteStream = new MediaStream();

  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => {
      remoteStream.addTrack(track);
    });
    if (onRemoteTrackCb) onRemoteTrackCb(remoteStream);
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      signaling.sendIceCandidate(event.candidate);
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[webrtc] ICE state:', pc.iceConnectionState);
  };

  pc.onconnectionstatechange = () => {
    console.log('[webrtc] Connection state:', pc.connectionState);
    if (onStateChangeCb) onStateChangeCb(pc.connectionState);
  };

  // Add local tracks.
  const localStream = mediaManager.getStream();
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  return pc;
}

/** Create an SDP offer and set it as the local description. */
export async function createOffer() {
  if (!pc) throw new Error('No peer connection.');
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  return offer;
}

/** Create an SDP answer and set it as the local description. */
export async function createAnswer() {
  if (!pc) throw new Error('No peer connection.');
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return answer;
}

/** Set the remote SDP description (offer or answer). */
export async function setRemoteDescription(description) {
  if (!pc) throw new Error('No peer connection.');
  await pc.setRemoteDescription(description);
}

/** Add a remote ICE candidate. */
export async function addIceCandidate(candidate) {
  if (!pc) return;
  await pc.addIceCandidate(candidate);
}

/** Get the current remote stream. */
export function getRemoteStream() {
  return remoteStream;
}

/** Register a callback for when a remote track arrives. */
export function onRemoteTrack(callback) {
  onRemoteTrackCb = callback;
}

/** Register a callback for connection state changes. */
export function onConnectionStateChange(callback) {
  onStateChangeCb = callback;
}

/** Close the peer connection and clean up. */
export function closePeerConnection() {
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.oniceconnectionstatechange = null;
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  remoteStream = null;
}

/** Get the current peer connection (or null). */
export function getPeerConnection() {
  return pc;
}

export default {
  createPeerConnection,
  createOffer,
  createAnswer,
  setRemoteDescription,
  addIceCandidate,
  getRemoteStream,
  onRemoteTrack,
  onConnectionStateChange,
  closePeerConnection,
  getPeerConnection,
};
