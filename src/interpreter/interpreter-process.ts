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

import {
  MAX_GUARDED_DESTROY_RUN_IDS,
  MAX_GUARDED_DESTROY_SESSIONS,
} from '../shared/ipc';

import type {
  InterpreterFrame,
  RendererControl,
  MainToInterpreter,
  InterpreterToMain,
  CancelledFrame,
  EndFrame,
  ErrorFrame,
  ExecutionKind,
  ProgressFrame,
  PtyRestoreWarningFrame,
  RunAttachRejectReason,
  RunStartedInfo,
  SchemaFrame,
  SshConnectionFrame,
  StartFrame,
  WorktreeOpenFrame,
} from '../shared/ipc';
import type { SshForwardAction, SshForwardResult } from '../shared/ssh-forward';
import { SshForwardError } from '../shared/ssh-forward';
import type {
  WorktreeRequest,
  WorktreeRequestOrigin,
  WorktreeResult,
} from '../shared/worktree';
import { evaluate, parse } from './core';
import { describeError, runBlock, type BlockHandle } from './block-runner';
import { runPtySession, clampDim, type PtySession, type PtyAttachHandle } from './pty-session';
import { runScriptSession, type HostChannel, type HostToInterpreterMsg, type ScriptSession, type SpawnHost } from './script-runner';
import { runSshSession, type KnownHostCheckResult, type SshSession, type SshSessionDeps } from './ssh-session';
import { runSshForwardCommand, type SshForwardCommandSession } from './ssh-forward-command';
import { bridgeSshForwardStream, rejectSshForwardStream, type SshForwardPort } from './ssh-forward-stream-bridge';
import { createSshClient } from './external/ssh-client';
import { resolveSshConfigAlias } from './external/ssh-config-resolver';
import { readSshPrivateKeyFile } from './external/ssh-file-reader';
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
  private sshForwardCommandSession: SshForwardCommandSession | null = null;
  private primaryPort: MessagePortMain | null = null;
  // The port currently holding PTY resize authority (control handoff, M8a).
  // Starts as the primary (set alongside it in `run()`) so pre-M8a behavior
  // is unchanged until something actually claims control. Changes via
  // `pty-claim-control` (`claimControl`) and reverts via `revertControl` when
  // the holder's port closes/detaches. Resize authority is ALL control means —
  // primary lifecycle semantics (close-to-dispose, pty-ack pacing) stay keyed
  // to `primaryPort` regardless of who holds control.
  private controlPort: MessagePortMain | null = null;
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
  // The PTY grid's current dimensions (mobile mirroring fix, D3) — set to the
  // spawn size for a pty/ssh-stream block, updated on every gated `pty-resize`
  // from the CONTROL port (control handoff, M8a). Replayed to a late attach so
  // its mirror renders at the current authority's size instead of guessing
  // (see `PtyDimsFrame`'s doc, ipc.ts).
  private lastDims: { cols: number; rows: number } | null = null;
  private lastSshConnection: SshConnectionFrame | null = null;
  private lastWorktreeOpen: WorktreeOpenFrame | null = null;

  constructor(
    private readonly shell: ShellSession,
    private readonly requestOrigin: WorktreeRequestOrigin,
    private readonly sessionId: string,
    private readonly runId: string,
    private readonly hooks: ExecutionHooks = {},
  ) {}

  run(commandText: string, port: MessagePortMain): ExecutionKind {
    this.primaryPort = port;
    this.controlPort = port;
    const { signal } = this.ac;
    const startCwd = this.shell.cwd;
    let executionKind: ExecutionKind = 'local';
    let startSent = false;
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

    // Record the executed command line on the durable session — the authoritative
    // history the `history` builtin reads (recorded before parse, like a real shell,
    // so a command appears in history even if it fails to parse/evaluate).
    this.shell.addHistory(commandText);

    try {
      const statement = parse(commandText);
      const ctx = this.shell.createContext(
        signal,
        createExternalResolver(),
        listProcesses,
        (request) => requestWorktree(
          request,
          this.requestOrigin,
          signal,
          this.sessionId,
          this.runId,
        ),
        this.requestOrigin === 'mobile'
          ? (worktree) => send({ type: 'worktree-open', intentId: randomUUID(), worktree })
          : undefined,
      );
      const data = evaluate(statement, ctx);
      executionKind = data.kind === 'ssh-stream' ? 'ssh' : 'local';
      send({ type: 'start', commandText, cwd: startCwd, executionKind });
      startSent = true;
      // A `!cmd` interactive program is a live PTY/TUI, not a paged result — it
      // bypasses the ResultStore/window machinery and runs through runPtySession.
      if (data.kind === 'pty-stream') {
        this.lastDims = { cols: PTY_INITIAL_COLS, rows: PTY_INITIAL_ROWS };
        this.ptySession = runPtySession(data, send, signal, PTY_INITIAL_COLS, PTY_INITIAL_ROWS);
      } else if (data.kind === 'script-stream') {
        // run-script (E4): a script-host round-trip, not a row/byte source —
        // routed like the pty-stream branch above (see script-runner.ts).
        this.scriptSession = runScriptSession(data, ctx, send, signal, spawnScriptHost);
      } else if (data.kind === 'ssh-stream') {
        // ssh-connect (E5): TOFU + credential prompts precede a pty-shaped
        // channel — routed like the pty-stream branch above (see ssh-session.ts).
        // Same PTY_INITIAL_COLS/ROWS grid: runSshSession's shell() call defaults
        // to the same 80x24 when not passed explicit initialCols/initialRows.
        this.lastDims = { cols: PTY_INITIAL_COLS, rows: PTY_INITIAL_ROWS };
        const connectionId = randomUUID();
        this.sshSession = runSshSession(
          data,
          send,
          signal,
          sshSessionDeps,
          PTY_INITIAL_COLS,
          PTY_INITIAL_ROWS,
          connectionId,
          {
            onReady: (session) => registerSshConnection(session),
            onClosed: (id) => {
              unregisterSshConnection(id);
              send({ type: 'ssh-connection', connectionId: id, state: 'closed' });
            },
          },
        );
      } else if (data.kind === 'ssh-forward-command') {
        this.sshForwardCommandSession = runSshForwardCommand(
          data,
          send,
          signal,
          (request, requestSignal) => requestSshForward(
            request,
            this.requestOrigin,
            requestSignal,
          ),
        );
      } else {
        this.handle = runBlock(data, send, signal);
      }
    } catch (err) {
      // Synchronous parse/evaluate failure: there is nothing to page, so emit the
      // terminal frame and dispose immediately.
      if (!startSent) send({ type: 'start', commandText, cwd: startCwd, executionKind: 'local' });
      if (signal.aborted) send({ type: 'cancelled' });
      else send({ type: 'error', message: describeError(err) });
      this.dispose();
    }
    return executionKind;
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
  attach(port: MessagePortMain): { readonly accepted: true } | { readonly accepted: false; readonly reason: RunAttachRejectReason } {
    if (this.disposed) {
      rejectRun(port, 'run already ended');
      return { accepted: false, reason: 'run-ended' };
    }
    // SSH output currently has no independent replayable transport. Silently
    // attaching would grant input/control to a mirror that receives no PTY
    // bytes, so fail closed without touching the primary SSH channel.
    if (this.sshSession) {
      try {
        port.postMessage({
          type: 'pty-restore-warning',
          reason: 'ssh-late-attach-unsupported',
          fallback: 'none',
        } satisfies PtyRestoreWarningFrame);
        port.postMessage({
          type: 'error',
          message: 'Late attach is not supported for SSH runs',
        } satisfies InterpreterFrame);
        port.close();
      } catch {
        // The requesting mirror already disconnected; the primary stays live.
      }
      return { accepted: false, reason: 'ssh-unsupported' };
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
        const ended = this.lastTerminal !== null;
        rejectRun(port, ended ? 'run already ended' : 'too many mirror viewers for this run');
        return { accepted: false, reason: ended ? 'run-ended' : 'mirror-capacity' };
      }
    }
    const state: AttachPortState = { port, ptyHandle };
    this.attachPorts.set(port, state);
    this.wirePort(port, /* isPrimary */ false);
    try {
      if (this.lastStart) port.postMessage(this.lastStart);
      if (this.lastSchema) port.postMessage(this.lastSchema);
      if (this.lastSshConnection) port.postMessage(this.lastSshConnection);
      // Replayed for reconnect safety. Ordinary attach mirrors receive it too,
      // but only the initiating mobile transport acts on it, keyed by intentId.
      if (this.lastWorktreeOpen) port.postMessage(this.lastWorktreeOpen);
      if (this.ptyRenderUpgraded) {
        port.postMessage({ type: 'pty-render-upgrade' } satisfies InterpreterFrame);
      }
      // Dims BEFORE the restore: serialized cursor addressing is only valid at
      // the authoritative PTY grid used by the headless model.
      if (this.lastDims) {
        port.postMessage({ type: 'pty-dims', ...this.lastDims } satisfies InterpreterFrame);
      }
      port.postMessage({ type: 'pty-control', hasControl: false } satisfies InterpreterFrame);
      if (ptyHandle?.warning) port.postMessage(ptyHandle.warning);
      if (ptyHandle && ptyHandle.replay.byteLength > 0) {
        port.postMessage({
          type: 'pty-data',
          data: ptyHandle.replay,
          // Reconstruct the terminal screen without re-running historical
          // OSC side effects (notably clipboard writes) in the new renderer.
          suppressSideEffects: true,
        } satisfies InterpreterFrame);
      }
      if (this.lastProgress) port.postMessage(this.lastProgress);
      if (this.lastTerminal) port.postMessage(this.lastTerminal);

      // Always release, including an empty replay. This is the only transition
      // that allows live bytes queued during attach to reach the new mirror.
      const releaseFailure = ptyHandle?.releaseLive() ?? null;
      if (releaseFailure) {
        port.postMessage(releaseFailure);
        port.postMessage({
          type: 'error',
          message: 'Terminal restore queue overflowed; reconnect the session',
        } satisfies InterpreterFrame);
        ptyHandle?.detach();
        this.attachPorts.delete(port);
        port.close();
        return { accepted: false, reason: 'restore-failed' };
      }
    } catch {
      ptyHandle?.detach();
      this.attachPorts.delete(port);
      try {
        port.close();
      } catch {
        // Already closed.
      }
      return { accepted: false, reason: 'transport-failed' };
    }
    return { accepted: true };
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
    this.sshForwardCommandSession?.dispose();
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
      const wasControl = port === this.controlPort;
      if (isPrimary) {
        this.primaryPort = null;
      } else {
        this.attachPorts.get(port)?.ptyHandle?.detach();
        this.attachPorts.delete(port);
      }
      if (wasControl) this.revertControl();
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

  /** The port currently holding PTY resize authority (control handoff, M8a). */
  private effectiveControlPort(): MessagePortMain | null {
    return this.controlPort;
  }

  /** Post `{type:'pty-control', hasControl}` to `target`, swallowing a torn-
   * down port the same way every other per-port send in this class does. */
  private postControlState(target: MessagePortMain, hasControl: boolean): void {
    try {
      target.postMessage({ type: 'pty-control', hasControl } satisfies InterpreterFrame);
    } catch {
      // Port already torn down; its own 'close' handler will clean up.
    }
  }

  /** Post a frame to every open port EXCEPT the current control-port holder
   * (control handoff, M8a) — used for `pty-dims` fan-out on resize. Before
   * control handoff this was attach-ports-only (the primary was always the
   * resize authority, so it never needed telling the dims IT just set); now
   * the OLD primary must also receive dims once it is no longer in control. */
  private sendToNonControlPorts(frame: InterpreterFrame): void {
    const controlPort = this.effectiveControlPort();
    if (this.primaryPort && this.primaryPort !== controlPort) {
      try {
        this.primaryPort.postMessage(frame);
      } catch {
        // Primary port already torn down; its own 'close' handler will clean up.
      }
    }
    for (const state of this.attachPorts.values()) {
      if (state.port === controlPort) continue;
      try {
        state.port.postMessage(frame);
      } catch {
        // Attach port already torn down; its own 'close' handler will clean up.
      }
    }
  }

  /** Claim PTY resize authority (control handoff, M8a): `claimer` becomes the
   * new control port — its `pty-resize` will now apply (see the `pty-resize`
   * case) — and every other open port demotes to display-only. Idempotent if
   * the control port re-claims: reassigning + re-notifying is a no-op change. */
  private claimControl(claimer: MessagePortMain): void {
    this.controlPort = claimer;
    this.postControlState(claimer, true);
    if (this.primaryPort && this.primaryPort !== claimer) this.postControlState(this.primaryPort, false);
    for (const state of this.attachPorts.values()) {
      if (state.port !== claimer) this.postControlState(state.port, false);
    }
  }

  /** The port holding control just closed/detached (M8a) — revert authority
   * to the primary if it's still alive, else to any surviving attach port
   * (none left means the execution is tearing down anyway, see the `disposed`
   * guard). Notifies the new holder `{hasControl:true}`; every other port
   * already believes `false`. */
  private revertControl(): void {
    if (this.disposed) return;
    const next = this.primaryPort ?? [...this.attachPorts.values()][0]?.port ?? null;
    this.controlPort = next;
    if (next) this.postControlState(next, true);
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
      case 'ssh-connection':
        this.lastSshConnection = frame;
        break;
      case 'worktree-open':
        this.lastWorktreeOpen = frame;
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
    const wasControl = port === this.controlPort;
    this.attachPorts.delete(port);
    if (wasControl) this.revertControl();
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
        this.sshForwardCommandSession?.handleControl(control);
        break;
      case 'pty-input':
        this.ptySession?.write(control.data);
        this.sshSession?.write(control.data);
        break;
      case 'pty-resize': {
        // Gated to the CONTROL port only (control handoff, M8a — same pattern
        // as `pty-ack` below): a display-only mirror's own FitAddon must never
        // resize the shared PTY out from under whoever holds resize authority
        // (a phone's ~40-col xterm would otherwise wrap a desktop-sized TUI
        // unreadably for everyone). The control port starts as the primary
        // and moves only via an explicit `pty-claim-control`.
        if (port !== this.effectiveControlPort()) break;
        const cols = clampDim(control.cols);
        const rows = clampDim(control.rows);
        this.ptySession?.resize(cols, rows);
        this.sshSession?.resize(cols, rows);
        this.lastDims = { cols, rows };
        // Every OTHER open port learns the new dims — including the primary,
        // now that it is not guaranteed to be the one who set them.
        this.sendToNonControlPorts({ type: 'pty-dims', cols, rows } satisfies InterpreterFrame);
        break;
      }
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
      case 'pty-claim-control':
        this.claimControl(port);
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

function guardedSessionMatches(sessionId: string, expectedActiveRunIds: readonly string[]): boolean {
  if (!registry.get(sessionId)) return true; // idempotent missing-session success
  const actual = [...executionsByRunId.entries()]
    .filter(([, entry]) => entry.info.sessionId === sessionId && entry.execution.running)
    .map(([runId]) => runId)
    .sort();
  const expected = [...new Set(expectedActiveRunIds)].sort();
  return actual.length === expected.length
    && actual.every((runId, index) => runId === expected[index]);
}

function isGuardedDestroyId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isGuardedSessionRequest(value: unknown): value is {
  readonly sessionId: string;
  readonly expectedActiveRunIds: readonly string[];
} {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { sessionId?: unknown; expectedActiveRunIds?: unknown };
  if (
    !isGuardedDestroyId(candidate.sessionId)
    || !Array.isArray(candidate.expectedActiveRunIds)
    || candidate.expectedActiveRunIds.length > MAX_GUARDED_DESTROY_RUN_IDS
    || !candidate.expectedActiveRunIds.every(isGuardedDestroyId)
  ) {
    return false;
  }
  return new Set(candidate.expectedActiveRunIds).size === candidate.expectedActiveRunIds.length;
}

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
  readKeyFile: readSshPrivateKeyFile,
  resolveAlias: (alias, portOverride, keyPathOverride, signal) =>
    resolveSshConfigAlias({ alias, portOverride, keyPathOverride, signal }),
};

// Live authenticated SSH transports, keyed by the stable id announced to the
// terminal. Entries are never resurrected: a closed id is removed permanently.
const sshConnections = new Map<string, SshSession>();

function registerSshConnection(session: SshSession): void {
  sshConnections.set(session.connectionId, session);
  process.parentPort.postMessage({
    type: 'ssh-connection-state',
    connectionId: session.connectionId,
    state: 'ready',
  } satisfies InterpreterToMain);
}

function unregisterSshConnection(connectionId: string): void {
  sshConnections.delete(connectionId);
  process.parentPort.postMessage({
    type: 'ssh-connection-state',
    connectionId,
    state: 'closed',
  } satisfies InterpreterToMain);
}

const SSH_FORWARD_REQUEST_TIMEOUT_MS = 15_000;
const pendingSshForwardRequests = new Map<string, {
  resolve: (result: SshForwardResult) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  onAbort: () => void;
  timer: ReturnType<typeof setTimeout>;
}>();

function requestSshForward(
  request: SshForwardAction,
  origin: WorktreeRequestOrigin,
  signal: AbortSignal,
): Promise<SshForwardResult> {
  if (signal.aborted) return Promise.reject(Object.assign(new Error('SSH forward request cancelled'), { name: 'AbortError' }));
  return new Promise<SshForwardResult>((resolve, reject) => {
    const requestId = randomUUID();
    const onAbort = (): void => {
      const pending = pendingSshForwardRequests.get(requestId);
      if (!pending) return;
      pendingSshForwardRequests.delete(requestId);
      clearTimeout(pending.timer);
      process.parentPort.postMessage({ type: 'ssh-forward-request-cancel', requestId } satisfies InterpreterToMain);
      reject(Object.assign(new Error('SSH forward request cancelled'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => {
      const pending = pendingSshForwardRequests.get(requestId);
      if (!pending) return;
      pendingSshForwardRequests.delete(requestId);
      signal.removeEventListener('abort', onAbort);
      process.parentPort.postMessage({ type: 'ssh-forward-request-cancel', requestId } satisfies InterpreterToMain);
      reject(new SshForwardError('INTERPRETER_UNAVAILABLE', 'SSH forwarding service did not respond'));
    }, SSH_FORWARD_REQUEST_TIMEOUT_MS);
    pendingSshForwardRequests.set(requestId, { resolve, reject, signal, onAbort, timer });
    signal.addEventListener('abort', onAbort, { once: true });
    process.parentPort.postMessage({
      type: 'ssh-forward-request',
      requestId,
      request,
      origin,
    } satisfies InterpreterToMain);
  });
}

const pendingWorktreeRequests = new Map<string, {
  resolve: (result: WorktreeResult) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  onAbort: () => void;
}>();

function requestWorktree(
  request: WorktreeRequest,
  origin: WorktreeRequestOrigin,
  signal: AbortSignal,
  sessionId: string,
  runId: string,
): Promise<WorktreeResult> {
  if (signal.aborted) {
    return Promise.reject(Object.assign(new Error('Worktree request cancelled'), { name: 'AbortError' }));
  }
  return new Promise<WorktreeResult>((resolve, reject) => {
    const requestId = randomUUID();
    const onAbort = (): void => {
      const pending = pendingWorktreeRequests.get(requestId);
      if (!pending) return;
      pendingWorktreeRequests.delete(requestId);
      process.parentPort.postMessage({ type: 'worktree-action-cancel', requestId } satisfies InterpreterToMain);
      reject(Object.assign(new Error('Worktree request cancelled'), { name: 'AbortError' }));
    };
    pendingWorktreeRequests.set(requestId, { resolve, reject, signal, onAbort });
    signal.addEventListener('abort', onAbort, { once: true });
    process.parentPort.postMessage({
      type: 'worktree-action-request',
      requestId,
      request,
      origin,
      sessionId,
      runId,
    } satisfies InterpreterToMain);
  });
}

function announceRunSettled(sessionId: string, runId: string, cwd?: string): void {
  try {
    process.parentPort.postMessage({
      type: 'session-run-settled',
      sessionId,
      runId,
      ...(cwd === undefined ? {} : { cwd }),
    } satisfies InterpreterToMain);
  } catch {
    // Main/interpreter teardown won the race; broker exit clears every lease.
  }
}

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
    case 'restore-sessions': {
      for (const session of msg.sessions) registry.restore(session.sessionId, session.cwd);
      break;
    }
    case 'set-session-environment':
      registry.setEnvironment(msg.sessionId, msg.environment);
      break;
    case 'destroy-session': {
      const guarded = msg.requestId !== undefined || msg.expectedActiveRunIds !== undefined;
      if (guarded) {
        let destroyed = false;
        const beforeDeadline = msg.deadlineAt === undefined || Date.now() <= msg.deadlineAt;
        if (
          msg.requestId !== undefined
          && isGuardedSessionRequest({
            sessionId: msg.sessionId,
            expectedActiveRunIds: msg.expectedActiveRunIds,
          })
          && beforeDeadline
          && guardedSessionMatches(msg.sessionId, msg.expectedActiveRunIds!)
        ) {
          registry.destroy(msg.sessionId);
          destroyed = true;
        }
        if (msg.requestId !== undefined) {
          process.parentPort.postMessage({
            type: 'session-destroy-result',
            requestId: msg.requestId,
            sessionIds: [msg.sessionId],
            destroyed,
          } satisfies InterpreterToMain);
        }
      } else {
        registry.destroy(msg.sessionId);
      }
      break;
    }
    case 'destroy-sessions-guarded': {
      const validEnvelope = (
        typeof msg.requestId === 'string'
        && msg.requestId.length > 0
        && Array.isArray(msg.sessions)
        && msg.sessions.length > 0
        && msg.sessions.length <= MAX_GUARDED_DESTROY_SESSIONS
        && msg.sessions.every(isGuardedSessionRequest)
      );
      const sessionIds = validEnvelope ? msg.sessions.map((entry) => entry.sessionId) : [];
      const identitiesUnique = new Set(sessionIds).size === sessionIds.length;
      const beforeDeadline = Number.isFinite(msg.deadlineAt) && Date.now() <= msg.deadlineAt;
      const destroyed = (
        validEnvelope
        && identitiesUnique
        && beforeDeadline
        && msg.sessions.every((entry) => guardedSessionMatches(
          entry.sessionId,
          entry.expectedActiveRunIds,
        ))
      );
      if (destroyed) {
        for (const sessionId of sessionIds) registry.destroy(sessionId);
      }
      process.parentPort.postMessage({
        type: 'session-destroy-result',
        requestId: msg.requestId,
        sessionIds,
        destroyed,
      } satisfies InterpreterToMain);
      break;
    }
    case 'run': {
      // Cast: TS types event.ports as DOM MessagePort[], but in a utilityProcess
      // they are actually MessagePortMain objects at runtime.
      const port = event.ports[0] as unknown as MessagePortMain;
      if (executionsByRunId.has(msg.runId)) {
        rejectRun(port, 'run id already exists');
        announceRunSettled(msg.sessionId, msg.runId, registry.get(msg.sessionId)?.shell.cwd);
        break;
      }
      const gate = registry.canRun(msg.sessionId);
      if (!gate.ok) {
        rejectRun(port, gate.reason);
        announceRunSettled(msg.sessionId, msg.runId, registry.get(msg.sessionId)?.shell.cwd);
        break;
      }
      const { record } = gate;
      const execution = new ExecutionSession(
        record.shell,
        msg.requestOrigin ?? 'desktop',
        msg.sessionId,
        msg.runId,
        {
          onSettled: () => {
            registry.settle(record, execution);
            announceRunSettled(msg.sessionId, msg.runId, record.shell.cwd);
          },
          onDisposed: () => {
            registry.remove(record, execution);
            if (executionsByRunId.get(msg.runId)?.execution === execution) {
              executionsByRunId.delete(msg.runId);
            }
          },
        },
      );
      registry.begin(record, execution);
      const entry: { execution: ExecutionSession; info: RunStartedInfo } = {
        execution,
        info: { sessionId: msg.sessionId, runId: msg.runId, commandText: msg.commandText, executionKind: 'local' },
      };
      executionsByRunId.set(msg.runId, entry);
      const executionKind = execution.run(msg.commandText, port);
      const announcedInfo: RunStartedInfo = { ...entry.info, executionKind };
      entry.info = announcedInfo;
      // M2 mirroring: announce the run so main can fan out `run-started` to
      // every OTHER surface (desktop windows / WS clients) as a mirroring cue.
      process.parentPort.postMessage({
        type: 'run-started',
        ...announcedInfo,
      } satisfies InterpreterToMain);
      break;
    }
    case 'attach-run': {
      const port = event.ports[0] as unknown as MessagePortMain;
      const entry = executionsByRunId.get(msg.runId);
      let result: { readonly accepted: true } | { readonly accepted: false; readonly reason: RunAttachRejectReason };
      if (!entry) {
        rejectRun(port, `run ${msg.runId} does not exist`);
        result = { accepted: false, reason: 'run-not-found' };
      } else if (entry.info.sessionId !== msg.sessionId) {
        rejectRun(port, `run ${msg.runId} does not exist`);
        result = { accepted: false, reason: 'session-mismatch' };
      } else {
        result = entry.execution.attach(port);
      }
      if (msg.requestId) {
        process.parentPort.postMessage(result.accepted
          ? {
              type: 'run-attach-result',
              requestId: msg.requestId,
              accepted: true,
            } satisfies InterpreterToMain
          : {
              type: 'run-attach-result',
              requestId: msg.requestId,
              accepted: false,
              reason: result.reason,
            } satisfies InterpreterToMain);
      }
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
    case 'ssh-forward-response': {
      const pending = pendingSshForwardRequests.get(msg.requestId);
      if (!pending) break;
      pendingSshForwardRequests.delete(msg.requestId);
      clearTimeout(pending.timer);
      pending.signal.removeEventListener('abort', pending.onAbort);
      pending.resolve(msg.result);
      break;
    }
    case 'ssh-forward-stream-open': {
      const port = event.ports[0] as unknown as SshForwardPort;
      const session = sshConnections.get(msg.connectionId);
      if (!session) {
        rejectSshForwardStream(
          port,
          new SshForwardError('CONNECTION_NOT_FOUND', `SSH connection ${msg.connectionId} is not active`),
        );
        break;
      }
      void bridgeSshForwardStream(session, {
        sourceHost: msg.sourceHost,
        sourcePort: msg.sourcePort,
        remoteHost: msg.remoteHost,
        remotePort: msg.remotePort,
      }, port).catch((error: unknown) => {
        // Defense in depth: the bridge contains all known port/channel throws,
        // but an unforeseen async rejection must still never become an
        // unhandled rejection in the shared interpreter utility process.
        let failure = new SshForwardError('STREAM_OPEN_FAILED', 'SSH forward stream failed');
        try {
          failure = error instanceof SshForwardError
            ? error
            : new SshForwardError(
                'STREAM_OPEN_FAILED',
                error instanceof Error ? error.message : String(error),
              );
        } catch {
          // Keep the cloneable fallback when a thrown value cannot stringify.
        }
        rejectSshForwardStream(
          port,
          failure,
        );
      });
      break;
    }
    case 'worktree-action-response': {
      const pending = pendingWorktreeRequests.get(msg.requestId);
      if (!pending) break;
      pendingWorktreeRequests.delete(msg.requestId);
      pending.signal.removeEventListener('abort', pending.onAbort);
      pending.resolve(msg.result);
      break;
    }
    default:
      break;
  }
});
