import { utils as ssh2Utils } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';

import type { InterpreterFrame } from '../shared/ipc';
import { sshStreamData, type SshStreamData } from './core';
import { runSshSession, type SshSessionDeps } from './ssh-session';
import type { SshAuthMethod, SshChannelLike, SshClientLike, SshConnectOptions } from './external/ssh-client';

// `parsePrivateKey` (external/ssh-client.ts) calls the REAL ssh2 key parser, not
// a fake — so the credential-resolution tests need genuinely valid (test-only)
// OpenSSH key material, generated once here rather than per test (ed25519 keygen
// is cheap). An unencrypted key for the "no prompt needed" path, and a passphrase-
// encrypted one for the "prompts, then decrypts" path.
const UNENCRYPTED_KEY = Buffer.from(ssh2Utils.generateKeyPairSync('ed25519', {}).private);
const KEY_PASSPHRASE = 'correct horse battery staple';
const ENCRYPTED_KEY = Buffer.from(
  ssh2Utils.generateKeyPairSync('ed25519', { passphrase: KEY_PASSPHRASE, cipher: 'aes256-ctr', rounds: 16 }).private,
);

function collect() {
  const frames: InterpreterFrame[] = [];
  return { frames, emit: (f: InterpreterFrame) => frames.push(f) };
}

function sshData(overrides: Partial<SshStreamData> = {}): SshStreamData {
  return { ...sshStreamData('example.com', 22, 'alice'), ...overrides };
}

/** Drain the microtask/macrotask queue once. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A fake ssh2 shell channel the test drives directly (mirrors script-runner.test.ts's fake HostChannel). */
function makeFakeChannel() {
  let dataListener: ((chunk: Buffer) => void) | null = null;
  let closeListener: (() => void) | null = null;
  const calls = { paused: 0, resumed: 0, closed: 0 };
  const writes: string[] = [];
  const windows: Array<{ rows: number; cols: number }> = [];
  const channel: SshChannelLike = {
    on: ((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'data') dataListener = listener as (chunk: Buffer) => void;
      if (event === 'close') closeListener = listener as () => void;
    }) as SshChannelLike['on'],
    write(data) {
      writes.push(typeof data === 'string' ? data : data.toString('utf8'));
      return true;
    },
    setWindow(rows, cols) {
      windows.push({ rows, cols });
    },
    pause() {
      calls.paused += 1;
    },
    resume() {
      calls.resumed += 1;
    },
    close() {
      calls.closed += 1;
    },
  };
  return {
    channel,
    calls,
    writes,
    windows,
    emitData: (chunk: Buffer) => dataListener?.(chunk),
    emitClose: () => closeListener?.(),
  };
}

/** A fake ssh2 Client the test drives directly. `shellChannel` controls what
 * `shell()` hands back; `fireReady`/`fireError`/`fireClose` simulate the
 * corresponding client events. */
function makeFakeClient(opts: { shellChannel?: ReturnType<typeof makeFakeChannel>['channel'] } = {}) {
  const listeners: { ready: Array<() => void>; error: Array<(err: Error) => void>; close: Array<() => void> } = {
    ready: [],
    error: [],
    close: [],
  };
  const calls = { connectedWith: null as SshConnectOptions | null, ended: 0, shellCalls: 0 };
  const client: SshClientLike = {
    connect(options) {
      calls.connectedWith = options;
    },
    shell(_pty, callback) {
      calls.shellCalls += 1;
      if (opts.shellChannel) callback(undefined, opts.shellChannel);
      else callback(new Error('no channel configured'), undefined as unknown as SshChannelLike);
    },
    on: ((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'ready') listeners.ready.push(listener as () => void);
      if (event === 'error') listeners.error.push(listener as (err: Error) => void);
      if (event === 'close') listeners.close.push(listener as () => void);
    }) as SshClientLike['on'],
    end() {
      calls.ended += 1;
    },
  };
  return {
    client,
    calls,
    fireReady: () => listeners.ready.forEach((l) => l()),
    fireError: (err: Error) => listeners.error.forEach((l) => l(err)),
    fireClose: () => listeners.close.forEach((l) => l()),
  };
}

/** A fake key blob whose fingerprint is deterministic (real hostKeyType/hostKeyFingerprint
 * are used unmocked elsewhere, but the test only needs SOME stable buffer). */
function fakeHostKey(tag = 'k1'): Buffer {
  return Buffer.from(`fake-key-${tag}`);
}

function makeDeps(overrides: Partial<SshSessionDeps> = {}): {
  deps: SshSessionDeps;
  fakeClient: ReturnType<typeof makeFakeClient>;
  knownHostChecks: Array<{ host: string; port: number; keyType: string; fingerprint: string }>;
  knownHostAdds: Array<{ host: string; port: number; keyType: string; fingerprint: string }>;
} {
  const fakeClient = makeFakeClient({});
  const knownHostChecks: Array<{ host: string; port: number; keyType: string; fingerprint: string }> = [];
  const knownHostAdds: Array<{ host: string; port: number; keyType: string; fingerprint: string }> = [];
  const deps: SshSessionDeps = {
    createClient: () => fakeClient.client,
    checkKnownHost: (host, port, keyType, fingerprint) => {
      knownHostChecks.push({ host, port, keyType, fingerprint });
      return Promise.resolve({ verdict: 'match', knownHostsPath: 'C:/fake/known_hosts.json' });
    },
    addKnownHost: (host, port, keyType, fingerprint) => {
      knownHostAdds.push({ host, port, keyType, fingerprint });
    },
    readKeyFile: () => Promise.reject(new Error('readKeyFile not stubbed for this test')),
    ...overrides,
  };
  return { deps, fakeClient, knownHostChecks, knownHostAdds };
}

function extractHostVerifier(fakeClient: ReturnType<typeof makeFakeClient>): SshConnectOptions['hostVerifier'] {
  const options = fakeClient.calls.connectedWith;
  if (!options) throw new Error('connect() was never called');
  return options.hostVerifier;
}

function extractAuthHandler(fakeClient: ReturnType<typeof makeFakeClient>): SshConnectOptions['authHandler'] {
  const options = fakeClient.calls.connectedWith;
  if (!options) throw new Error('connect() was never called');
  return options.authHandler;
}

/**
 * Drive the pre-channel handshake in the REAL order (design: connect ->
 * hostVerify -> auth): invoke the hostVerifier (real ssh2 calls it during
 * KEX), then — once it accepts — invoke authHandler (real ssh2 calls it only
 * after KEX/host verification completes). If `resolveAuthMethod()` needs a
 * credential prompt (password, or passphrase for an encrypted key), answers
 * it with `credentialValue`. Returns whatever `authHandler`'s `next()` was
 * called with (an `SshAuthMethod`, or `false` on failure).
 */
async function driveHandshake(
  session: ReturnType<typeof runSshSession>,
  frames: InterpreterFrame[],
  fakeClient: ReturnType<typeof makeFakeClient>,
  credentialValue?: string,
): Promise<SshAuthMethod | false> {
  await flush(); // connect() called
  const verify = vi.fn();
  extractHostVerifier(fakeClient)(fakeHostKey(), verify);
  await flush(); // the (mocked) knownHostCheck round-trip resolves
  if (verify.mock.calls[0]?.[0] !== true) {
    throw new Error('driveHandshake: host verification did not accept (check the test\'s checkKnownHost stub)');
  }

  let nextResult: SshAuthMethod | false | undefined;
  let nextCalled = false;
  extractAuthHandler(fakeClient)([], false, (method) => {
    nextCalled = true;
    nextResult = method;
  });
  await flush(); // resolveAuthMethod() starts; may emit an ssh-prompt

  if (!nextCalled) {
    const prompt = frames.find((f) => f.type === 'ssh-prompt') as { promptId: string } | undefined;
    if (!prompt) throw new Error('driveHandshake: authHandler did not call next() and no prompt was emitted');
    session.handlePromptResponse({ promptId: prompt.promptId, value: credentialValue });
    await flush();
  }
  if (!nextCalled) throw new Error("driveHandshake: authHandler's next() was never called");
  return nextResult as SshAuthMethod | false;
}

/** Drive the handshake all the way through `ready` and a successful shell open. */
async function driveToShellOpen(
  session: ReturnType<typeof runSshSession>,
  frames: InterpreterFrame[],
  fakeClient: ReturnType<typeof makeFakeClient>,
  credentialValue = 'secret',
): Promise<void> {
  await driveHandshake(session, frames, fakeClient, credentialValue);
  fakeClient.fireReady();
  await flush();
}

describe('runSshSession — credential resolution (via authHandler, AFTER host verification)', () => {
  it('no keyPath: prompts for a password, then resolves a password auth method', async () => {
    const ac = new AbortController();
    const { deps, fakeClient } = makeDeps();
    const { frames, emit } = collect();

    const session = runSshSession(sshData(), emit, ac.signal, deps);
    const method = await driveHandshake(session, frames, fakeClient, 'sekrit');

    expect(frames.find((f) => f.type === 'ssh-prompt' && f.kind === 'password')).toBeDefined();
    expect(method).toEqual({ type: 'password', username: 'alice', password: 'sekrit' });
  });

  it('keyPath, unencrypted key: no passphrase prompt, resolves a publickey auth method immediately', async () => {
    const ac = new AbortController();
    const { deps, fakeClient } = makeDeps({ readKeyFile: () => Promise.resolve(UNENCRYPTED_KEY) });
    const { frames, emit } = collect();

    const session = runSshSession(sshData({ keyPath: 'C:/keys/id_ed25519' }), emit, ac.signal, deps);
    const method = await driveHandshake(session, frames, fakeClient);

    expect(frames.filter((f) => f.type === 'ssh-prompt')).toHaveLength(0);
    expect(method).toEqual({ type: 'publickey', username: 'alice', key: UNENCRYPTED_KEY, passphrase: undefined });
  });

  it('keyPath, encrypted key: prompts for a passphrase, then resolves with it', async () => {
    const ac = new AbortController();
    const { deps, fakeClient } = makeDeps({ readKeyFile: () => Promise.resolve(ENCRYPTED_KEY) });
    const { frames, emit } = collect();

    const session = runSshSession(sshData({ keyPath: 'C:/keys/id_ed25519' }), emit, ac.signal, deps);
    const method = await driveHandshake(session, frames, fakeClient, KEY_PASSPHRASE);

    const prompt = frames.find((f) => f.type === 'ssh-prompt');
    expect(prompt).toMatchObject({ kind: 'passphrase' });
    expect(method).toEqual({ type: 'publickey', username: 'alice', key: ENCRYPTED_KEY, passphrase: KEY_PASSPHRASE });
  });

  it('keyPath, encrypted key with a wrong passphrase: hard error, authHandler is told to stop (next(false))', async () => {
    const ac = new AbortController();
    const { deps, fakeClient } = makeDeps({ readKeyFile: () => Promise.resolve(ENCRYPTED_KEY) });
    const { frames, emit } = collect();

    const session = runSshSession(sshData({ keyPath: 'C:/keys/id_ed25519' }), emit, ac.signal, deps);
    const method = await driveHandshake(session, frames, fakeClient, 'definitely wrong');

    expect(method).toBe(false);
    const errorFrame = frames.find((f) => f.type === 'error') as { message: string } | undefined;
    expect(errorFrame?.message).toContain('wrong passphrase');
  });
});

describe('runSshSession — TOFU host-key verification (BEFORE any credential prompt)', () => {
  it('a known/matching host key verifies immediately — the credential prompt only appears afterward', async () => {
    const ac = new AbortController();
    const { deps, fakeClient, knownHostChecks, knownHostAdds } = makeDeps();
    const { frames, emit } = collect();

    const session = runSshSession(sshData(), emit, ac.signal, deps);
    await flush();

    const verify = vi.fn();
    extractHostVerifier(fakeClient)(fakeHostKey(), verify);
    await flush();

    expect(knownHostChecks).toHaveLength(1);
    expect(verify).toHaveBeenCalledWith(true);
    expect(knownHostAdds).toHaveLength(0);
    // No credential prompt yet — authHandler has not even been invoked (that's ssh2's job, next).
    expect(frames.filter((f) => f.type === 'ssh-prompt')).toHaveLength(0);

    void session;
  });

  it('an unknown host prompts for the fingerprint BEFORE any credential prompt; accepting adds it and verifies true', async () => {
    const ac = new AbortController();
    const { deps, fakeClient, knownHostAdds } = makeDeps({
      checkKnownHost: () => Promise.resolve({ verdict: 'unknown', knownHostsPath: 'C:/fake/known_hosts.json' }),
    });
    const { frames, emit } = collect();

    const session = runSshSession(sshData(), emit, ac.signal, deps);
    await flush();

    const verify = vi.fn();
    extractHostVerifier(fakeClient)(fakeHostKey(), verify);
    await flush();

    const hostkeyPrompt = frames.find((f) => f.type === 'ssh-prompt' && f.kind === 'hostkey') as
      | { promptId: string; fingerprint?: string }
      | undefined;
    expect(hostkeyPrompt).toBeDefined();
    expect(hostkeyPrompt?.fingerprint).toBeTruthy();
    expect(verify).not.toHaveBeenCalled();

    session.handlePromptResponse({ promptId: hostkeyPrompt!.promptId, accept: true });
    await flush();

    expect(verify).toHaveBeenCalledWith(true);
    expect(knownHostAdds).toHaveLength(1);
    expect(knownHostAdds[0].host).toBe('example.com');
    // Still no credential prompt — authHandler only fires later, once ssh2 itself invokes it.
    expect(frames.filter((f) => f.type === 'ssh-prompt' && f.kind !== 'hostkey')).toHaveLength(0);
  });

  it('rejecting an unknown host fingerprint verifies false and settles an error — never reaches a credential prompt', async () => {
    const ac = new AbortController();
    const { deps, fakeClient, knownHostAdds } = makeDeps({
      checkKnownHost: () => Promise.resolve({ verdict: 'unknown', knownHostsPath: 'C:/fake/known_hosts.json' }),
    });
    const { frames, emit } = collect();

    const session = runSshSession(sshData(), emit, ac.signal, deps);
    await flush();

    const verify = vi.fn();
    extractHostVerifier(fakeClient)(fakeHostKey(), verify);
    await flush();

    const hostkeyPrompt = frames.find((f) => f.type === 'ssh-prompt' && f.kind === 'hostkey') as
      | { promptId: string }
      | undefined;
    session.handlePromptResponse({ promptId: hostkeyPrompt!.promptId, accept: false });
    await flush();

    expect(verify).toHaveBeenCalledWith(false);
    expect(knownHostAdds).toHaveLength(0);
    expect(frames.find((f) => f.type === 'error')).toBeDefined();
    expect(frames.filter((f) => f.type === 'ssh-prompt')).toHaveLength(1); // only the hostkey prompt — no credential prompt
    expect(fakeClient.calls.ended).toBeGreaterThan(0); // teardown ran
  });

  it('a mismatched host key verifies false and hard-fails with old+new fingerprints and the store path', async () => {
    const ac = new AbortController();
    const { deps, fakeClient } = makeDeps({
      checkKnownHost: () =>
        Promise.resolve({
          verdict: 'mismatch',
          existingFingerprint: 'SHA256:OLD',
          knownHostsPath: 'C:/fake/known_hosts.json',
        }),
    });
    const { frames, emit } = collect();

    const session = runSshSession(sshData(), emit, ac.signal, deps);
    await flush();

    const verify = vi.fn();
    extractHostVerifier(fakeClient)(fakeHostKey(), verify);
    await flush();

    expect(verify).toHaveBeenCalledWith(false);
    const errorFrame = frames.find((f) => f.type === 'error') as { message: string } | undefined;
    expect(errorFrame).toBeDefined();
    expect(errorFrame!.message).toContain('SHA256:OLD');
    expect(errorFrame!.message).toContain('C:/fake/known_hosts.json');
    expect(errorFrame!.message).toMatch(/mismatch|changed/i);
    expect(frames.filter((f) => f.type === 'ssh-prompt')).toHaveLength(0); // never even offered a credential prompt

    void session;
  });
});

describe('runSshSession — post-channel (pty-shaped) lifecycle', () => {
  it('a successful connect + shell open emits schema{pty} then forwards data as pty-data', async () => {
    const ac = new AbortController();
    const fakeChannel = makeFakeChannel();
    const { deps } = makeDeps();
    const clientWithChannel = makeFakeClient({ shellChannel: fakeChannel.channel });
    deps.createClient = () => clientWithChannel.client;
    const { frames, emit } = collect();

    const session = runSshSession(sshData(), emit, ac.signal, deps);
    await driveToShellOpen(session, frames, clientWithChannel);

    expect(frames.find((f) => f.type === 'schema')).toMatchObject({ shape: 'pty' });

    fakeChannel.emitData(Buffer.from('hello'));
    await flush();
    const dataFrame = frames.find((f) => f.type === 'pty-data') as { data: Uint8Array } | undefined;
    expect(dataFrame).toBeDefined();
    expect(Buffer.from(dataFrame!.data).toString('utf8')).toBe('hello');
  });

  // M3 regression (plan invariant #6, "SSH architecture unchanged"): pty blocks
  // default to plain-until-signal render (TuiSignalDetector), but a remote shell
  // is unconditionally interactive — it must upgrade immediately, exactly like
  // `!cmd`'s forceXterm, regardless of whether the remote shell ever emits a
  // detector trigger sequence.
  it('unconditionally upgrades to xterm right after schema, before any data (M3 forceXterm-equivalent)', async () => {
    const ac = new AbortController();
    const fakeChannel = makeFakeChannel();
    const { deps } = makeDeps();
    const clientWithChannel = makeFakeClient({ shellChannel: fakeChannel.channel });
    deps.createClient = () => clientWithChannel.client;
    const { frames, emit } = collect();

    const session = runSshSession(sshData(), emit, ac.signal, deps);
    await driveToShellOpen(session, frames, clientWithChannel);

    const schemaIdx = frames.findIndex((f) => f.type === 'schema');
    const upgradeIdx = frames.findIndex((f) => f.type === 'pty-render-upgrade');
    expect(schemaIdx).toBeGreaterThanOrEqual(0);
    expect(upgradeIdx).toBe(schemaIdx + 1); // immediately after schema
    expect(frames.filter((f) => f.type === 'pty-render-upgrade')).toHaveLength(1);

    // The remote shell in this test never sends anything resembling a TUI
    // trigger — the upgrade must NOT depend on it (unlike a local bare command).
    fakeChannel.emitData(Buffer.from('plain remote output, no signal\r\n'));
    await flush();
    expect(frames.filter((f) => f.type === 'pty-render-upgrade')).toHaveLength(1); // still exactly one
  });

  it('channel close settles `end` exactly once (the reliable terminal signal, not `exit`)', async () => {
    const ac = new AbortController();
    const fakeChannel = makeFakeChannel();
    const clientWithChannel = makeFakeClient({ shellChannel: fakeChannel.channel });
    const { deps } = makeDeps();
    deps.createClient = () => clientWithChannel.client;
    const { frames, emit } = collect();

    const session = runSshSession(sshData(), emit, ac.signal, deps);
    await driveToShellOpen(session, frames, clientWithChannel);

    fakeChannel.emitClose();
    fakeChannel.emitClose(); // idempotent — a duplicate close never emits twice
    await flush();

    expect(frames.filter((f) => f.type === 'end')).toHaveLength(1);
  });

  it('a client error AFTER the channel is open settles `end`, not `error` (matches PTY semantics)', async () => {
    const ac = new AbortController();
    const fakeChannel = makeFakeChannel();
    const clientWithChannel = makeFakeClient({ shellChannel: fakeChannel.channel });
    const { deps } = makeDeps();
    deps.createClient = () => clientWithChannel.client;
    const { frames, emit } = collect();

    const session = runSshSession(sshData(), emit, ac.signal, deps);
    await driveToShellOpen(session, frames, clientWithChannel);

    clientWithChannel.fireError(new Error('socket hiccup'));
    await flush();

    expect(frames.filter((f) => f.type === 'end')).toHaveLength(1);
    expect(frames.filter((f) => f.type === 'error')).toHaveLength(0);
  });

  it('write/resize/ack delegate to the channel once open; write/resize are no-ops before that', async () => {
    const ac = new AbortController();
    const fakeChannel = makeFakeChannel();
    const clientWithChannel = makeFakeClient({ shellChannel: fakeChannel.channel });
    const { deps } = makeDeps();
    deps.createClient = () => clientWithChannel.client;
    const { frames, emit } = collect();

    const session = runSshSession(sshData(), emit, ac.signal, deps);

    // Before the channel opens: no-ops, no throw.
    session.write('early\r');
    session.resize(100, 30);
    expect(fakeChannel.writes).toHaveLength(0);

    await driveToShellOpen(session, frames, clientWithChannel);

    session.write('ls\r');
    session.resize(100, 30);
    expect(fakeChannel.writes).toEqual(['ls\r']);
    expect(fakeChannel.windows).toEqual([{ rows: 30, cols: 100 }]);
  });

  it('byte-ack backpressure: pauses past the high-water mark and resumes at/below the low-water mark', async () => {
    const ac = new AbortController();
    const fakeChannel = makeFakeChannel();
    const clientWithChannel = makeFakeClient({ shellChannel: fakeChannel.channel });
    const { deps } = makeDeps();
    deps.createClient = () => clientWithChannel.client;
    const { frames, emit } = collect();

    const session = runSshSession(sshData(), emit, ac.signal, deps);
    await driveToShellOpen(session, frames, clientWithChannel);

    const HIGH = 1024 * 1024;
    fakeChannel.emitData(Buffer.alloc(HIGH + 1));
    await flush();
    expect(fakeChannel.calls.paused).toBe(1);

    session.ack(HIGH + 1 - 256 * 1024); // down to exactly the low-water mark
    expect(fakeChannel.calls.resumed).toBe(1);
  });
});

describe('runSshSession — cancellation', () => {
  it('an already-aborted signal settles cancelled immediately without connecting', async () => {
    const ac = new AbortController();
    ac.abort();
    const { deps, fakeClient } = makeDeps();
    const { frames, emit } = collect();

    runSshSession(sshData(), emit, ac.signal, deps);
    await flush();

    expect(frames).toEqual([{ type: 'cancelled' }]);
    expect(fakeClient.calls.connectedWith).toBeNull();
  });

  it('cancel while a credential prompt is outstanding settles cancelled and tears down', async () => {
    const ac = new AbortController();
    const { deps, fakeClient } = makeDeps();
    const { frames, emit } = collect();

    runSshSession(sshData(), emit, ac.signal, deps);
    await flush();
    extractHostVerifier(fakeClient)(fakeHostKey(), vi.fn());
    await flush();
    extractAuthHandler(fakeClient)([], false, vi.fn());
    await flush();
    expect(frames.find((f) => f.type === 'ssh-prompt' && f.kind === 'password')).toBeDefined();

    ac.abort();
    await flush();

    expect(frames.filter((f) => f.type === 'cancelled')).toHaveLength(1);
    expect(frames.filter((f) => f.type === 'error')).toHaveLength(0);
    expect(fakeClient.calls.ended).toBeGreaterThan(0);
  });

  it('cancel while waiting for `ready` (after auth resolved, before the shell) settles cancelled', async () => {
    const ac = new AbortController();
    const { deps, fakeClient } = makeDeps();
    const { frames, emit } = collect();

    const session = runSshSession(sshData(), emit, ac.signal, deps);
    await driveHandshake(session, frames, fakeClient, 'secret');
    expect(fakeClient.calls.connectedWith).not.toBeNull(); // connect() called, waiting on 'ready'

    ac.abort();
    await flush();

    expect(frames.filter((f) => f.type === 'cancelled')).toHaveLength(1);
    expect(fakeClient.calls.ended).toBeGreaterThan(0);
  });

  it('a stale/unknown promptId in handlePromptResponse is a silent no-op', async () => {
    const ac = new AbortController();
    const { deps, fakeClient } = makeDeps();
    const { frames, emit } = collect();

    const session = runSshSession(sshData(), emit, ac.signal, deps);
    await flush();
    extractHostVerifier(fakeClient)(fakeHostKey(), vi.fn());
    await flush();
    extractAuthHandler(fakeClient)([], false, vi.fn());
    await flush();

    session.handlePromptResponse({ promptId: 'not-a-real-prompt', value: 'x' });
    await flush();

    // The real (password) prompt is still outstanding — nothing settled.
    expect(frames.filter((f) => f.type !== 'ssh-prompt')).toHaveLength(0);
  });
});

describe('runSshSession — dispose', () => {
  it('dispose before settling tears down the client without emitting a terminal frame', async () => {
    const ac = new AbortController();
    const fakeChannel = makeFakeChannel();
    const clientWithChannel = makeFakeClient({ shellChannel: fakeChannel.channel });
    const { deps } = makeDeps();
    deps.createClient = () => clientWithChannel.client;
    const { frames, emit } = collect();

    const session = runSshSession(sshData(), emit, ac.signal, deps);
    await driveToShellOpen(session, frames, clientWithChannel);
    const framesBeforeDispose = frames.length;

    session.dispose();

    expect(fakeChannel.calls.resumed).toBeGreaterThan(0); // resume-then-close/end
    expect(fakeChannel.calls.closed).toBeGreaterThan(0);
    expect(clientWithChannel.calls.ended).toBeGreaterThan(0);
    expect(frames.length).toBe(framesBeforeDispose); // no frame emitted by dispose itself

    // resume() is called before close()/end() (teardown ordering).
    session.dispose(); // idempotent
    expect(frames.length).toBe(framesBeforeDispose);
  });
});
