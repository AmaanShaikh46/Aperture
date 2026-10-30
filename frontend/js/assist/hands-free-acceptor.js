/**
 * Small, testable state machine for hands-free static-character composition.
 *
 * It does not recognise poses itself. The controller supplies only candidates
 * that have already passed its temporal prediction-stability check.
 */
export class HandsFreeCharacterAcceptor {
  constructor({ stableHoldMs = 220, cooldownMs = 350, releaseMs = 500 } = {}) {
    this.stableHoldMs = stableHoldMs;
    this.cooldownMs = cooldownMs;
    this.releaseMs = releaseMs;
    this.candidateLabel = null;
    this.candidateSince = null;
    this.lastAcceptedLabel = null;
    this.lastAcceptedAt = null;
    this.noHandsSince = null;
  }

  /** Returns true exactly once when a new stable label should be appended. */
  observeCandidate(candidate, now) {
    this.noHandsSince = null;
    const label = candidate?.label;
    if (typeof label !== 'string' || !/^[A-Z1-9]$/.test(label)) {
      this.candidateLabel = null;
      this.candidateSince = null;
      return false;
    }

    if (this.candidateLabel !== label) {
      this.candidateLabel = label;
      this.candidateSince = now;
    }

    if (now - this.candidateSince < this.stableHoldMs) return false;
    if (label === this.lastAcceptedLabel) return false;
    if (this.lastAcceptedAt !== null && now - this.lastAcceptedAt < this.cooldownMs) return false;

    this.lastAcceptedLabel = label;
    this.lastAcceptedAt = now;
    return true;
  }

  /** A neutral/no-hand interval re-arms even the same character for repetition. */
  observeNoHands(now) {
    if (this.noHandsSince === null) this.noHandsSince = now;
    this.candidateLabel = null;
    this.candidateSince = null;

    if (now - this.noHandsSince >= this.releaseMs) {
      this.lastAcceptedLabel = null;
      return true;
    }
    return false;
  }

  reset() {
    this.candidateLabel = null;
    this.candidateSince = null;
    this.lastAcceptedLabel = null;
    this.lastAcceptedAt = null;
    this.noHandsSince = null;
  }
}
