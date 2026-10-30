/**
 * Aperture Video Assist static character classifier.
 * The feature layout and class order must remain aligned with the trained model.
 */
const TFLITE_VERSION = '0.0.1-alpha.9';
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-tflite@${TFLITE_VERSION}/dist/`;
const MODEL_URL = '/models/isl_model_advanced.tflite';

export const SIGN_LABELS = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J',
  'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T',
  'U', 'V', 'W', 'X', 'Y', 'Z', '1', '2', '3', '4',
  '5', '6', '7', '8', '9',
];

let modelPromise = null;

async function loadRuntime() {
  const tf = window.tf;
  const tflite = window.tflite;
  if (!tf || !tflite) {
    throw new Error('TensorFlow.js runtime scripts did not load. Check app.html and the Network tab.');
  }
  if (typeof tflite.setWasmPath !== 'function') {
    throw new Error('TensorFlow Lite setWasmPath() is unavailable.');
  }
  tflite.setWasmPath(WASM_BASE);
  await tf.setBackend('cpu');
  await tf.ready();
  if (typeof tflite.loadTFLiteModel !== 'function') {
    throw new Error('TensorFlow Lite model loader is unavailable.');
  }
  return { tf, tflite };
}

export async function loadsignModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const { tflite } = await loadRuntime();
      const model = await tflite.loadTFLiteModel(MODEL_URL);
      if (!model || typeof model.predict !== 'function') {
        throw new Error('Sign model loaded without a supported prediction interface.');
      }
      return model;
    })().catch((error) => {
      modelPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

function normalizeOneHand(landmarks) {
  const wrist = landmarks[0];
  const middleMcp = landmarks[9];
  const dx = middleMcp.x - wrist.x;
  const dy = middleMcp.y - wrist.y;
  const dz = middleMcp.z - wrist.z;
  const size = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.001);
  const values = [];
  for (const point of landmarks.slice(0, 21)) {
    values.push(
      (point.x - wrist.x) / size,
      (point.y - wrist.y) / size,
      (point.z - wrist.z) / size,
    );
  }
  while (values.length < 63) values.push(0);
  return values;
}

function orientationFeatures(landmarks, handednessLabel) {
  const thumbTip = landmarks[4];
  const palmCenterX = (landmarks[5].x + landmarks[9].x + landmarks[13].x + landmarks[17].x) / 4;
  const thumbIsLeftOfCenter = thumbTip.x < palmCenterX;
  const isPalm = handednessLabel === 'Right'
    ? thumbIsLeftOfCenter
    : !thumbIsLeftOfCenter;
  return [isPalm ? 1 : 0, handednessLabel === 'Left' ? 1 : 0];
}

/**
 * Build the model's 130-number feature vector.
 * IMPORTANT: do not sort hands left-to-right. The training extractor retained
 * MediaPipe's detector order; sorting here changes the two-hand feature slots.
 */
export function buildsignFeatures(result) {
  const hands = (result?.landmarks || []).map((landmarks, index) => ({
    landmarks,
    handedness: result?.handednesses?.[index]?.[0]?.categoryName || 'Right',
  })).filter((hand) => Array.isArray(hand.landmarks) && hand.landmarks.length >= 21)
    .slice(0, 2);

  if (!hands.length) return null;

  const features = new Array(130).fill(0);
  features.fill(-1, 126, 130);
  hands.forEach((hand, index) => {
    const offset = index * 63;
    const normalized = normalizeOneHand(hand.landmarks);
    for (let i = 0; i < 63; i += 1) features[offset + i] = normalized[i];
    const orientation = orientationFeatures(hand.landmarks, hand.handedness);
    features[126 + index * 2] = orientation[0];
    features[127 + index * 2] = orientation[1];
  });
  return features;
}

/** Convert the model's scores into the top three labels for diagnostics. */
export function rankSignScores(scores) {
  const values = Array.from(scores || [], Number);
  if (values.length !== SIGN_LABELS.length) {
    throw new Error(`Sign returned ${values.length} scores; expected ${SIGN_LABELS.length}.`);
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error('Sign returned a non-finite prediction score.');
  }
  const ranked = values.map((confidence, index) => ({ label: SIGN_LABELS[index], confidence }));
  ranked.sort((a, b) => b.confidence - a.confidence);
  return ranked.slice(0, 3);
}

export async function predictSign(features) {
  if (!Array.isArray(features) || features.length !== 130) {
    throw new Error(`Sign expected 130 features; received ${features?.length ?? 'none'}.`);
  }
  const [{ tf }, model] = await Promise.all([loadRuntime(), loadsignModel()]);
  const input = tf.tensor2d([features], [1, 130], 'float32');
  let output;
  try {
    output = model.predict(input);
    if (Array.isArray(output)) output = output[0];
    if (!output || typeof output.data !== 'function') {
      throw new Error('Sign returned an unsupported output tensor.');
    }
    const values = Array.from(await output.data());
    const top3 = rankSignScores(values);
    return { label: top3[0].label, confidence: top3[0].confidence, top3 };
  } finally {
    input.dispose();
    if (output && typeof output.dispose === 'function') output.dispose();
  }
}
