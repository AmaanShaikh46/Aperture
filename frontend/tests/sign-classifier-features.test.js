import test from 'node:test';
import assert from 'node:assert/strict';
import { buildsignFeatures, rankSignScores, SIGN_LABELS } from '../js/assist/sign-classifier.js';

function makeHand(baseX) {
  return Array.from({ length: 21 }, (_, i) => ({
    x: baseX + i * 0.001,
    y: 0.2 + i * 0.003,
    z: -i * 0.002,
  }));
}

test('returns null when no hands are present', () => {
  assert.equal(buildsignFeatures({ landmarks: [] }), null);
});

test('builds exactly 130 values for one hand and marks missing hand orientation as absent', () => {
  const features = buildsignFeatures({ landmarks: [makeHand(0.2)], handednesses: [[{ categoryName: 'Right' }]] });
  assert.equal(features.length, 130);
  assert.deepEqual(features.slice(63, 126), new Array(63).fill(0));
  assert.deepEqual(features.slice(128, 130), [-1, -1]);
});

test('preserves detector order for two hands to match the training extractor', () => {
  const firstDetected = makeHand(0.8);
  const secondDetected = makeHand(0.1);
  const features = buildsignFeatures({
    landmarks: [firstDetected, secondDetected],
    handednesses: [[{ categoryName: 'Right' }], [{ categoryName: 'Left' }]],
  });
  assert.equal(features.length, 130);
  // The first hand in the result must occupy the first 63-feature block, even
  // when its x-coordinate is to the right of the second hand.
  assert.equal(features[127], 0, 'first detector result stays in hand slot 1');
  assert.equal(features[129], 1, 'second detector result stays in hand slot 2');
});

test('ranks the three highest scores using the model label order', () => {
  const scores = new Array(SIGN_LABELS.length).fill(0.01);
  scores[SIGN_LABELS.indexOf('G')] = 0.52;
  scores[SIGN_LABELS.indexOf('C')] = 0.21;
  scores[SIGN_LABELS.indexOf('S')] = 0.13;
  assert.deepEqual(rankSignScores(scores).map((item) => item.label), ['G', 'C', 'S']);
  assert.equal(rankSignScores(scores)[0].confidence, 0.52);
});

test('rejects output arrays with the wrong size or non-finite values', () => {
  assert.throws(() => rankSignScores([0.1, 0.9]), /expected 35/);
  const scores = new Array(SIGN_LABELS.length).fill(0);
  scores[3] = Number.NaN;
  assert.throws(() => rankSignScores(scores), /non-finite/);
});
