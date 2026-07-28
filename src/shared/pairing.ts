/**
 * One-time pairing codes.
 *
 * A pairing code is not a credential the way the bearer token is. It exists to
 * carry a phone across the gap between "has nothing" and "has the bearer
 * token", it is good for exactly one authentication, and it dies on a clock.
 * Nothing about it is worth persisting: a code that survived a restart would be
 * a long-lived secret pretending to be a short-lived one.
 */

/** Excludes I, L, O, U and every digit that mimics one, so a code read off a
 * screen and typed by hand cannot become a different valid code. */
export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_GROUP = 4;
export const PAIRING_CODE_GROUPS = 2;
/** 8 symbols over a 32-symbol alphabet = 40 bits. Each guess costs a fresh TCP
 * connection against a VPN-bound listener that closes on the first failure, and
 * the whole code is dead within minutes. */
export const PAIRING_CODE_LENGTH = PAIRING_CODE_GROUP * PAIRING_CODE_GROUPS;
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
/** Persisted remote bearer tokens are 32 random bytes rendered as canonical
 * lowercase hex. Keep this validator shared so a pairing client never adopts
 * an attacker-controlled or malformed replacement credential. */
export const REMOTE_BEARER_TOKEN_LENGTH = 64;

export interface PairingCode {
  /** Grouped for reading aloud: `7C2F-91KD`. */
  readonly code: string;
  readonly expiresAt: number;
}

/** What the QR encodes. A scheme rather than a bare URL so a scanner can tell
 * this apart from any other QR it happens to be pointed at. */
export const PAIRING_URI_SCHEME = 'ezterminal';

export function buildPairingUri(endpoint: string, code: string): string {
  return `${PAIRING_URI_SCHEME}://pair?endpoint=${encodeURIComponent(endpoint)}&code=${encodeURIComponent(code)}`;
}

export interface ParsedPairingUri {
  readonly endpoint: string;
  readonly code: string;
}

/** Returns null for anything that is not one of our pairing URIs, including a
 * well-formed one missing either half — a partial pairing is not a pairing. */
export function parsePairingUri(value: string): ParsedPairingUri | null {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith(`${PAIRING_URI_SCHEME}://pair?`)) return null;
  const query = trimmed.slice(trimmed.indexOf('?') + 1);
  const params = new URLSearchParams(query);
  const endpoint = params.get('endpoint')?.trim() ?? '';
  const code = params.get('code')?.trim() ?? '';
  if (!/^wss?:\/\/\S+$/iu.test(endpoint)) return null;
  if (!isPairingCode(code)) return null;
  return { endpoint, code };
}

/** Case- and separator-insensitive: a code is read by a human as often as by a
 * camera, and `7c2f 91kd` is the same secret as `7C2F-91KD`. */
export function normalizePairingCode(value: string): string {
  return value.replace(/[^0-9a-z]/giu, '').toUpperCase();
}

export function isPairingCode(value: string): boolean {
  const normalized = normalizePairingCode(value);
  if (normalized.length !== PAIRING_CODE_LENGTH) return false;
  return [...normalized].every((character) => PAIRING_CODE_ALPHABET.includes(character));
}

export function isRemoteBearerToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length === REMOTE_BEARER_TOKEN_LENGTH
    && /^[0-9a-f]+$/u.test(value);
}

export function formatPairingCode(normalized: string): string {
  const groups: string[] = [];
  for (let index = 0; index < normalized.length; index += PAIRING_CODE_GROUP) {
    groups.push(normalized.slice(index, index + PAIRING_CODE_GROUP));
  }
  return groups.join('-');
}
