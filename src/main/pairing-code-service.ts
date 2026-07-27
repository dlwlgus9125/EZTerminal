import { randomInt, timingSafeEqual } from 'node:crypto';

import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  formatPairingCode,
  normalizePairingCode,
  type PairingCode,
} from '../shared/pairing';

/**
 * Issues and redeems one-time pairing codes.
 *
 * Deliberately in-memory only. The bearer token is the thing worth persisting;
 * a pairing code that outlived the process would be a long-lived secret with a
 * short-lived label. Closing the app cancels pairing, which is also what a user
 * would expect it to do.
 *
 * At most one code exists at a time: issuing again replaces the previous one,
 * so a code left on screen in another window cannot still be redeemed.
 */
export class PairingCodeService {
  private active: { readonly normalized: string; readonly expiresAt: number } | null = null;
  private readonly listeners = new Set<(code: PairingCode | null) => void>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly randomSymbol: (max: number) => number = randomInt,
  ) {}

  issue(): PairingCode {
    this.clearTimer();
    let normalized = '';
    for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
      normalized += PAIRING_CODE_ALPHABET[this.randomSymbol(PAIRING_CODE_ALPHABET.length)];
    }
    const expiresAt = this.now() + PAIRING_CODE_TTL_MS;
    this.active = { normalized, expiresAt };
    this.expiryTimer = setTimeout(() => this.revoke(), PAIRING_CODE_TTL_MS);
    this.expiryTimer.unref?.();
    const issued = this.current();
    this.publish(issued);
    return issued ?? { code: formatPairingCode(normalized), expiresAt };
  }

  /** The live code, or null when none was issued or it has expired. */
  current(): PairingCode | null {
    if (!this.active) return null;
    if (this.active.expiresAt <= this.now()) {
      this.active = null;
      return null;
    }
    return { code: formatPairingCode(this.active.normalized), expiresAt: this.active.expiresAt };
  }

  revoke(): void {
    this.clearTimer();
    if (!this.active) return;
    this.active = null;
    this.publish(null);
  }

  /**
   * Redeem a candidate. Success consumes the code, so a second attempt with the
   * same string fails even a millisecond later — that is the whole point of a
   * one-time code, and it is also what makes a replayed QR photo useless.
   */
  consume(candidate: string): boolean {
    const active = this.active;
    if (!active) return false;
    if (active.expiresAt <= this.now()) {
      this.revoke();
      return false;
    }
    const normalized = normalizePairingCode(candidate);
    // Compare a fixed number of bytes so a wrong length is not distinguishable
    // from a wrong value by how long the check took.
    const supplied = Buffer.alloc(PAIRING_CODE_LENGTH);
    supplied.write(normalized.slice(0, PAIRING_CODE_LENGTH), 'utf8');
    const expected = Buffer.alloc(PAIRING_CODE_LENGTH);
    expected.write(active.normalized, 'utf8');
    if (normalized.length !== PAIRING_CODE_LENGTH || !timingSafeEqual(supplied, expected)) return false;
    this.revoke();
    return true;
  }

  onChange(listener: (code: PairingCode | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.clearTimer();
    this.active = null;
    this.listeners.clear();
  }

  private clearTimer(): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private publish(code: PairingCode | null): void {
    for (const listener of this.listeners) listener(code);
  }
}
