/**
 * SSH session runner (E5) — the `ssh-connect` analogue of {@link runScriptSession}
 * and {@link runPtySession}, per the gate's B1 resolution: `ssh-connect` gets its
 * OWN dedicated runner rather than reusing `PtyStreamData`, because the ssh2
 * handshake needs an async PRE-channel phase (host-key verification + credential
 * prompts) that a synchronous `PtyStreamData.spawn()` has no room for.
 *
 * Two phases, one one-shot `settled` guard shared across both:
 *   - PRE-channel: connect -> verify the host key against known_hosts (TOFU,
 *     via a main round-trip) -> authenticate (key file, prompting for a
 *     passphrase if it's encrypted; else a password prompt) -> open the shell
 *     channel. Every wait in this phase races the caller's `signal`, a 60s
 *     timeout, and the ssh2 client's `error`/`close` events (gate B1) via the
 *     shared {@link raceStep} helper. User-facing waits go out as `ssh-prompt`
 *     frames and come back as `ssh-prompt-response` controls (routed here by
 *     the ExecutionSession) — nothing prompt-related is ever logged or
 *     persisted (only `known_hosts.json`'s host/type/fingerprint is, via main).
 *   - POST-channel: emits `schema{pty}` and behaves exactly like a local
 *     `!cmd` PTY block — `pty-data` frames, the SAME byte-ack backpressure
 *     thresholds as {@link runPtySession} (reused, not reimplemented), and
 *     `pty-input`/`pty-resize`/`pty-ack` controls. One-shot `onExit` is driven
 *     by whichever of {channel `close`, client `close`, client `error`} fires
 *     first (gate B2 — the channel's own `exit` event is auxiliary/optional
 *     per the SSH spec and only used to remember a code internally). The PTY
 *     shell's `stderr` is intentionally never subscribed to — already merged.
 */

import { randomUUID } from 'node:crypto';

import type { SshStreamData } from './core';
import type { Emit } from './block-runner';
import { describeError } from './block-runner';
import { PTY_HIGH_WATER, PTY_LOW_WATER, clampDim } from './pty-session';
import {
  SSH_FORWARD_PENDING_OPEN_CAP,
  SSH_FORWARD_STREAM_OPEN_TIMEOUT_MS,
  SshForwardError,
  validateSshRemoteHost,
  validateSshRemotePort,
} from '../shared/ssh-forward';
import type { ResolvedSshAlias } from './external/ssh-config-resolver';
import { hostKeyFingerprint, hostKeyType, parsePrivateKey } from './external/ssh-client';
import type { SshAuthMethod, SshChannelLike, SshClientLike, SshForwardChannelLike, SshHostVerifier } from './external/ssh-client';

/** Every pre-channel wait (prompt or connect-to-ready) races this timeout (design §7 B1). */
export const SSH_STEP_TIMEOUT_MS = 60_000;

export type KnownHostVerdict = 'match' | 'mismatch' | 'unknown';

export interface KnownHostCheckResult {
  readonly verdict: KnownHostVerdict;
  readonly existingFingerprint?: string;
  readonly knownHostsPath: string;
}

/** Everything the runner needs from the outside world — all injectable (tests use fakes). */
export interface SshSessionDeps {
  /** Adapter seam: production wires `createSshClient` from external/ssh-client.ts. */
  createClient(): SshClientLike;
  /** main round-trip (known_hosts.json — main owns the filesystem). */
  checkKnownHost(host: string, port: number, keyType: string, fingerprint: string): Promise<KnownHostCheckResult>;
  /** main round-trip: persist a newly-trusted host key (TOFU accept). Fire-and-forget. */
  addKnownHost(host: string, port: number, keyType: string, fingerprint: string): void;
  /** Reads the `--key` file. Injectable so tests avoid real fs. */
  readKeyFile(path: string): Promise<Buffer>;
  /** Resolve a bare config alias from a sanitized OpenSSH config. Direct
   * `user@host` sessions never call this dependency. */
  resolveAlias?(
    alias: string,
    portOverride?: number,
    keyPathOverride?: string,
    signal?: AbortSignal,
  ): Promise<ResolvedSshAlias>;
}

export interface SshPromptResponse {
  readonly promptId: string;
  readonly value?: string;
  readonly accept?: boolean;
}

export interface SshSession {
  readonly connectionId: string;
  readonly ready: boolean;
  /** Route the renderer's answer to the outstanding `ssh-prompt`. A stale/unknown
   * `promptId` (duplicate, or an answer to an already-resolved prompt) is a no-op. */
  handlePromptResponse(response: SshPromptResponse): void;
  /** Post-channel: forward keystrokes / pasted text. No-op before the channel opens. */
  write(data: string): void;
  /** Post-channel: resize the remote PTY grid. No-op before the channel opens. */
  resize(cols: number, rows: number): void;
  /** Post-channel: cumulative byte-ack (same contract as PtySession.ack). */
  ack(bytes: number): void;
  /** Open one direct-tcpip channel over this authenticated transport. This
   * never prompts, reconnects, or reuses credentials. */
  openForward(
    sourceHost: string,
    sourcePort: number,
    remoteHost: string,
    remotePort: number,
    signal?: AbortSignal,
  ): Promise<SshForwardChannelLike>;
  /** Tear down: end the connection, drop any outstanding prompt. Idempotent. */
  dispose(): void;
}

export interface SshSessionLifecycle {
  onReady?(session: SshSession): void;
  onClosed?(connectionId: string): void;
}

/** Distinguishes "the abort signal fired" from any other rejection reason inside {@link raceStep}. */
class CancelledError extends Error {}

export function runSshSession(
  data: SshStreamData,
  emit: Emit,
  signal: AbortSignal,
  deps: SshSessionDeps,
  initialCols = 80,
  initialRows = 24,
  connectionId: string = randomUUID(),
  lifecycle: SshSessionLifecycle = {},
): SshSession {
  let settled = false;
  let client: SshClientLike | null = null;
  let channel: SshChannelLike | null = null;
  let channelOpen = false;
  let connectionReady = false;
  let connectionClosedNotified = false;
  const forwardChannels = new Set<SshForwardChannelLike>();
  const pendingForwardRejects = new Set<(error: Error) => void>();
  let pendingForwardCallbacks = 0;
  let activePrompt: { promptId: string; resolve: (v: { value?: string; accept?: boolean }) => void } | null = null;
  // Pending raceStep()s that want to hear about a pre-channel client error/close.
  const stepErrorListeners = new Set<(err: Error) => void>();

  // Backpressure state — identical contract to pty-session.ts.
  let sent = 0;
  let acked = 0;
  let paused = false;

  function teardown(): void {
    for (const reject of pendingForwardRejects) {
      reject(new SshForwardError('CONNECTION_CLOSED', `SSH connection ${connectionId} closed`));
    }
    pendingForwardRejects.clear();
    for (const forward of forwardChannels) {
      try {
        forward.destroy();
      } catch {
        // Already closed.
      }
    }
    forwardChannels.clear();
    try {
      channel?.resume(); // resume-then-close: never leave a paused socket mid-teardown.
    } catch {
      // Already gone.
    }
    try {
      channel?.close();
    } catch {
      // Already gone.
    }
    try {
      client?.end();
    } catch {
      // Already gone.
    }
    if (!connectionClosedNotified) {
      connectionClosedNotified = true;
      connectionReady = false;
      lifecycle.onClosed?.(connectionId);
    }
  }

  function settleError(message: string): void {
    if (settled) return;
    settled = true;
    activePrompt = null;
    teardown();
    emit({ type: 'error', message });
  }

  function settleCancelled(): void {
    if (settled) return;
    settled = true;
    activePrompt = null;
    teardown();
    emit({ type: 'cancelled' });
  }

  /** Post-channel terminal event (channel close / client close / client error) — always `end`,
   * the optional EndFrame exitCode is omitted because this close seam does
   * not expose a reliable status. */
  function settleEnd(): void {
    if (settled) return;
    settled = true;
    emit({ type: 'end' });
    teardown();
  }

  /**
   * Race one pre-channel async step against `signal`, a fresh 60s timer, and the
   * ssh2 client's error/close events (design §7 B1 — EVERY pre-channel wait gets
   * its own independent budget, not one shared clock for the whole handshake).
   */
  function raceStep<T>(
    perform: (resolve: (v: T) => void, reject: (err: unknown) => void) => (() => void) | void,
  ): Promise<T> {
    return new Promise<T>((resolvePromise, rejectPromise) => {
      if (signal.aborted) {
        rejectPromise(new CancelledError());
        return;
      }
      let stepDone = false;
      // A mutable holder (not a bare `let`): `perform` below may synchronously
      // invoke resolve/reject (e.g. a test fake that fires its callback inline),
      // which calls `finish` — and therefore reads this — BEFORE the `cleanup.current
      // = perform(...)` assignment on the last line has itself finished evaluating.
      const cleanup: { current: (() => void) | void } = { current: undefined };
      const finish = (action: () => void): void => {
        if (stepDone) return;
        stepDone = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        stepErrorListeners.delete(onClientError);
        cleanup.current?.();
        action();
      };
      const timer = setTimeout(
        () => finish(() => rejectPromise(new Error('ssh-connect: timed out waiting for a response (60s)'))),
        SSH_STEP_TIMEOUT_MS,
      );
      const onAbort = (): void => finish(() => rejectPromise(new CancelledError()));
      signal.addEventListener('abort', onAbort, { once: true });
      const onClientError = (err: Error): void => finish(() => rejectPromise(err));
      stepErrorListeners.add(onClientError);
      cleanup.current = perform(
        (v) => finish(() => resolvePromise(v)),
        (err) => finish(() => rejectPromise(err)),
      );
    });
  }

  /** Emit an `ssh-prompt` and wait for the matching `ssh-prompt-response` (raced). */
  function promptStep(
    kind: 'password' | 'passphrase' | 'hostkey',
    message: string,
    extra?: { fingerprint?: string; host?: string },
  ): Promise<{ value?: string; accept?: boolean }> {
    const promptId = randomUUID();
    emit({ type: 'ssh-prompt', promptId, kind, message, ...extra });
    return raceStep((resolve) => {
      activePrompt = { promptId, resolve };
      return () => {
        if (activePrompt?.promptId === promptId) activePrompt = null;
      };
    });
  }

  /** The `hostVerifier` ssh2 calls during `connect()` with the RAW host key — TOFU (design §3). */
  function makeHostVerifier(target: ResolvedSshAlias): SshHostVerifier {
    return (key, verify) => {
      void (async (): Promise<void> => {
        try {
          const keyType = hostKeyType(key);
          const fingerprint = hostKeyFingerprint(key);
          const { verdict, existingFingerprint, knownHostsPath } = await raceStep<KnownHostCheckResult>(
            (resolve, reject) => {
              deps.checkKnownHost(target.host, target.port, keyType, fingerprint).then(resolve, reject);
            },
          );
          if (settled) {
            verify(false);
            return;
          }
          if (verdict === 'match') {
            verify(true);
            return;
          }
          if (verdict === 'mismatch') {
            verify(false);
            settleError(
              `ssh-connect: HOST KEY MISMATCH for ${target.host}:${target.port} — the server's key changed. ` +
                'This can mean the server was reinstalled, or that the connection is being intercepted.\n' +
                `  previously trusted: ${existingFingerprint ?? '(unknown)'}\n` +
                `  now presented:      ${fingerprint}\n` +
                `If this change is expected, remove the ${target.host}:${target.port} entry from ` +
                `${knownHostsPath} and reconnect.`,
            );
            return;
          }
          // unknown host — ask the renderer to confirm the fingerprint (TOFU).
          const answer = await promptStep(
            'hostkey',
            `The authenticity of host '${target.host}:${target.port}' can't be established.`,
            { fingerprint, host: target.host },
          );
          if (settled) {
            verify(false);
            return;
          }
          if (answer.accept) {
            deps.addKnownHost(target.host, target.port, keyType, fingerprint);
            verify(true);
          } else {
            verify(false);
            settleError(`ssh-connect: host key for ${target.host}:${target.port} was not accepted`);
          }
        } catch (err) {
          if (err instanceof CancelledError) settleCancelled();
          else settleError(describeError(err));
          verify(false);
        }
      })();
    };
  }

  function wireChannel(ch: SshChannelLike): void {
    ch.on('data', (chunk) => {
      if (settled) return;
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      sent += bytes.byteLength;
      emit({ type: 'pty-data', data: bytes });
      if (!paused && sent - acked > PTY_HIGH_WATER) {
        paused = true;
        ch.pause();
      }
    });
    // Auxiliary per the SSH spec (may never fire) — close() is the reliable signal.
    ch.on('exit', () => {
      // The channel close event remains the reliable terminal signal. This
      // adapter does not currently retain SSH's optional exit status.
    });
    ch.on('close', () => settleEnd());
  }

  /**
   * Resolve ONE credential to hand ssh2 (called from `authHandler`, i.e. only
   * AFTER `hostVerifier` has already accepted the host — design: connect ->
   * hostVerify -> auth). `--key` reads the file and prompts for a passphrase
   * only if it's actually encrypted; otherwise prompts for a password.
   */
  async function resolveAuthMethod(target: ResolvedSshAlias): Promise<SshAuthMethod> {
    if (!target.keyPath) {
      const answer = await promptStep('password', `Password for ${target.user}@${target.host}:`);
      return { type: 'password', username: target.user, password: answer.value ?? '' };
    }
    const keyPath = target.keyPath;
    const buffer = await deps.readKeyFile(keyPath);
    let parsed = parsePrivateKey(buffer);
    let passphrase: string | undefined;
    if (!parsed.ok && parsed.reason === 'encrypted') {
      const answer = await promptStep('passphrase', `Enter passphrase for key ${keyPath}:`);
      passphrase = answer.value;
      parsed = parsePrivateKey(buffer, passphrase);
    }
    if (!parsed.ok) {
      throw new Error(
        parsed.reason === 'encrypted'
          ? `ssh-connect: wrong passphrase for key ${keyPath}`
          : `ssh-connect: invalid private key ${keyPath}: ${parsed.message}`,
      );
    }
    return { type: 'publickey', username: target.user, key: buffer, passphrase };
  }

  async function connectFlow(): Promise<void> {
    const target: ResolvedSshAlias = data.targetKind === 'alias'
      ? await raceStep((resolve, reject) => {
          if (!deps.resolveAlias) {
            reject(new Error('ssh-connect: SSH config aliases are unavailable'));
            return;
          }
          deps.resolveAlias(data.alias, data.portOverride, data.keyPathOverride, signal).then(resolve, reject);
        })
      : { alias: `${data.user}@${data.host}`, host: data.host, port: data.port, user: data.user, keyPath: data.keyPath };

    if (settled) return;
    client = deps.createClient();
    const activeClient = client;
    activeClient.on('error', (err) => {
      if (channelOpen) {
        settleEnd();
        return;
      }
      if (stepErrorListeners.size > 0) {
        for (const listener of [...stepErrorListeners]) listener(err);
      } else {
        settleError(describeError(err));
      }
    });
    activeClient.on('close', () => {
      if (channelOpen) {
        settleEnd();
        return;
      }
      const err = new Error('ssh-connect: connection closed before the session was ready');
      if (stepErrorListeners.size > 0) {
        for (const listener of [...stepErrorListeners]) listener(err);
      } else {
        settleError(err.message);
      }
    });

    // v1 does not retry-prompt after a rejected credential (§6 out of scope) —
    // the FIRST authHandler call resolves+attempts one method; any further
    // call (the server rejected it, or asked for more) fails cleanly.
    let authAttempted = false;

    await raceStep<void>((resolve, reject) => {
      activeClient.on('ready', () => resolve());
      try {
        activeClient.connect({
          host: target.host,
          port: target.port,
          username: target.user,
          hostVerifier: makeHostVerifier(target),
          readyTimeout: SSH_STEP_TIMEOUT_MS,
          authHandler: (_authsLeft, partialSuccess, next) => {
            if (authAttempted || partialSuccess) {
              if (!settled) settleError('ssh-connect: authentication failed');
              next(false);
              return;
            }
            authAttempted = true;
            resolveAuthMethod(target).then(next, (err: unknown) => {
              if (!settled) {
                if (err instanceof CancelledError) settleCancelled();
                else settleError(describeError(err));
              }
              next(false);
            });
          },
        });
      } catch (err) {
        reject(err);
      }
    });

    const ch = await raceStep<SshChannelLike>((resolve, reject) => {
      activeClient.shell({ term: 'xterm-256color', cols: initialCols, rows: initialRows }, (err, openedChannel) => {
        if (err) reject(err);
        else resolve(openedChannel);
      });
    });

    if (settled) {
      try {
        ch.close();
      } catch {
        // Already gone.
      }
      return;
    }
    channel = ch;
    channelOpen = true;
    wireChannel(ch);
    emit({ type: 'schema', columns: [], shape: 'pty' });
    // M3 regression fix (plan invariant #6, "SSH architecture unchanged"): pty
    // blocks now default to plain-until-signal render, but a remote shell is a
    // real interactive TTY session unconditionally — same as `!cmd`'s
    // forceXterm (pty-session.ts), an ssh-connect session upgrades immediately,
    // before any data, so it never depends on the remote shell happening to
    // emit a TuiSignalDetector trigger.
    emit({ type: 'pty-render-upgrade' });
    connectionReady = true;
    emit({ type: 'ssh-connection', connectionId, state: 'ready' });
    lifecycle.onReady?.(session);
  }

  const session: SshSession = {
    connectionId,
    get ready(): boolean {
      return connectionReady && !settled;
    },
    handlePromptResponse(response): void {
      if (!activePrompt || activePrompt.promptId !== response.promptId) return;
      const { resolve } = activePrompt;
      activePrompt = null;
      resolve({ value: response.value, accept: response.accept });
    },
    write(input): void {
      if (settled || !channel) return;
      channel.write(input);
    },
    resize(cols, rows): void {
      if (settled || !channel) return;
      channel.setWindow(clampDim(rows), clampDim(cols), 0, 0);
    },
    ack(bytes): void {
      if (settled || !Number.isFinite(bytes)) return;
      if (bytes > acked) acked = Math.min(bytes, sent);
      if (paused && sent - acked <= PTY_LOW_WATER) {
        paused = false;
        channel?.resume();
      }
    },
    openForward(sourceHost, sourcePort, remoteHost, remotePort, openSignal): Promise<SshForwardChannelLike> {
      try {
        validateSshRemoteHost(remoteHost);
        validateSshRemotePort(remotePort);
      } catch (error) {
        return Promise.reject(error);
      }
      if (sourceHost !== '127.0.0.1' || !Number.isInteger(sourcePort) || sourcePort < 0 || sourcePort > 65535) {
        return Promise.reject(new SshForwardError('STREAM_OPEN_FAILED', 'SSH forward source endpoint is invalid'));
      }
      if (settled || connectionClosedNotified) {
        return Promise.reject(new SshForwardError('CONNECTION_CLOSED', `SSH connection ${connectionId} is closed`));
      }
      if (!connectionReady || !client) {
        return Promise.reject(new SshForwardError('CONNECTION_NOT_READY', `SSH connection ${connectionId} is not ready`));
      }
      if (openSignal?.aborted) {
        return Promise.reject(new SshForwardError('CANCELLED', 'SSH direct-tcpip open was cancelled'));
      }
      if (pendingForwardCallbacks >= SSH_FORWARD_PENDING_OPEN_CAP) {
        return Promise.reject(new SshForwardError(
          'STREAM_LIMIT_REACHED',
          'Too many SSH direct-tcpip channels are waiting to open',
        ));
      }
      const activeClient = client;
      return new Promise<SshForwardChannelLike>((resolve, reject) => {
        let promiseSettled = false;
        pendingForwardCallbacks += 1;
        const finishReject = (error: Error): void => {
          if (promiseSettled) return;
          promiseSettled = true;
          pendingForwardRejects.delete(finishReject);
          openSignal?.removeEventListener('abort', onAbort);
          clearTimeout(timer);
          reject(error);
        };
        const onAbort = (): void => {
          finishReject(new SshForwardError('CANCELLED', 'SSH direct-tcpip open was cancelled'));
        };
        const timer = setTimeout(() => {
          finishReject(new SshForwardError('STREAM_OPEN_FAILED', 'SSH direct-tcpip open timed out'));
        }, SSH_FORWARD_STREAM_OPEN_TIMEOUT_MS);
        pendingForwardRejects.add(finishReject);
        openSignal?.addEventListener('abort', onAbort, { once: true });
        if (openSignal?.aborted) {
          pendingForwardCallbacks = Math.max(0, pendingForwardCallbacks - 1);
          onAbort();
          return;
        }
        try {
          activeClient.forwardOut(sourceHost, sourcePort, remoteHost, remotePort, (error, opened) => {
            pendingForwardCallbacks = Math.max(0, pendingForwardCallbacks - 1);
            pendingForwardRejects.delete(finishReject);
            openSignal?.removeEventListener('abort', onAbort);
            clearTimeout(timer);
            if (promiseSettled) {
              if (opened) {
                try {
                  opened.destroy();
                } catch {
                  // The late channel was already closed remotely.
                }
              }
              return;
            }
            promiseSettled = true;
            if (error) {
              reject(new SshForwardError('STREAM_OPEN_FAILED', `SSH direct-tcpip open failed: ${error.message}`));
              return;
            }
            if (settled || connectionClosedNotified) {
              try {
                opened.destroy();
              } catch {
                // Already closed.
              }
              reject(new SshForwardError('CONNECTION_CLOSED', `SSH connection ${connectionId} is closed`));
              return;
            }
            forwardChannels.add(opened);
            const forget = (): void => { forwardChannels.delete(opened); };
            opened.on('close', forget);
            opened.on('error', forget);
            resolve(opened);
          });
        } catch (error) {
          pendingForwardCallbacks = Math.max(0, pendingForwardCallbacks - 1);
          finishReject(new SshForwardError(
            'STREAM_OPEN_FAILED',
            `SSH direct-tcpip open failed: ${error instanceof Error ? error.message : String(error)}`,
          ));
        }
      });
    },
    dispose(): void {
      if (settled) return;
      settled = true;
      activePrompt = null;
      teardown();
    },
  };

  if (signal.aborted) {
    settleCancelled();
  } else {
    connectFlow().catch((err: unknown) => {
      if (err instanceof CancelledError) settleCancelled();
      else settleError(describeError(err));
    });
  }

  return session;
}
