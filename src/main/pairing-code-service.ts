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
  private active: {
    readonly normalized: string;
    readonly expiresAt: number;
    readonly generation: number;
  } | null = null;
  private generation = 0;
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
    this.generation += 1;
    this.active = { normalized, expiresAt, generation: this.generation };
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
      this.revoke();
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
  /**
   * Constant-time non-consuming match used by the remote handshake. The
   * generation is an opaque claim: the caller must present it back to
   * `consume`, so issuing a replacement between validation and redemption
   * cannot consume the replacement.
   */
  match(candidate: string): number | null {
    const active = this.active;
    if (!active) return null;
    if (active.expiresAt <= this.now()) {
      this.revoke();
      return null;
    }
    const normalized = normalizePairingCode(candidate);
    // Compare a fixed number of bytes so a wrong length is not distinguishable
    // from a wrong value by how long the check took.
    const supplied = Buffer.alloc(PAIRING_CODE_LENGTH);
    supplied.write(normalized.slice(0, PAIRING_CODE_LENGTH), 'utf8');
    const expected = Buffer.alloc(PAIRING_CODE_LENGTH);
    expected.write(active.normalized, 'utf8');
    if (normalized.length !== PAIRING_CODE_LENGTH || !timingSafeEqual(supplied, expected)) return null;
    return active.generation;
  }

  consume(candidate: string, expectedGeneration?: number): boolean {
    const generation = this.match(candidate);
    if (generation === null) return false;
    if (expectedGeneration !== undefined && generation !== expectedGeneration) return false;
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
    for (const listener of [...this.listeners]) {
      try {
        listener(code);
      } catch {
        // Pairing state is a credential transaction. A destroyed renderer or
        // faulty observer must not turn a committed issue/redeem into an IPC
        // rejection after the code has already changed.
      }
    }
  }
}
