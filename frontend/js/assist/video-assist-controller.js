/**
 * APERTURE - Video Assist with sign static-pose recognition.
 * Camera frames are processed locally in the browser. The current model's
 * vocabulary is A-Z and 1-9; it does not translate continuous ISL sentences.
 */
import { buildsignFeatures, loadsignModel, predictSign } from './sign-classifier.js';
import { HandsFreeCharacterAcceptor } from './hands-free-acceptor.js';

const VISION_VERSION = '0.10.35';
const VISION_MODULE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/+esm`;
const VISION_WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`;
const HAND_LANDMARKER_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const PREDICTION_INTERVAL_MS = 180;
const CONFIDENCE_THRESHOLD = 0.45;
const STABILITY_WINDOW = 5;
const STABILITY_REQUIRED = 3;

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

let rootEl = null;
let videoEl = null;
let canvasEl = null;
let statusEl = null;
let detailEl = null;
let startButton = null;
let handsFreeButton = null;
let handsFreeMode = false;
const handsFreeAcceptor = new HandsFreeCharacterAcceptor();
let stopButton = null;
let recognitionButton = null;
let acceptButton = null;
let speakButton = null;
let draftEl = null;
let predictionEl = null;
let confidenceEl = null;
let mediaStream = null;
let landmarker = null;
let animationFrame = 0;
let running = false;
let recognizing = false;
let inferenceBusy = false;
let startGeneration = 0;
let lastFrameTime = -1;
let lastPredictionTime = 0;
let predictionHistory = [];
let stablePrediction = null;
let draft = '';

function setStatus(message, kind = 'muted') {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.dataset.status = kind;
}

function setButtons(isRunning, isLoading = false) {
  if (startButton) startButton.disabled = isRunning || isLoading;
  if (handsFreeButton) {
    handsFreeButton.disabled = isRunning || isLoading;
    handsFreeButton.textContent = isLoading
      ? 'Starting hands-free…'
      : (isRunning && handsFreeMode ? 'Hands-free active' : 'Start hands-free');
  }
  if (stopButton) stopButton.disabled = !isRunning && !isLoading;
  if (recognitionButton) {
    recognitionButton.disabled = !isRunning;
    recognitionButton.textContent = recognizing ? 'Pause recognition' : 'Start recognition';
    recognitionButton.classList.toggle('btn-primary', recognizing);
    recognitionButton.classList.toggle('btn-outline-primary', !recognizing);
  }
  if (acceptButton) {
    acceptButton.disabled = !stablePrediction || handsFreeMode;
    acceptButton.textContent = handsFreeMode ? 'Auto-accept enabled' : 'Accept character';
  }
  if (speakButton) speakButton.disabled = !draft.trim() || !('speechSynthesis' in window);
}

function clearCanvas() {
  const context = canvasEl?.getContext('2d');
  if (context) context.clearRect(0, 0, canvasEl.width, canvasEl.height);
  if (detailEl) detailEl.textContent = 'No hands detected yet.';
}

function drawHands(landmarksList) {
  if (!canvasEl || !videoEl) return;
  const width = videoEl.videoWidth || 640;
  const height = videoEl.videoHeight || 480;
  if (canvasEl.width !== width) canvasEl.width = width;
  if (canvasEl.height !== height) canvasEl.height = height;
  const context = canvasEl.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, width, height);

  for (const landmarks of landmarksList) {
    context.lineWidth = Math.max(2, width / 320);
    context.strokeStyle = '#22c55e';
    context.fillStyle = '#facc15';
    for (const [from, to] of HAND_CONNECTIONS) {
      const a = landmarks[from];
      const b = landmarks[to];
      if (!a || !b) continue;
      context.beginPath();
      context.moveTo(a.x * width, a.y * height);
      context.lineTo(b.x * width, b.y * height);
      context.stroke();
    }
    for (const point of landmarks) {
      context.beginPath();
      context.arc(point.x * width, point.y * height, Math.max(2.5, width / 180), 0, Math.PI * 2);
      context.fill();
    }
  }
  const count = landmarksList.length;
  if (detailEl) detailEl.textContent = count
    ? `${count} hand${count === 1 ? '' : 's'} detected · ${landmarksList[0].length} landmarks per hand`
    : 'No hands detected yet.';
}

async function ensureLandmarker() {
  if (landmarker) return landmarker;
  setStatus('Loading MediaPipe hand tracker…', 'loading');
  const vision = await import(/* @vite-ignore */ VISION_MODULE_URL);
  const files = await vision.FilesetResolver.forVisionTasks(VISION_WASM_URL);
  const options = {
    baseOptions: { modelAssetPath: HAND_LANDMARKER_MODEL, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.45,
    minHandPresenceConfidence: 0.45,
    minTrackingConfidence: 0.5,
  };
  try {
    landmarker = await vision.HandLandmarker.createFromOptions(files, options);
  } catch (gpuError) {
    console.warn('[Video Assist] GPU delegate unavailable; retrying on CPU.', gpuError);
    options.baseOptions.delegate = 'CPU';
    landmarker = await vision.HandLandmarker.createFromOptions(files, options);
  }
  return landmarker;
}

function resetPrediction() {
  predictionHistory = [];
  stablePrediction = null;
  if (predictionEl) predictionEl.textContent = 'Show a hand sign to begin.';
  if (confidenceEl) confidenceEl.textContent = 'Waiting for a stable prediction';
  if (acceptButton) acceptButton.disabled = true;
}

function formatTopGuesses(prediction) {
  if (!Array.isArray(prediction?.top3) || prediction.top3.length === 0) return '';
  const visible = prediction.top3
    .slice(0, 3)
    .map((item) => `${item.label} ${Math.round(item.confidence * 100)}%`)
    .join(' · ');
  const top = prediction.top3[0]?.confidence;
  const second = prediction.top3[1]?.confidence;
  const margin = Number.isFinite(top) && Number.isFinite(second)
    ? ` · top-two gap ${Math.round((top - second) * 100)} pts`
    : '';
  return `Model guesses: ${visible}${margin}`;
}

function updateStablePrediction(prediction) {
  const guesses = formatTopGuesses(prediction);
  if (!prediction || prediction.confidence < CONFIDENCE_THRESHOLD) {
    predictionHistory.push(null);
  } else {
    predictionHistory.push(prediction);
  }
  predictionHistory = predictionHistory.slice(-STABILITY_WINDOW);
  const counts = new Map();
  for (const item of predictionHistory) {
    if (!item) continue;
    const current = counts.get(item.label) || { count: 0, confidence: 0 };
    current.count += 1;
    current.confidence += item.confidence;
    counts.set(item.label, current);
  }
  const best = [...counts.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  if (best && best[1].count >= STABILITY_REQUIRED) {
    stablePrediction = {
      label: best[0],
      confidence: best[1].confidence / best[1].count,
    };
    if (predictionEl) predictionEl.textContent = stablePrediction.label;
    if (confidenceEl) {
      confidenceEl.textContent = `Stable candidate · ${Math.round(stablePrediction.confidence * 100)}% model score${guesses ? ` · ${guesses}` : ''}`;
    }
    if (handsFreeMode && recognizing
        && handsFreeAcceptor.observeCandidate(stablePrediction, performance.now())) {
      appendAutoAcceptedCharacter(stablePrediction.label);
    }
    if (acceptButton) acceptButton.disabled = handsFreeMode || !stablePrediction;
  } else {
    stablePrediction = null;
    if (predictionEl) predictionEl.textContent = prediction?.confidence >= CONFIDENCE_THRESHOLD ? prediction.label : '—';
    if (confidenceEl) {
      confidenceEl.textContent = `Stabilizing prediction… keep the pose steady${guesses ? ` · ${guesses}` : ''}`;
    }
    if (handsFreeMode) handsFreeAcceptor.observeCandidate(null, performance.now());
    if (acceptButton) acceptButton.disabled = true;
  }
}

async function infer(result) {
  const features = buildsignFeatures(result);
  if (!features) {
    predictionHistory.push(null);
    predictionHistory = predictionHistory.slice(-STABILITY_WINDOW);
    stablePrediction = null;
    if (handsFreeMode && recognizing) handsFreeAcceptor.observeNoHands(performance.now());
    if (predictionEl) predictionEl.textContent = '—';
    if (confidenceEl) confidenceEl.textContent = 'No hand detected';
    if (acceptButton) acceptButton.disabled = true;
    return;
  }
  if (inferenceBusy) return;
  inferenceBusy = true;
  try {
    const prediction = await predictSign(features);
    updateStablePrediction(prediction);
  } catch (error) {
    console.error('[Video Assist] inference failed:', error);
    recognizing = false;
    setButtons(running);
    setStatus(`Recognition could not run: ${error.message || 'model runtime error'}`, 'error');
  } finally {
    inferenceBusy = false;
  }
}

function processFrame() {
  if (!running || !videoEl || videoEl.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    if (running) animationFrame = requestAnimationFrame(processFrame);
    return;
  }
  const now = performance.now();
  if (now > lastFrameTime) {
    lastFrameTime = now;
    try {
      const result = landmarker.detectForVideo(videoEl, now);
      drawHands(result.landmarks || []);
      if (result.landmarks?.length) {
        if (!recognizing) setStatus('Hand tracking active · recognition paused', 'active');
        else if (!inferenceBusy && now - lastPredictionTime >= PREDICTION_INTERVAL_MS) {
          lastPredictionTime = now;
          void infer(result);
          setStatus(
            handsFreeMode
              ? 'Hands-free active · hold each sign steady; characters append automatically'
              : 'Hand tracking and sign recognition active',
            'success',
          );
        }
      } else {
        if (recognizing && now - lastPredictionTime >= PREDICTION_INTERVAL_MS) {
          lastPredictionTime = now;
          void infer(result);
        }
        setStatus(
          handsFreeMode && recognizing
            ? 'Hands-free active · briefly remove both hands to repeat the same character'
            : 'Camera active · show one or both hands',
          handsFreeMode && recognizing ? 'success' : 'active',
        );
      }
    } catch (error) {
      console.error('[Video Assist] Hand tracking failed:', error);
      stop();
      setStatus('Hand tracking stopped because a frame could not be processed.', 'error');
      return;
    }
  }
  animationFrame = requestAnimationFrame(processFrame);
}

async function start() {
  if (running || startButton?.disabled) return;
  const generation = ++startGeneration;
  setButtons(false, true);
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera access requires HTTPS or localhost and a supported browser.');
    }
    await ensureLandmarker();
    if (generation !== startGeneration) return;
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    });
    if (generation !== startGeneration) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
      return;
    }
    videoEl.srcObject = mediaStream;
    await videoEl.play();
    running = true;
    recognizing = false;
    canvasEl?.parentElement?.classList.add('is-active');
    lastFrameTime = -1;
    setButtons(true);
    setStatus('Camera active · start recognition when ready', 'active');
    animationFrame = requestAnimationFrame(processFrame);
  } catch (error) {
    console.error('[Video Assist] Could not start:', error);
    const message = error?.name === 'NotAllowedError'
      ? 'Camera permission was denied. Allow camera access and try again.'
      : error?.name === 'NotFoundError'
        ? 'No camera was found on this device.'
        : (error?.message || 'Could not start hand tracking.');
    setStatus(message, 'error');
    setButtons(false);
  }
}

async function startHandsFree() {
  if (running || handsFreeButton?.disabled) return;
  handsFreeMode = true;
  handsFreeAcceptor.reset();
  setStatus('Starting hands-free mode: loading hand tracking and sign recognition…', 'loading');
  await start();
  if (!running) {
    handsFreeMode = false;
    handsFreeAcceptor.reset();
    setButtons(false);
    return;
  }
  await toggleRecognition();
  if (!recognizing) {
    handsFreeMode = false;
    handsFreeAcceptor.reset();
    setButtons(running);
  }
}

async function toggleRecognition() {
  if (!running) return;
  if (recognizing) {
    recognizing = false;
    handsFreeMode = false;
    handsFreeAcceptor.reset();
    resetPrediction();
    setButtons(running);
    setStatus('Hand tracking active · recognition paused', 'active');
    return;
  }
  recognizing = true;
  resetPrediction();
  setButtons(running);
  setStatus('Loading classifier…', 'loading');
  try {
    await loadsignModel();
    if (!running || !recognizing) return;
    setStatus('sign loaded · show a steady hand sign', 'success');
  } catch (error) {
    console.error('[Video Assist] Classifier could not load:', error);
    recognizing = false;
    handsFreeMode = false;
    handsFreeAcceptor.reset();
    setButtons(running);
    setStatus(`Could not load sign: ${error.message || 'runtime/model load failed'}`, 'error');
  }
}

function acceptCharacter() {
  // Accept the last stable candidate even if recognition was paused immediately
  // after the candidate appeared. The UI may display a valid candidate while
  // `recognizing` changes between animation frames; that should not discard it.
  const label = stablePrediction?.label;
  if (typeof label !== 'string' || !/^[A-Z1-9]$/.test(label)) {
    setStatus('Wait for a stable character before accepting it.', 'muted');
    return;
  }
  draft += label;
  renderDraft();
  setStatus(`Added ${label} to the message draft.`, 'success');
}

function renderDraft() {
  if (draftEl) draftEl.textContent = draft || 'Your accepted characters will appear here.';
  setButtons(running);
}

function appendAutoAcceptedCharacter(label) {
  draft += label;
  renderDraft();
  setStatus(
    `Added ${label} automatically. To repeat it, briefly remove both hands from the camera, then show the sign again.`,
    'success',
  );
}

function speakDraft() {
  const text = draft.trim();
  if (!text || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-IN';
  window.speechSynthesis.speak(utterance);
}

function stop() {
  startGeneration += 1;
  running = false;
  recognizing = false;
  handsFreeMode = false;
  handsFreeAcceptor.reset();
  inferenceBusy = false;
  if (animationFrame) cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (videoEl) {
    videoEl.pause();
    videoEl.srcObject = null;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  clearCanvas();
  canvasEl?.parentElement?.classList.remove('is-active');
  resetPrediction();
  setButtons(false);
  setStatus('Camera is off. Start hand tracking when you are ready.', 'muted');
}

function render() {
  rootEl.innerHTML = `
    <div class="video-assist-card">
      <div class="video-assist-heading">
        <div><h2 class="h5 mb-1">Video Assist</h2><p class="text-muted small mb-0">hand-pose recognition</p></div>
        <span class="video-assist-badge">35 static classes</span>
      </div>
      <p class="video-assist-note">Recognizes the model's alphabet and digit classes (A–Z, 1–9). Choose Start hands-free to start the camera and recognition in one step; stable characters are appended automatically. This is static-pose character recognition, not continuous ISL sentence translation. Camera processing stays in your browser.</p>
      <div class="video-assist-preview" aria-label="Camera preview with hand landmarks">
        <video class="video-assist-video" autoplay muted playsinline aria-label="Your camera preview"></video>
        <canvas class="video-assist-canvas" aria-hidden="true"></canvas>
        <div class="video-assist-camera-placeholder"><i class="bi bi-camera-video"></i><span>Camera is off</span></div>
      </div>
      <div class="video-assist-status" role="status" aria-live="polite" data-status="muted">Camera is off. Start hand tracking when you are ready.</div>
      <p class="video-assist-detail text-muted small">No hands detected yet.</p>
      <div class="video-assist-actions">
        <button type="button" class="btn btn-success" data-video-assist-hands-free><i class="bi bi-hand-index-thumb me-1"></i> Start hands-free</button>
        <button type="button" class="btn btn-primary" data-video-assist-start><i class="bi bi-camera-video me-1"></i> Start camera</button>
        <button type="button" class="btn btn-outline-primary" data-video-assist-recognition disabled>Start recognition</button>
        <button type="button" class="btn btn-outline-secondary" data-video-assist-stop disabled><i class="bi bi-camera-video-off me-1"></i> Stop camera</button>
      </div>
      <section class="video-assist-recognition" aria-label="Sign recognition output">
        <div class="video-assist-recognition-heading"><span>Current stable candidate</span><strong data-video-assist-prediction aria-live="polite">Show a hand sign to begin.</strong></div>
        <p class="video-assist-confidence" data-video-assist-confidence>Waiting for a stable prediction</p>
        <button type="button" class="btn btn-outline-primary" data-video-assist-accept disabled>Accept character</button>
        <p class="video-assist-note small mb-2" data-video-assist-hands-free-help>In hands-free mode, each stable character is added once. To repeat the same character, briefly take both hands out of view for about half a second. Space, corrections, and speech remain manual controls in this first version.</p>
        <label class="form-label mt-3 mb-1" for="video-assist-draft">Message draft</label>
        <div id="video-assist-draft" class="video-assist-draft" aria-live="polite">Your accepted characters will appear here.</div>
        <div class="video-assist-actions mt-2">
          <button type="button" class="btn btn-outline-secondary" data-video-assist-space>Add space</button>
          <button type="button" class="btn btn-outline-secondary" data-video-assist-backspace>Backspace</button>
          <button type="button" class="btn btn-outline-secondary" data-video-assist-clear>Clear draft</button>
          <button type="button" class="btn btn-success" data-video-assist-speak disabled><i class="bi bi-volume-up me-1"></i> Speak draft</button>
        </div>
      </section>
      <p class="video-assist-footnote">Requires camera permission and an internet connection for MediaPipe and the browser inference runtime. The first model load may take a few seconds.</p>
    </div>`;

  videoEl = rootEl.querySelector('.video-assist-video');
  canvasEl = rootEl.querySelector('.video-assist-canvas');
  statusEl = rootEl.querySelector('.video-assist-status');
  detailEl = rootEl.querySelector('.video-assist-detail');
  startButton = rootEl.querySelector('[data-video-assist-start]');
  handsFreeButton = rootEl.querySelector('[data-video-assist-hands-free]');
  stopButton = rootEl.querySelector('[data-video-assist-stop]');
  recognitionButton = rootEl.querySelector('[data-video-assist-recognition]');
  acceptButton = rootEl.querySelector('[data-video-assist-accept]');
  speakButton = rootEl.querySelector('[data-video-assist-speak]');
  draftEl = rootEl.querySelector('#video-assist-draft');
  predictionEl = rootEl.querySelector('[data-video-assist-prediction]');
  confidenceEl = rootEl.querySelector('[data-video-assist-confidence]');
  startButton.addEventListener('click', start);
  handsFreeButton.addEventListener('click', startHandsFree);
  stopButton.addEventListener('click', stop);
  recognitionButton.addEventListener('click', toggleRecognition);
  acceptButton.addEventListener('click', (event) => {
    event.preventDefault();
    acceptCharacter();
  });
  speakButton.addEventListener('click', speakDraft);
  rootEl.querySelector('[data-video-assist-space]').addEventListener('click', () => { draft += ' '; renderDraft(); });
  rootEl.querySelector('[data-video-assist-backspace]').addEventListener('click', () => { draft = draft.slice(0, -1); renderDraft(); });
  rootEl.querySelector('[data-video-assist-clear]').addEventListener('click', () => {
    draft = '';
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    renderDraft();
  });
  resetPrediction();
  renderDraft();
  setButtons(false);
}

export const videoAssistController = {
  init(root) {
    if (rootEl === root && rootEl?.firstElementChild) return;
    rootEl = root;
    render();
  },
  setVisible(visible) {
    if (!visible && running) stop();
  },
  stop,
  destroy() {
    stop();
    if (landmarker) {
      landmarker.close();
      landmarker = null;
    }
    if (rootEl) rootEl.replaceChildren();
    rootEl = null;
    videoEl = null;
    canvasEl = null;
    statusEl = null;
    detailEl = null;
    startButton = null;
    handsFreeButton = null;
    stopButton = null;
    recognitionButton = null;
    acceptButton = null;
    speakButton = null;
    draftEl = null;
    predictionEl = null;
    confidenceEl = null;
  },
};

export default videoAssistController;
