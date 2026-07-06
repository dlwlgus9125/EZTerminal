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
  CancelledFrame,
  EndFrame,
  ErrorFrame,
  ProgressFrame,
  RunStartedInfo,
  SchemaFrame,
  StartFrame,
} from '../shared/ipc';
import { readFile } from 'node:fs/promises';

import { evaluate, parse } from './core';
import { describeError, runBlock, type BlockHandle } from './block-runner';
import { runPtySession, type PtySession, type PtyAttachHandle } from './pty-session';
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

/** A non-initiating observer port attached via `attach-run` (M2 mirroring).
 * For a `pty`-shape block, `ptyHandle` delegates pty-data replay + this
 * port's OWN byte-ack pacing entirely to `pty-session.ts`'s `attach()` (its
 * ring buffer + per-subscriber backpressure, T2.2d/e) — isolated from the
 * primary port's counters so a slow mirror can never pause/stall it. `null`
 * for a non-pty (table/text) block, which has no byte stream to pace at all. */
interface AttachPortState {
  readonly port: MessagePortMain;
  readonly ptyHandle: PtyAttachHandle | null;
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
 *
 * M2 mirroring: {@link attach} adds a NON-INITIATING observer port (from a
 * mirroring desktop tab or a remote mobile client via `attach-run`). Every
 * frame fans out to the primary port AND every attached port — the primary's
 * existing byte-ack backpressure (pty-session.ts) is untouched; each attach
 * port paces itself independently (its own `pty-ack`, T2.2e) so a slow mirror
 * never delays the primary (no head-of-line blocking). Port teardown follows
 * last-port-close semantics (T2.2c): a port merely disconnecting (or an
 * attacher's explicit `close`) only disposes the WHOLE execution once it was
 * the LAST port standing; only the PRIMARY port's explicit `close` control
 * always ends it outright (matches the pre-M2 single-port behavior exactly).
 */
class ExecutionSession implements Execution {
  private readonly ac = new AbortController();
  private handle: BlockHandle | null = null;
  private ptySession: PtySession | null = null;
  private scriptSession: ScriptSession | null = null;
  private sshSession: SshSession | null = null;
  private primaryPort: MessagePortMain | null = null;
  private readonly attachPorts = new Map<MessagePortMain, AttachPortState>();
  private settled = false;
  private disposed = false;

  // Replay state for a late `attach` (M2): enough to let a new port re-render
  // the block's current shape/state. Structured (table/text) row DATA is never
  // replayed here — the attacher re-pages it from the ResultStore itself via
  // its own `requestRows`/`setViewport`, same as any fresh port would.
  private lastStart: StartFrame | null = null;
  private lastSchema: SchemaFrame | null = null;
  private lastProgress: ProgressFrame | null = null;
  private ptyRenderUpgraded = false;
  // A late attach to an ALREADY-FINISHED run (settled but still open for
  // paging, e.g. a completed pty's scrollback) still needs to learn that —
  // the terminal frame itself only ever fires once, in the past.
  private lastTerminal: EndFrame | ErrorFrame | CancelledFrame | null = null;

  constructor(
    private readonly shell: ShellSession,
    private readonly hooks: ExecutionHooks = {},
  ) {}

  run(commandText: string, port: MessagePortMain): void {
    this.primaryPort = port;
    const { signal } = this.ac;
    const send = (frame: InterpreterFrame): void => {
      if (this.disposed) return;
      // Attach the session cwd onto the terminal `end` frame so the renderer's
      // prompt reflects a `cd` (cwd AFTER the command). The pure block-runner that
      // emits `end` stays cwd-agnostic; the session-aware wrapper augments it here.
      const outFrame = frame.type === 'end' ? { ...frame, cwd: this.shell.cwd } : frame;
      this.recordForReplay(outFrame);
      this.broadcast(outFrame);
      // A terminal frame settles the foreground run (freeing the session), but the
      // port stays OPEN so the renderer can keep paging the completed result.
      if (frame.type === 'end' || frame.type === 'error' || frame.type === 'cancelled') {
        this.settle();
      }
    };

    this.wirePort(port, /* isPrimary */ true);

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

  /**
   * Attach a NON-INITIATING observer port (M2 mirroring, `attach-run`):
   * replays enough state for it to render the block (start/schema/pty
   * scrollback ring/render-upgrade — the ring + this port's own byte-ack
   * pacing come straight from `pty-session.ts`'s `attach()`, T2.2d/e), then
   * tees every subsequent frame to it alongside the primary. A dead
   * execution or (for a pty-shape block) a full subscriber cap rejects with
   * a terminal `error` frame instead of silently doing nothing — same shape
   * as `rejectRun` for an unknown `run`.
   */
  attach(port: MessagePortMain): void {
    if (this.disposed) {
      rejectRun(port, 'run already ended');
      return;
    }
    let ptyHandle: PtyAttachHandle | null = null;
    if (this.ptySession) {
      ptyHandle = this.ptySession.attach((bytes) => {
        try {
          port.postMessage({ type: 'pty-data', data: bytes } satisfies InterpreterFrame);
        } catch {
          // Port already torn down; its own 'close' handler will clean up.
        }
      });
      if (!ptyHandle) {
        rejectRun(port, 'too many mirror viewers for this run');
        return;
      }
    }
    const state: AttachPortState = { port, ptyHandle };
    this.attachPorts.set(port, state);
    this.wirePort(port, /* isPrimary */ false);
    if (this.lastStart) port.postMessage(this.lastStart);
    if (this.lastSchema) port.postMessage(this.lastSchema);
    if (this.ptyRenderUpgraded) port.postMessage({ type: 'pty-render-upgrade' } satisfies InterpreterFrame);
    if (ptyHandle && ptyHandle.replay.byteLength > 0) {
      port.postMessage({ type: 'pty-data', data: ptyHandle.replay } satisfies InterpreterFrame);
    }
    if (this.lastProgress) port.postMessage(this.lastProgress);
    // Replay LAST, if the run already finished before this attach — a late
    // observer must still learn that (the real terminal frame only ever fired
    // once, in the past; the port stays open afterward for paging/scrollback).
    if (this.lastTerminal) port.postMessage(this.lastTerminal);
  }

  /** {@link Execution}: signal cancellation (streams stop, external procs are killed). */
  abort(): void {
    this.ac.abort();
  }

  /** True from `run()` until either the terminal frame fires (`lastTerminal`
   * set) or the execution is disposed — the "active" definition `list-runs`
   * filters on (M1 mirror-active-runs, D1). */
  get running(): boolean {
    return !this.disposed && this.lastTerminal === null;
  }

  /** {@link Execution}: release the ResultStore/PTY child + close every port. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.handle?.dispose();
    this.ptySession?.dispose();
    this.scriptSession?.dispose();
    this.sshSession?.dispose();
    this.settle();
    try {
      this.primaryPort?.close();
    } catch {
      // Port already torn down (renderer gone); nothing to do.
    }
    this.primaryPort = null;
    for (const state of this.attachPorts.values()) {
      try {
        state.port.close();
      } catch {
        // Already torn down.
      }
    }
    this.attachPorts.clear();
    this.hooks.onDisposed?.();
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.hooks.onSettled?.();
  }

  /** Common wiring for both the primary port (`run`) and an attach port. */
  private wirePort(port: MessagePortMain, isPrimary: boolean): void {
    port.on('message', (event: ElectronMsgEvent) => {
      this.handleControl(port, event.data as RendererControl);
    });
    // Last-port-close teardown (T2.2c): a port disconnecting (renderer/pane/
    // mirror torn down without an explicit `close` control) only disposes the
    // WHOLE execution once it was the LAST port standing — a mirror viewer
    // dropping off must never kill the initiator's run.
    port.on('close', () => {
      if (isPrimary) {
        this.primaryPort = null;
      } else {
        this.attachPorts.get(port)?.ptyHandle?.detach();
        this.attachPorts.delete(port);
      }
      if (!this.primaryPort && this.attachPorts.size === 0) this.dispose();
    });
    port.start();
  }

  /** Tee a frame to the primary port (unchanged path/backpressure) and every
   * attach port. `pty-data` is EXCLUDED here — for a pty-shape block, attach
   * ports get their live bytes straight from `pty-session.ts`'s own `attach()`
   * tee (its ring buffer + per-subscriber backpressure, T2.2d/e); routing it
   * through here too would double-deliver it. */
  private broadcast(frame: InterpreterFrame): void {
    this.primaryPort?.postMessage(frame);
    if (frame.type === 'pty-data') return;
    for (const state of this.attachPorts.values()) {
      try {
        state.port.postMessage(frame);
      } catch {
        // Attach port already torn down; its own 'close' handler will clean up.
      }
    }
  }

  /** Remember enough per-frame state (T2.2d) for a LATER `attach` to replay —
   * table/text row data, and pty-data bytes (owned by pty-session.ts's own
   * ring, see `attach()`), are deliberately excluded (see the field docs above). */
  private recordForReplay(frame: InterpreterFrame): void {
    switch (frame.type) {
      case 'start':
        this.lastStart = frame;
        break;
      case 'schema':
        this.lastSchema = frame;
        break;
      case 'progress':
        this.lastProgress = frame;
        break;
      case 'pty-render-upgrade':
        this.ptyRenderUpgraded = true;
        break;
      case 'end':
      case 'error':
      case 'cancelled':
        this.lastTerminal = frame;
        break;
      default:
        break;
    }
  }

  /** Detach one attach port WITHOUT disposing the execution unless it was the
   * last port standing (an attacher's own explicit `close` — same rule as a
   * bare disconnect, see `wirePort`'s 'close' handler). */
  private detachPort(port: MessagePortMain): void {
    this.attachPorts.get(port)?.ptyHandle?.detach();
    this.attachPorts.delete(port);
    try {
      port.close();
    } catch {
      // Already gone.
    }
    if (!this.primaryPort && this.attachPorts.size === 0) this.dispose();
  }

  private handleControl(port: MessagePortMain, control: RendererControl): void {
    switch (control?.type) {
      case 'cancel':
        this.abort();
        break;
      case 'close':
        // Only the PRIMARY port's close ends the run for everyone (T2.2c) —
        // an attacher's close just detaches that one mirror viewer.
        if (port === this.primaryPort) this.dispose();
        else this.detachPort(port);
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
        if (port === this.primaryPort) {
          this.ptySession?.ack(control.bytes);
          this.sshSession?.ack(control.bytes);
        } else {
          // This attach port's own pacing — delegated entirely to
          // pty-session.ts's `PtyAttachHandle` (T2.2e), isolated from the
          // primary's counters.
          this.attachPorts.get(port)?.ptyHandle?.ack(control.bytes);
        }
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

// runId -> its ExecutionSession + the RunStartedInfo announced for it (M2
// mirroring), so a later `attach-run` can find the run it names and `list-runs`
// (M1 mirror-active-runs) can report it without reconstructing the info.
// Populated in the `run` case below, dropped on dispose — an unknown/already-
// disposed runId is rejected (see `attach-run`'s handler), never silently
// resurrected (same discipline as `run`'s own session check, B1).
const executionsByRunId = new Map<string, { execution: ExecutionSession; info: RunStartedInfo }>();

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
        onDisposed: () => {
          registry.remove(record, execution);
          executionsByRunId.delete(msg.runId);
        },
      });
      registry.begin(record, execution);
      const info: RunStartedInfo = { sessionId: msg.sessionId, runId: msg.runId, commandText: msg.commandText };
      executionsByRunId.set(msg.runId, { execution, info });
      execution.run(msg.commandText, port);
      // M2 mirroring: announce the run so main can fan out `run-started` to
      // every OTHER surface (desktop windows / WS clients) as a mirroring cue.
      process.parentPort.postMessage({
        type: 'run-started',
        ...info,
      } satisfies InterpreterToMain);
      break;
    }
    case 'attach-run': {
      const port = event.ports[0] as unknown as MessagePortMain;
      const entry = executionsByRunId.get(msg.runId);
      if (!entry) {
        rejectRun(port, `run ${msg.runId} does not exist`);
        break;
      }
      entry.execution.attach(port);
      break;
    }
    case 'list-runs': {
      // M1 mirror-active-runs: level-triggered snapshot, unlike `run-started`'s
      // one-shot broadcast — a late-connecting client uses this to catch up.
      const runs = [...executionsByRunId.values()].filter((v) => v.execution.running).map((v) => v.info);
      process.parentPort.postMessage({
        type: 'run-list',
        requestId: msg.requestId,
        runs,
      } satisfies InterpreterToMain);
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
