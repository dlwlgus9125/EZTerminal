/**
 * SshClient adapter — the ONLY place `ssh2` is imported (mirrors pty-runner.ts's
 * isolation of `node-pty`). Exposes the minimal, hand-written interface
 * `ssh-session.ts` actually drives (`SshClientLike`/`SshChannelLike`) so the
 * runner stays testable with a fake client/channel — no real network, no ssh2
 * import needed in tests — the same Adapter seam as `PtySpawnFn`/`SpawnHost`.
 *
 * `ssh2` is pure-JS in this app (Option B packaging, design §7.3): its optional
 * native `cpu-features` acceleration is never built (install scripts blocked),
 * and ssh2 itself falls back gracefully (`lib/protocol/constants.js` wraps the
 * require in try/catch) — nothing here depends on that native path existing.
 */

import { createHash } from 'node:crypto';
import { Client, utils as ssh2Utils } from 'ssh2';

/** The subset of a live ssh2 shell channel `runSshSession` drives. Deliberately
 * excludes `stderr` — a PTY shell channel already merges it (design §7 B2). */
export interface SshChannelLike {
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  /** Auxiliary (SSH spec: not guaranteed to fire) — see `exit` in Channel docs. */
  on(event: 'exit', listener: (code: number | null) => void): void;
  /** The reliable terminal event for a channel — no code/signal payload. */
  on(event: 'close', listener: () => void): void;
  write(data: string | Buffer): boolean;
  setWindow(rows: number, cols: number, height: number, width: number): void;
  pause(): void;
  resume(): void;
  close(): void;
}

export interface SshPseudoTtyOptions {
  readonly term: string;
  readonly cols: number;
  readonly rows: number;
}

/** One ssh2 direct-tcpip channel used by a local forward. */
export interface SshForwardChannelLike {
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'drain', listener: () => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  write(data: Buffer): boolean;
  pause(): void;
  resume(): void;
  end(): void;
  destroy(): void;
}

/** Verifies the RAW host public key (no `hostHash`, so we control fingerprinting). */
export type SshHostVerifier = (key: Buffer, verify: (valid: boolean) => void) => void;

/** A resolved credential, handed to ssh2 only once `hostVerifier` has already
 * accepted the connection — see {@link SshAuthHandler}. */
export type SshAuthMethod =
  | { readonly type: 'password'; readonly username: string; readonly password: string }
  | { readonly type: 'publickey'; readonly username: string; readonly key: Buffer; readonly passphrase?: string };

/**
 * Drives ssh2's authentication negotiation ourselves instead of handing
 * credentials to `connect()` up front. This is what makes host-key
 * verification (KEX, transport-layer) strictly precede any credential prompt
 * (design: connect -> hostVerify -> auth) — ssh2 invokes `hostVerifier` during
 * KEX and only calls this AFTER it accepts the host, since userauth cannot
 * start until the transport layer is established. `next(false)` tells ssh2
 * there is nothing left to try (v1 does not retry-prompt after a rejection).
 */
export type SshAuthHandler = (
  authsLeft: readonly string[],
  partialSuccess: boolean,
  next: (method: SshAuthMethod | false) => void,
) => void;

export interface SshConnectOptions {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly hostVerifier: SshHostVerifier;
  readonly authHandler: SshAuthHandler;
  readonly readyTimeout?: number;
}

/** The subset of a live ssh2 `Client` `runSshSession` drives. */
export interface SshClientLike {
  connect(options: SshConnectOptions): void;
  shell(pty: SshPseudoTtyOptions, callback: (err: Error | undefined, channel: SshChannelLike) => void): void;
  forwardOut(
    sourceHost: string,
    sourcePort: number,
    remoteHost: string,
    remotePort: number,
    callback: (err: Error | undefined, channel: SshForwardChannelLike) => void,
  ): void;
  on(event: 'ready', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: () => void): void;
  end(): void;
}

/** Production factory: wraps a real ssh2 `Client`. Injectable in tests (fake). */
export function createSshClient(): SshClientLike {
  return new Client() as unknown as SshClientLike;
}

/** OpenSSH-style `SHA256:<base64, no padding>` fingerprint of a raw host key blob. */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** Best-effort key TYPE string (e.g. `ssh-ed25519`) parsed from the raw key blob. */
export function hostKeyType(key: Buffer): string {
  const parsed = ssh2Utils.parseKey(key);
  return parsed instanceof Error ? 'unknown' : parsed.type;
}

/**
 * Parse a private key buffer, optionally decrypting it. Returns `'encrypted'`
 * when the key needs a passphrase that was not supplied (or was wrong) rather
 * than throwing — `ssh-session.ts` uses this to decide whether to prompt.
 */
export function parsePrivateKey(
  buffer: Buffer,
  passphrase?: string,
): { ok: true } | { ok: false; reason: 'encrypted' | 'invalid'; message: string } {
  const result = ssh2Utils.parseKey(buffer, passphrase);
  if (!(result instanceof Error)) return { ok: true };
  // ssh2's parseKey error text names the encrypted case explicitly; anything
  // else (malformed key, unsupported format) is a hard parse failure.
  const encrypted = /passphrase|encrypted/i.test(result.message);
  return { ok: false, reason: encrypted ? 'encrypted' : 'invalid', message: result.message };
}
