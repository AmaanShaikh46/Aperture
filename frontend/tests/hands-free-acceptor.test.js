import test from 'node:test';
import assert from 'node:assert/strict';
import { HandsFreeCharacterAcceptor } from '../js/assist/hands-free-acceptor.js';

const acceptor = (options = {}) => new HandsFreeCharacterAcceptor(options);

test('appends one character after it remains stable long enough', () => {
  const state = acceptor({ stableHoldMs: 200, cooldownMs: 0 });
  assert.equal(state.observeCandidate({ label: 'A' }, 100), false);
  assert.equal(state.observeCandidate({ label: 'A' }, 299), false);
  assert.equal(state.observeCandidate({ label: 'A' }, 300), true);
});

test('does not append the same held pose repeatedly', () => {
  const state = acceptor({ stableHoldMs: 100, cooldownMs: 0 });
  assert.equal(state.observeCandidate({ label: 'G' }, 0), false);
  assert.equal(state.observeCandidate({ label: 'G' }, 100), true);
  assert.equal(state.observeCandidate({ label: 'G' }, 500), false);
  assert.equal(state.observeCandidate({ label: 'G' }, 900), false);
});

test('appends a different stable character after the cooldown', () => {
  const state = acceptor({ stableHoldMs: 100, cooldownMs: 300 });
  assert.equal(state.observeCandidate({ label: 'H' }, 0), false);
  assert.equal(state.observeCandidate({ label: 'H' }, 100), true);
  assert.equal(state.observeCandidate({ label: 'E' }, 200), false);
  assert.equal(state.observeCandidate({ label: 'E' }, 300), false);
  assert.equal(state.observeCandidate({ label: 'E' }, 400), true);
});

test('a neutral interval re-arms the same character for repeated letters', () => {
  const state = acceptor({ stableHoldMs: 100, cooldownMs: 0, releaseMs: 500 });
  assert.equal(state.observeCandidate({ label: 'L' }, 0), false);
  assert.equal(state.observeCandidate({ label: 'L' }, 100), true);
  assert.equal(state.observeCandidate({ label: 'L' }, 400), false);
  assert.equal(state.observeNoHands(500), false);
  assert.equal(state.observeNoHands(800), false);
  assert.equal(state.observeNoHands(1000), true);
  assert.equal(state.observeCandidate({ label: 'L' }, 1100), false);
  assert.equal(state.observeCandidate({ label: 'L' }, 1200), true);
});

test('does not accept invalid labels', () => {
  const state = acceptor({ stableHoldMs: 0, cooldownMs: 0 });
  assert.equal(state.observeCandidate({ label: 'space' }, 100), false);
  assert.equal(state.observeCandidate({ label: '0' }, 200), false);
  assert.equal(state.observeCandidate(null, 300), false);
});
