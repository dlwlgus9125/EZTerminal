/**
 * Interpreter utilityProcess entry (T1 seam + T2–T4 core + T5 credit/window).
 *
 * Owns the ExecutionSession lifecycle (architecture §2):
 *   - Receives a 'run' message + MessagePortMain from main (the broker).
 *   - parse(commandText) -> evaluate(ast, {cwd/env snapshot, signal}) -> hand the
 *     resulting PipelineData to {@link runBlock}, which emits framed `schema` +
 *     running `progress` + `chunk` windows back over the dedicated port under the
 *     credit/backpressure protocol (architecture §3). Bulk rows never flood the
 *     renderer — only requested windows cross the IPC boundary.
 *   - Cancellation via an AbortController (`cancel` control).
 *   - The port stays OPEN after the terminal frame so the renderer can keep paging
 *     from the ResultStore; it is closed only on a `close` control.
 *
 * The IPC seam (port broker + frame protocol) is unchanged from T1 — only the
 * frame *flow* (eager dump → credit/window) changed.
 */

import type { MessagePortMain } from 'electron';
import { randomUUID } from 'node:crypto';

import type {
  InterpreterFrame,
  RendererControl,
  MainToInterpreter,
  InterpreterToMain,
} from '../shared/ipc';
import { readFile } from 'node:fs/promises';

import { evaluate, parse } from './core';
import { describeError, runBlock, type BlockHandle } from './block-runner';
import { runPtySession, type PtySession } from './pty-session';
import { runScriptSession, type HostChannel, type HostToInterpreterMsg, type ScriptSession, type SpawnHost } from './script-runner';
import { runSshSession, type KnownHostCheckResult, type SshSession, type SshSessionDeps } from './ssh-session';
import { createSshClient } from './external/ssh-client';
import { createExternalResolver } from './external/external-command';
import { createProcessLister } from './external/process-list';
import { ShellSession } from './shell-session';
import { SessionRegistry, type Execution } from './session-registry';

/** Initial PTY grid before the renderer's xterm reports its real size (resizes immediately). */
const PTY_INITIAL_COLS = 80;
const PTY_INITIAL_ROWS = 24;

// Electron defines its own stripped-down MessageEvent (data + ports only) in
// its namespace, distinct from the DOM MessageEvent. Using the DOM type for
// listener params causes a type error because its structural contract is wider.
// This alias matches Electron's actual runtime shape so listener signatures
// satisfy the overload without importing from 'electron/main' or casting the
// whole function.
type ElectronMsgEvent = { data: unknown; ports: ReadonlyArray<unknown> };

// ── ExecutionSession ──────────────────────────────────────────────────────────

/** Lifecycle callbacks the interpreter's SessionRegistry wires per run. */
interface ExecutionHooks {
  /** Foreground run reached its terminal frame — the session may run the next command (B4). */
  onSettled?: () => void;
  /** The execution was torn down (port closed / session destroyed) — drop it from tracking (B2). */
  onDisposed?: () => void;
}

/**
 * Owns a single command execution: output framing, the block's ResultStore (via
 * runBlock), and cancellation. One instance per `run` message. cwd/env/variables
 * live on the durable {@link ShellSession} it is constructed over, so state set by
 * one run is visible to the next (architecture §2).
 *
 * Implements {@link Execution}: the SessionRegistry can {@link abort} + {@link dispose}
 * it when its session is destroyed (Codex B2). `onSettled` fires on the terminal
 * frame (freeing the session's foreground slot) while the port stays open for paging;
 * `onDisposed` fires when the port actually closes.
 */
class ExecutionSession implements Execution {
  private readonly ac = new AbortController();
  private handle: BlockHandle | null = null;
  private ptySession: PtySession | null = null;
  private scriptSession: ScriptSession | null = null;
  private sshSession: SshSession | null = null;
  private port: MessagePortMain | null = null;
  private settled = false;
  private disposed = false;

  constructor(
    private readonly shell: ShellSession,
    private readonly hooks: ExecutionHooks = {},
  ) {}

  run(commandText: string, port: MessagePortMain): void {
    this.port = port;
    const { signal } = this.ac;
    const send = (frame: InterpreterFrame): void => {
      if (this.disposed) return;
      // Attach the session cwd onto the terminal `end` frame so the renderer's
      // prompt reflects a `cd` (cwd AFTER the command). The pure block-runner that
      // emits `end` stays cwd-agnostic; the session-aware wrapper augments it here.
      port.postMessage(frame.type === 'end' ? { ...frame, cwd: this.shell.cwd } : frame);
      // A terminal frame settles the foreground run (freeing the session), but the
      // port stays OPEN so the renderer can keep paging the completed result.
      if (frame.type === 'end' || frame.type === 'error' || frame.type === 'cancelled') {
        this.settle();
      }
    };

    port.on('message', (event: ElectronMsgEvent) => {
      this.handleControl(event.data as RendererControl);
    });
    // Fallback teardown (ARCH-P1 / CODE-M4): if the renderer's port is closed/GC'd
    // without a `close` control reaching us (e.g. window/pane torn down), the port
    // emits 'close' — dispose so the ResultStore + child are released and don't leak
    // in utilityProcess memory for the app lifetime. dispose() is idempotent, so this
    // is safe alongside the explicit `close` control and session destroy.
    port.on('close', () => this.dispose());
    port.start();

    send({ type: 'start', commandText, cwd: this.shell.cwd });

    // Record the executed command line on the durable session — the authoritative
    // history the `history` builtin reads (recorded before parse, like a real shell,
    // so a command appears in history even if it fails to parse/evaluate).
    this.shell.addHistory(commandText);

    try {
      const statement = parse(commandText);
      const ctx = this.shell.createContext(signal, createExternalResolver(), listProcesses);
      const data = evaluate(statement, ctx);
      // A `!cmd` interactive program is a live PTY/TUI, not a paged result — it
      // bypasses the ResultStore/window machinery and runs through runPtySession.
      if (data.kind === 'pty-stream') {
        this.ptySession = runPtySession(data, send, signal, PTY_INITIAL_COLS, PTY_INITIAL_ROWS);
      } else if (data.kind === 'script-stream') {
        // run-script (E4): a script-host round-trip, not a row/byte source —
        // routed like the pty-stream branch above (see script-runner.ts).
        this.scriptSession = runScriptSession(data, ctx, send, signal, spawnScriptHost);
      } else if (data.kind === 'ssh-stream') {
        // ssh-connect (E5): TOFU + credential prompts precede a pty-shaped
        // channel — routed like the pty-stream branch above (see ssh-session.ts).
        this.sshSession = runSshSession(data, send, signal, sshSessionDeps);
      } else {
        this.handle = runBlock(data, send, signal);
      }
    } catch (err) {
      // Synchronous parse/evaluate failure: there is nothing to page, so emit the
      // terminal frame and dispose immediately.
      if (signal.aborted) send({ type: 'cancelled' });
      else send({ type: 'error', message: describeError(err) });
      this.dispose();
    }
  }

  /** {@link Execution}: signal cancellation (streams stop, external procs are killed). */
  abort(): void {
    this.ac.abort();
  }

  /** {@link Execution}: release the ResultStore/PTY child + close the port. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.handle?.dispose();
    this.ptySession?.dispose();
    this.scriptSession?.dispose();
    this.sshSession?.dispose();
    this.settle();
    try {
      this.port?.close();
    } catch {
      // Port already torn down (renderer gone); nothing to do.
    }
    this.hooks.onDisposed?.();
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.hooks.onSettled?.();
  }

  private handleControl(control: RendererControl): void {
    switch (control?.type) {
      case 'cancel':
        this.abort();
        break;
      case 'close':
        this.dispose();
        break;
      case 'requestRows':
      case 'setViewport':
        this.handle?.handleControl(control);
        this.scriptSession?.handleControl(control);
        break;
      case 'pty-input':
        this.ptySession?.write(control.data);
        this.sshSession?.write(control.data);
        break;
      case 'pty-resize':
        this.ptySession?.resize(control.cols, control.rows);
        this.sshSession?.resize(control.cols, control.rows);
        break;
      case 'pty-ack':
        this.ptySession?.ack(control.bytes);
        this.sshSession?.ack(control.bytes);
        break;
      case 'ssh-prompt-response':
        this.sshSession?.handlePromptResponse(control);
        break;
      default:
        break;
    }
  }
}

// ── process bootstrap ─────────────────────────────────────────────────────────

// process.type === 'utility' confirms we're running as a utilityProcess.
console.log(`[interpreter] started — pid ${process.pid}, type: ${process.type}`);

// The registry of independent shell sessions (Track A). ONE utilityProcess hosts N
// sessions; each owns its own cwd/env/variables/history so tabs/panes are isolated.
// Sessions are created ONLY via `create-session` — never lazily on `run` (Codex B1).
const registry = new SessionRegistry(() => randomUUID());

// The `ps` process source — created ONCE (Windows `tasklist`), injected into each
// per-command EvalContext so the pure core never imports child_process (§7).
const listProcesses = createProcessLister();

// ── known_hosts broker client (E5 §3) ─────────────────────────────────────────
// Main owns the filesystem (userData/known_hosts.json, KnownHostsStore) — every
// `ssh-connect` asks main to check/persist a host key, correlated by a fresh
// requestId (mirrors the create-session round-trip below).

const pendingKnownHostChecks = new Map<
  string,
  { resolve: (result: KnownHostCheckResult) => void; reject: (err: Error) => void }
>();

/** {@link SshSessionDeps.checkKnownHost}: ask main to verify a host key fingerprint. */
function checkKnownHost(host: string, port: number, keyType: string, fingerprint: string): Promise<KnownHostCheckResult> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    pendingKnownHostChecks.set(requestId, { resolve, reject });
    process.parentPort.postMessage({
      type: 'known-host-check',
      requestId,
      host,
      port,
      keyType,
      fingerprint,
    } satisfies InterpreterToMain);
  });
}

/** {@link SshSessionDeps.addKnownHost}: persist a newly-trusted host key (TOFU accept). */
function addKnownHost(host: string, port: number, keyType: string, fingerprint: string): void {
  process.parentPort.postMessage({
    type: 'known-host-add',
    host,
    port,
    keyType,
    fingerprint,
  } satisfies InterpreterToMain);
}

const sshSessionDeps: SshSessionDeps = {
  createClient: createSshClient,
  checkKnownHost,
  addKnownHost,
  readKeyFile: (path) => readFile(path),
};

/** Reject a `run` for a missing/destroyed/busy session with a terminal error frame. */
function rejectRun(port: MessagePortMain, message: string): void {
  try {
    port.postMessage({ type: 'error', message } satisfies InterpreterFrame);
    port.close();
  } catch {
    // Renderer port already gone.
  }
}

// ── run-script host broker client (E4 §6.1) ───────────────────────────────────
// The interpreter cannot fork a utilityProcess itself (C2) — every `run-script`
// asks MAIN to do it, correlated by a fresh hostId. `pendingHostSpawns` holds the
// in-flight spawn round-trip; `liveHostChannels` lets a later `script-host-exit`
// (main relaying the fork's own exit) reach the right HostChannel to close it.

const pendingHostSpawns = new Map<
  string,
  { resolve: (channel: HostChannel) => void; reject: (err: Error) => void }
>();
const liveHostChannels = new Map<string, { notifyClosed: () => void }>();

/** Wrap the interpreter's end of the dedicated RPC port as a {@link HostChannel}. */
function makeHostChannel(hostId: string, port: MessagePortMain): HostChannel {
  let messageListener: ((msg: HostToInterpreterMsg) => void) | null = null;
  const closedListeners: Array<() => void> = [];
  let closed = false;
  const fireClosed = (): void => {
    if (closed) return;
    closed = true;
    liveHostChannels.delete(hostId);
    for (const listener of closedListeners) listener();
  };

  port.on('message', (event: ElectronMsgEvent) => {
    messageListener?.(event.data as HostToInterpreterMsg);
  });
  port.on('close', fireClosed);
  port.start();
  liveHostChannels.set(hostId, { notifyClosed: fireClosed });

  return {
    onMessage(listener): void {
      messageListener = listener;
    },
    onClosed(listener): void {
      closedListeners.push(listener);
    },
    postMessage(msg): void {
      try {
        port.postMessage(msg);
      } catch {
        // Port already torn down (host gone) — nothing to do.
      }
    },
    kill(): void {
      try {
        process.parentPort.postMessage({ type: 'kill-script-host', hostId } satisfies InterpreterToMain);
      } catch {
        // Main-side channel already gone (e.g. interpreter shutting down).
      }
    },
  };
}

/** {@link SpawnHost}: ask main to fork a script-host and resolve once its port arrives. */
const spawnScriptHost: SpawnHost = (scriptPath, args, cwd) => {
  return new Promise((resolve, reject) => {
    const hostId = randomUUID();
    pendingHostSpawns.set(hostId, { resolve, reject });
    process.parentPort.postMessage({
      type: 'spawn-script-host',
      hostId,
      scriptPath,
      args,
      cwd,
    } satisfies InterpreterToMain);
  });
};

// Use process.parentPort (not the 'electron' module export). The module export
// is a snapshot taken at require() time; process.parentPort is the live ref
// that Electron sets before user code runs in a utilityProcess.
process.parentPort.on('message', (event: ElectronMsgEvent) => {
  const msg = event.data as MainToInterpreter;
  switch (msg?.type) {
    case 'create-session': {
      // Interpreter mints the authoritative session id + cwd and acks (Codex B5).
      const info = registry.create(msg.cwd);
      const reply: InterpreterToMain = {
        type: 'session-created',
        requestId: msg.requestId,
        sessionId: info.sessionId,
        cwd: info.cwd,
      };
      process.parentPort.postMessage(reply);
      break;
    }
    case 'destroy-session':
      registry.destroy(msg.sessionId);
      break;
    case 'run': {
      // Cast: TS types event.ports as DOM MessagePort[], but in a utilityProcess
      // they are actually MessagePortMain objects at runtime.
      const port = event.ports[0] as unknown as MessagePortMain;
      const gate = registry.canRun(msg.sessionId);
      if (!gate.ok) {
        rejectRun(port, gate.reason);
        break;
      }
      const { record } = gate;
      const execution = new ExecutionSession(record.shell, {
        onSettled: () => registry.settle(record, execution),
        onDisposed: () => registry.remove(record, execution),
      });
      registry.begin(record, execution);
      execution.run(msg.commandText, port);
      break;
    }
    case 'script-host-ready': {
      const pending = pendingHostSpawns.get(msg.hostId);
      pendingHostSpawns.delete(msg.hostId);
      const port = event.ports[0] as unknown as MessagePortMain;
      const channel = makeHostChannel(msg.hostId, port);
      if (pending) pending.resolve(channel);
      else channel.kill(); // no one is waiting (already settled elsewhere) — don't leak it
      break;
    }
    case 'script-host-error': {
      const pending = pendingHostSpawns.get(msg.hostId);
      pendingHostSpawns.delete(msg.hostId);
      pending?.reject(new Error(msg.message));
      break;
    }
    case 'script-host-exit':
      liveHostChannels.get(msg.hostId)?.notifyClosed();
      break;
    case 'known-host-verdict': {
      const pending = pendingKnownHostChecks.get(msg.requestId);
      pendingKnownHostChecks.delete(msg.requestId);
      pending?.resolve({
        verdict: msg.verdict,
        existingFingerprint: msg.existingFingerprint,
        knownHostsPath: msg.knownHostsPath,
      });
      break;
    }
    default:
      break;
  }
});
