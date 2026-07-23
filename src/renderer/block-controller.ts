/**
 * BlockController — renderer-side owner of one command block's data + port.
 *
 * It receives the interpreter's frames over the dedicated MessagePort and exposes
 * an external store (subscribe/getSnapshot for `useSyncExternalStore`) plus a
 * *windowed* row cache. The full result is NEVER held here — only the rows around
 * the current viewport are cached; everything else is fetched on demand via the
 * credit/window controls (`requestRows`/`setViewport`) and pruned as the viewport
 * moves. This is what keeps 100k-row results out of React state (architecture §3).
 */

import type {
  ColumnInfo,
  ExecutionKind,
  InterpreterFrame,
  PtyRestoreWarningFrame,
  ResultRow,
  ResultShape,
} from '../shared/ipc';
// AnsiHtmlStream is a pure browser-safe utility (ansi_up + TextDecoder, no Node
// APIs) — reused as-is from the interpreter side rather than duplicated, for the
// PTY block's plain-mode render (M3), which needs the SAME ansi->html conversion
// TextBlock.tsx gets for free from the interpreter's byte-stream path.
import { AnsiHtmlStream } from '../interpreter/external/ansi';
import { SCROLLBACK_DEFAULT, getActiveScrollback } from './scrollback';
import {
  PTY_PLAIN_HISTORY_MAX_BYTES,
  PtyReplayBuffer,
  type RetainedPtyChunk,
} from './pty-output-retention';

interface InFlightPtyWrite {
  readonly entry: RetainedPtyChunk;
  readonly generation: number;
  settled: boolean;
}

export type BlockStatus = 'running' | 'done' | 'error' | 'cancelled';

/**
 * A `pty`-shape block's render mode (Phase 3 adaptive render): `plain` is the
 * default (buffered text + ansi->html, like a text block, with input wired via
 * the minimal keyset — see PtyBlock.tsx); `xterm` is the full terminal, entered
 * either immediately (`forceXterm`, `!cmd`) or on the interpreter's first
 * high-confidence TUI signal (`pty-render-upgrade` frame). The upgrade is
 * irreversible — a block never goes back from `xterm` to `plain`.
 */
export type PtyRenderMode = 'plain' | 'xterm';

/** Stable, non-secret renderer identity for a mounted PTY control surface.
 * It is deliberately limited to registry keys: no command, cwd, endpoint, or
 * actor identity crosses this seam. */
export interface PtyControlTargetIdentity {
  readonly panelId: string;
  readonly sessionId: string;
  readonly runId: string;
}

export interface BlockControllerOptions {
  readonly mirror?: boolean;
  readonly controlTarget?: PtyControlTargetIdentity;
}

/** An outstanding pre-schema `ssh-connect` prompt (E5) — password/passphrase
 * (masked input) or a TOFU host-key decision (fingerprint + accept/reject). */
export interface SshPromptState {
  readonly promptId: string;
  readonly kind: 'password' | 'passphrase' | 'hostkey';
  readonly message: string;
  readonly fingerprint?: string;
  readonly host?: string;
}

/** Immutable view handed to React via useSyncExternalStore. */
export interface BlockSnapshot {
  readonly status: BlockStatus;
  /** Local vs SSH execution, or null when an older peer omitted the additive field. */
  readonly executionKind: ExecutionKind | null;
  readonly sshConnectionId: string | null;
  readonly sshConnectionState: 'ready' | 'closed' | null;
  /** Degraded late-attach restore status. No terminal content is included. */
  readonly ptyRestoreWarning: PtyRestoreWarningFrame | null;
  readonly shape: ResultShape | null;
  readonly columns: readonly ColumnInfo[];
  readonly rowCount: number;
  readonly exhausted: boolean;
  readonly errorMessage: string | null;
  /** Session cwd when this block's command started (terminal-style block prompt). */
  readonly startCwd: string | null;
  /** Session cwd after this block's command ran (reflects `cd`); used for the live prompt. */
  readonly endCwd: string | null;
  /** An outstanding `ssh-connect` prompt (E5), or null. Always null once `shape`
   * is set — prompts only occur before the channel/schema is up. */
  readonly sshPrompt: SshPromptState | null;
  /** A `pty`-shape block's current render mode (Phase 3). Meaningless for other
   * shapes; defaults to `plain` and only ever moves plain -> xterm. */
  readonly ptyRenderMode: PtyRenderMode;
  /** The PRIMARY's current PTY grid size (mobile mirroring fix, D3) — null
   * until the first `pty-dims` frame (attach replay or a primary resize).
   * Meaningless outside a mirror controller; a primary never receives it. */
  readonly ptyDims: { cols: number; rows: number } | null;
  /** Whether this port currently holds PTY resize authority (control handoff,
   * M8a/M8b) — DYNAMIC, unlike `isMirror` which is fixed at construction.
   * Starts `!opts.mirror` (a primary starts in control; an attach mirror does
   * not) and moves on `pty-control` frames as control is claimed/reverted. */
  readonly hasControl: boolean;
  /** Bumped on every change so memoized consumers know to re-read row data. */
  readonly version: number;
}

/** Rows kept cached on each side of the viewport. Bounds memory + DOM. */
const KEEP_BUFFER = 300;
const MAX_ROW_WINDOW = 10_000;

/**
 * Minimum gap between listener notifications for `progress` frames. A fast
 * builtin (`gen-rows 100000000`) reports progress every structured drain batch —
 * tens of thousands of frames — and notifying React on every one saturates the
 * main thread (re-render + follow-scroll layout per frame) until clicks starve.
 * The snapshot still updates on EVERY frame; only the notification is coalesced
 * (leading edge fires immediately, a trailing timer delivers the latest state).
 * Terminal/one-shot frames bypass the throttle entirely.
 */
export const NOTIFY_THROTTLE_MS = 33;

/**
 * PTY backpressure ack quantum (Stage C): a cumulative `pty-ack` control is
 * sent each time this many additional bytes have been FLUSHED by xterm (the
 * term.write callback) — not merely received. The interpreter pauses the PTY
 * when sent-minus-acked exceeds its high-water mark, so everything in flight
 * (port queue + the pre-mount buffer below + xterm pending) stays bounded by
 * construction (gate B2/B3 — docs/design/pty-backpressure-design.md §2).
 */
export const PTY_ACK_QUANTUM = 64 * 1024;

function activeScrollbackLines(): number {
  return typeof document === 'undefined' ? SCROLLBACK_DEFAULT : getActiveScrollback();
}

/** PTY byte sink: `onFlushed` MUST be called once xterm has consumed `bytes`
 * (term.write's callback) — it drives the backpressure ack. */
export interface PtyDataSinkMetadata {
  /** Render bytes into xterm, but do not repeat terminal-originated effects. */
  readonly suppressSideEffects: boolean;
}

export type PtyDataSink = (
  bytes: Uint8Array,
  onFlushed: () => void,
  metadata: PtyDataSinkMetadata,
) => void;

/**
 * Plain-mode PTY sink (Phase 3): receives already ansi->html-converted chunks,
 * one per incoming `pty-data` frame while `ptyRenderMode` is `plain`. Like
 * {@link PtyDataSink}, the caller is expected to append imperatively (DOM, not
 * React state) — plain output can be just as firehose-y as xterm output
 * (npm/pnpm progress, a large one-shot dump), so it must stay OUT of React
 * state for the same reason PTY bytes do.
 */
export type PlainDataSink = (html: string) => void;

/** Live controllers, for the `window.__ezPtyFlow` e2e seam (renderer only —
 * unit tests run in node, where `window` does not exist). */
const liveControllers = new Set<BlockController>();
if (typeof window !== 'undefined') {
  (
    window as Window & { __ezPtyFlow?: () => { received: number; consumed: number } }
  ).__ezPtyFlow = () => {
    let received = 0;
    let consumed = 0;
    for (const controller of liveControllers) {
      const flow = controller.getPtyFlow();
      received += flow.received;
      consumed += flow.consumed;
    }
    return { received, consumed };
  };
}

export class BlockController {
  readonly command: string;
  readonly controlTarget: PtyControlTargetIdentity | null;
  private readonly port: MessagePort;
  /** True for a non-initiating `attach-run` observer (mobile mirroring fix,
   * D4) — PtyBlock.tsx reads this to size its xterm from `ptyDims` instead of
   * FitAddon-reporting its own size back (which would resize the shared PTY). */
  readonly isMirror: boolean;

  private readonly cache = new Map<number, ResultRow>();
  private status: BlockStatus = 'running';
  private executionKind: ExecutionKind | null = null;
  private sshConnectionId: string | null = null;
  private sshConnectionState: 'ready' | 'closed' | null = null;
  private ptyRestoreWarning: PtyRestoreWarningFrame | null = null;
  private shape: ResultShape | null = null;
  private columns: readonly ColumnInfo[] = [];
  private rowCount = 0;
  private exhausted = false;
  private errorMessage: string | null = null;
  private startCwd: string | null = null;
  private endCwd: string | null = null;
  private sshPrompt: SshPromptState | null = null;
  private version = 0;

  /** De-dupes repeated requests for the same window (e.g. across re-renders). */
  private requestedKey = '';
  /** Latest requested range; late chunks outside its keep-buffer are stale. */
  private requestedWindow: { readonly start: number; readonly count: number } | null = null;

  /** PTY blocks stream raw bytes straight to xterm — NEVER into React state.
   * In plain mode the buffer keeps only configured scrollback (plus an 8 MiB
   * single-line ceiling) for a possible xterm upgrade. Those bytes were already
   * ACKed, so replay never consumes them again. In xterm mode the pre-mount
   * entries remain unacked and are bounded by the interpreter high-water mark.
   */
  private ptyDataSink: PtyDataSink | null = null;
  private readonly ptyBuffer = new PtyReplayBuffer();
  private ptySinkGeneration = 0;
  private inFlightPtyWrites: InFlightPtyWrite[] = [];

  /** Paste seam (mobile long-press menu): an xterm view registers
   * `term.paste` here so pasted text gets bracketed-paste framing and \n→\r
   * normalization when the child enabled it (claude/codex do) instead of
   * landing as raw keystroke bytes. Absent (plain view / not mounted), paste
   * falls back to a raw `sendPtyInput`. */
  private pasteHandler: ((text: string) => void) | null = null;

  /** Phase 3 adaptive render: mode + the plain-mode ansi->html pipeline. A
   * single `AnsiHtmlStream` instance is reused for the block's entire plain
   * phase so SGR state (current fg/bg/bold) carries across chunks. Raw replay
   * history is retained in the bounded `ptyBuffer`; late plain sinks rebuild
   * sanitized HTML from only that retained scrollback. */
  private ptyRenderMode: PtyRenderMode = 'plain';
  private plainAnsi = new AnsiHtmlStream();
  private plainAnsiFinished = false;
  private plainSink: PlainDataSink | null = null;
  private plainSinkFlush: (() => void) | null = null;
  private ptyReplayResetHandler: (() => void) | null = null;

  /** The PRIMARY's PTY grid size, mirrored via `pty-dims` frames (D3). */
  private ptyDims: { cols: number; rows: number } | null = null;

  /** PTY resize authority, DYNAMIC (control handoff, M8a/M8b) — see
   * `BlockSnapshot.hasControl`'s doc. Initialized in the constructor from
   * `!opts.mirror`, then driven entirely by `pty-control` frames. */
  private hasControl: boolean;

  /** Flow accounting (Stage C): bytes received off the port vs bytes
   * consumed (xterm-flushed in xterm mode, immediate in plain mode — M3);
   * `ptyAckedAt` is the last cumulative value acked. */
  private ptyReceived = 0;
  private ptyConsumed = 0;
  private ptyAckedAt = 0;
  /** Invalidates late xterm callbacks across replay reset/dispose. */
  private ptyFlowEpoch = 0;

  private snapshot: BlockSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly handleScrollbackChange = (): void => {
    if (this.ptyRenderMode !== 'plain') return;
    this.ptyBuffer.limit(activeScrollbackLines(), PTY_PLAIN_HISTORY_MAX_BYTES);
  };

  /** Throttle state for coalesced (progress-frame) notifications. */
  private lastNotifyAt = 0;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(command: string, port: MessagePort, opts?: BlockControllerOptions) {
    this.command = command;
    this.controlTarget = opts?.controlTarget ?? null;
    this.port = port;
    this.isMirror = opts?.mirror ?? false;
    this.hasControl = !this.isMirror;
    this.snapshot = this.buildSnapshot();
    liveControllers.add(this);
    if (typeof window !== 'undefined') {
      window.addEventListener('ez:scrollback', this.handleScrollbackChange);
    }

    port.addEventListener('message', (event: MessageEvent<InterpreterFrame>) => {
      this.onFrame(event.data);
    });
    // start() is required for a MessagePort to begin dispatching queued messages.
    port.start();
  }

  /** e2e seam data: pty bytes received off the port vs flushed by xterm. */
  getPtyFlow(): { received: number; consumed: number } {
    return { received: this.ptyReceived, consumed: this.ptyConsumed };
  }

  /** Detailed test/diagnostic seam for the load-bearing ACK invariant. */
  getPtyFlowAccounting(): { received: number; consumed: number; acked: number } {
    return {
      received: this.ptyReceived,
      consumed: this.ptyConsumed,
      acked: this.ptyAckedAt,
    };
  }

  /** Bounded replay diagnostics; no terminal content crosses this seam. */
  getPtyRetention(): { bytes: number; lineBreaks: number; chunks: number } {
    return this.ptyBuffer.diagnostics();
  }

  // ── external store ────────────────────────────────────────────────────────
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): BlockSnapshot => this.snapshot;

  /** Read a cached row by absolute index (undefined while it is being fetched). */
  getRow(index: number): ResultRow | undefined {
    return this.cache.get(index);
  }

  // ── controls (renderer → interpreter) ───────────────────────────────────────
  /** Explicit fetch of a window — used for the initial page. */
  requestRows(start: number, count: number): void {
    this.fetchWindow('requestRows', start, count);
  }

  /** Viewport hint — used on scroll; also warms read-ahead on the interpreter. */
  setViewport(start: number, count: number): void {
    this.fetchWindow('setViewport', start, count);
  }

  cancel(): void {
    this.port.postMessage({ type: 'cancel' });
  }

  /** Settle a run whose transport vanished before it could emit a terminal
   * frame. Keeping the buffered output visible makes the interruption explicit
   * while releasing every renderer-side busy/input gate. */
  markTransportInterrupted(message: string): void {
    if (this.status !== 'running') return;
    this.finishPlainAnsi();
    this.flushPlainSink();
    this.status = 'error';
    this.errorMessage = message;
    this.sshPrompt = null;
    this.emitChange(true);
  }

  // ── PTY block (Phase 2 TUI + Phase 3 adaptive render) ────────────────────────
  /** Register the xterm write sink; flushes bytes buffered before mount (which,
   * post-upgrade, is the ENTIRE plain-mode history — see `ptyBuffer`'s doc).
   * Returns an unsubscribe for unmount. */
  setPtyDataSink(sink: PtyDataSink): () => void {
    if (this.ptyDataSink) this.detachPtyDataSink(this.ptyDataSink, this.ptySinkGeneration);
    const generation = ++this.ptySinkGeneration;
    this.ptyDataSink = sink;
    const buffered = this.ptyBuffer.drain();
    for (const entry of buffered) this.writePtyData(entry);
    return () => {
      this.detachPtyDataSink(sink, generation);
    };
  }

  private detachPtyDataSink(sink: PtyDataSink, generation: number): void {
    if (this.ptyDataSink !== sink || this.ptySinkGeneration !== generation) return;
    this.ptyDataSink = null;
    const replay: RetainedPtyChunk[] = [];
    const remaining: InFlightPtyWrite[] = [];
    for (const delivery of this.inFlightPtyWrites) {
      if (delivery.generation === generation && !delivery.settled) {
        delivery.settled = true;
        replay.push(delivery.entry);
      } else if (!delivery.settled) {
        remaining.push(delivery);
      }
    }
    this.inFlightPtyWrites = remaining;
    // Pending writes predate anything that arrived after detachment.
    this.ptyBuffer.prepend(replay);
  }

  /** Register the plain-mode sink; converts and replays bounded raw history so a
   * late-registering (or re-registering, e.g. collapse -> expand) view starts
   * with the full accumulated output. Returns an unsubscribe. */
  setPlainDataSink(sink: PlainDataSink, flush?: () => void): () => void {
    this.plainSink = sink;
    this.plainSinkFlush = flush ?? null;
    const replayAnsi = new AnsiHtmlStream();
    for (const entry of this.ptyBuffer.snapshot()) {
      for (const html of replayAnsi.pushFragments(entry.bytes)) this.deliverPlainHtml(html);
    }
    if (this.status !== 'running') {
      for (const html of replayAnsi.flushFragments()) this.deliverPlainHtml(html);
    }
    this.flushPlainSink();
    return () => {
      if (this.plainSink === sink) {
        this.plainSink = null;
        this.plainSinkFlush = null;
      }
    };
  }

  /** Register the imperative clear operation for the mounted plain/xterm view. */
  setPtyReplayResetHandler(handler: () => void): () => void {
    this.ptyReplayResetHandler = handler;
    return () => {
      if (this.ptyReplayResetHandler === handler) this.ptyReplayResetHandler = null;
    };
  }

  private resetForPtyReplay(): void {
    this.cache.clear();
    this.status = 'running';
    this.shape = null;
    this.columns = [];
    this.rowCount = 0;
    this.exhausted = false;
    this.errorMessage = null;
    this.sshConnectionId = null;
    this.sshConnectionState = null;
    this.ptyRestoreWarning = null;
    this.startCwd = null;
    this.endCwd = null;
    this.sshPrompt = null;
    this.requestedKey = '';
    this.requestedWindow = null;
    this.ptyBuffer.clear();
    this.discardInFlightPtyWrites();
    this.plainAnsi = new AnsiHtmlStream();
    this.plainAnsiFinished = false;
    this.ptyReceived = 0;
    this.ptyConsumed = 0;
    this.ptyAckedAt = 0;
    this.ptyFlowEpoch += 1;
    this.ptyReplayResetHandler?.();
  }

  /** Route bytes to the current render mode. Plain mode converts + acks
   * IMMEDIATELY (no async flush to wait on — there is no xterm yet) and always
   * retains the raw bytes for a future xterm replay if the block upgrades.
   * Xterm mode is unchanged from Phase 2: hand to the sink and ack once
   * xterm's `term.write` actually flushes it. */
  private deliverPtyData(bytes: Uint8Array, suppressSideEffects: boolean): void {
    if (this.ptyRenderMode === 'plain') {
      this.ptyBuffer.append(
        { bytes, suppressSideEffects, alreadyConsumed: true },
        {
          maxLines: activeScrollbackLines(),
          maxBytes: PTY_PLAIN_HISTORY_MAX_BYTES,
        },
      );
      for (const html of this.plainAnsi.pushFragments(bytes)) {
        this.deliverPlainHtml(html);
      }
      // Raw history was retained before rendering. Even if the DOM sink failed
      // and switched this block to xterm, the current entry is safe to consume:
      // xterm replay marks it alreadyConsumed and cannot ACK it a second time.
      this.ptyConsumed += bytes.byteLength;
      this.maybeSendPtyAck();
      return;
    }
    const sink = this.ptyDataSink;
    if (!sink) {
      // Unlike acknowledged plain history, these bytes cannot be dropped: the
      // interpreter's unacked-byte high-water mark bounds this pre-mount queue.
      this.ptyBuffer.append({ bytes, suppressSideEffects, alreadyConsumed: false });
      return;
    }
    this.writePtyData({ bytes, suppressSideEffects, alreadyConsumed: false });
  }

  private finishPlainAnsi(): void {
    if (this.ptyRenderMode !== 'plain' || this.plainAnsiFinished) return;
    this.plainAnsiFinished = true;
    for (const html of this.plainAnsi.flushFragments()) {
      this.deliverPlainHtml(html);
    }
  }

  private deliverPlainHtml(html: string): void {
    const sink = this.plainSink;
    if (!sink) return;
    try {
      sink(html);
    } catch (error) {
      this.fallbackFromPlainRenderer(error);
    }
  }

  private flushPlainSink(): void {
    const flush = this.plainSinkFlush;
    if (!flush) return;
    try {
      flush();
    } catch (error) {
      this.fallbackFromPlainRenderer(error);
    }
  }

  /**
   * A renderer failure must not strand the interpreter behind an unacknowledged
   * PTY high-water mark. Raw history is authoritative and bounded, so xterm can
   * replay it while the release harness records the console error as a failure.
   */
  private fallbackFromPlainRenderer(error: unknown): void {
    if (this.ptyRenderMode !== 'plain') return;
    this.ptyRenderMode = 'xterm';
    this.plainSink = null;
    this.plainSinkFlush = null;
    this.plainAnsi = new AnsiHtmlStream();
    this.plainAnsiFinished = false;
    console.error('Plain PTY renderer failed; falling back to xterm.', error);
    this.emitChange(true);
  }

  private writePtyData(entry: RetainedPtyChunk): void {
    const sink = this.ptyDataSink;
    if (!sink) {
      this.ptyBuffer.append(entry);
      return;
    }
    const size = entry.bytes.byteLength;
    const epoch = this.ptyFlowEpoch;
    const delivery: InFlightPtyWrite = {
      entry,
      generation: this.ptySinkGeneration,
      settled: false,
    };
    this.inFlightPtyWrites.push(delivery);
    const settle = (): void => {
      if (delivery.settled) return;
      delivery.settled = true;
      const index = this.inFlightPtyWrites.indexOf(delivery);
      if (index >= 0) this.inFlightPtyWrites.splice(index, 1);
    };
    try {
      sink(entry.bytes, () => {
        // xterm callbacks are expected once, but make the accounting invariant
        // robust to duplicate callbacks and callbacks from a reset/unmounted view.
        if (delivery.settled || epoch !== this.ptyFlowEpoch) return;
        settle();
        if (entry.alreadyConsumed) return; // plain -> xterm replay: never re-ACK
        this.ptyConsumed += size;
        this.maybeSendPtyAck();
      }, { suppressSideEffects: entry.suppressSideEffects });
    } catch (error) {
      settle();
      this.ptyBuffer.prepend([entry]);
      throw error;
    }
  }

  private discardInFlightPtyWrites(): void {
    for (const delivery of this.inFlightPtyWrites) delivery.settled = true;
    this.inFlightPtyWrites = [];
  }

  /** Send a cumulative `pty-ack` once at least one quantum of NEW bytes has
   * been consumed since the last ack. Shared by both plain (immediate) and
   * xterm (flush-driven) consumption — `ptyConsumed` is a single monotonic
   * counter across a plain -> xterm upgrade, so accounting never regresses. */
  private maybeSendPtyAck(): void {
    if (this.ptyAckedAt > this.ptyConsumed || this.ptyConsumed > this.ptyReceived) {
      throw new Error('PTY flow invariant violated: acked <= consumed <= received');
    }
    if (this.ptyConsumed - this.ptyAckedAt >= PTY_ACK_QUANTUM) {
      this.ptyAckedAt = this.ptyConsumed;
      try {
        this.port.postMessage({ type: 'pty-ack', bytes: this.ptyConsumed });
      } catch {
        // Port already closed — the session is over; the ack is moot.
      }
    }
  }

  /** Forward a keystroke / pasted text from xterm to the PTY child. */
  sendPtyInput(data: string): void {
    this.port.postMessage({ type: 'pty-input', data });
  }

  /** Register the mounted xterm view's paste path (`term.paste`) — same
   * register/unregister shape as `setPtyDataSink`. */
  setPasteHandler(handler: (text: string) => void): () => void {
    this.pasteHandler = handler;
    return () => {
      if (this.pasteHandler === handler) this.pasteHandler = null;
    };
  }

  /** Paste text into the PTY through the terminal's paste path when an xterm
   * view is mounted (bracketed-paste framing), raw otherwise. */
  pasteText(text: string): void {
    if (this.pasteHandler) this.pasteHandler(text);
    else this.sendPtyInput(text);
  }

  /** Forward the terminal's new dimensions (xterm FitAddon) to the PTY. */
  sendPtyResize(cols: number, rows: number): void {
    this.port.postMessage({ type: 'pty-resize', cols, rows });
  }

  /** Claim PTY resize authority (control handoff, M8a/M8b) — the interpreter
   * replies with `pty-control` frames to this port and every other one on the
   * run, updating `hasControl` accordingly (see `onFrame`'s `pty-control` case). */
  claimControl(): void {
    this.port.postMessage({ type: 'pty-claim-control' });
  }

  // ── ssh-connect prompt (E5) ──────────────────────────────────────────────────
  /** Answer the outstanding `ssh-prompt`. Clears it locally right away (instant
   * UI feedback / prevents double-submit) — the interpreter is authoritative and
   * silently drops a response naming a stale/already-resolved promptId. */
  sendSshPromptResponse(promptId: string, response: { value?: string; accept?: boolean }): void {
    this.port.postMessage({ type: 'ssh-prompt-response', promptId, ...response });
    if (this.sshPrompt?.promptId === promptId) {
      this.sshPrompt = null;
      this.emitChange(true);
    }
  }

  /** Tear down the block: tell the interpreter to release the store, close the port. */
  dispose(): void {
    this.ptyFlowEpoch += 1;
    this.ptyBuffer.clear();
    this.discardInFlightPtyWrites();
    this.ptyDataSink = null;
    this.plainSink = null;
    this.plainSinkFlush = null;
    this.plainAnsi = new AnsiHtmlStream();
    try {
      this.port.postMessage({ type: 'close' });
    } catch {
      // Port already gone.
    }
    try {
      this.port.close();
    } catch {
      // Already closed.
    }
    if (this.notifyTimer !== null) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.listeners.clear();
    liveControllers.delete(this);
    if (typeof window !== 'undefined') {
      window.removeEventListener('ez:scrollback', this.handleScrollbackChange);
    }
  }

  private fetchWindow(type: 'requestRows' | 'setViewport', start: number, count: number): void {
    if (!Number.isFinite(start) || !Number.isFinite(count)) return;
    const s = Math.max(0, Math.trunc(start));
    const c = Math.min(MAX_ROW_WINDOW, Math.max(0, Math.trunc(count)));
    if (!Number.isSafeInteger(s) || !Number.isSafeInteger(c)) return;
    const key = `${s}:${c}`;
    if (key === this.requestedKey) return; // already asked for this exact window
    this.requestedKey = key;
    this.requestedWindow = { start: s, count: c };
    this.pruneCache(s, c);
    this.port.postMessage({ type, start: s, count: c });
  }

  /** Drop cached rows far from the active window so the cache stays bounded. */
  private pruneCache(start: number, count: number): void {
    const lo = start - KEEP_BUFFER;
    const hi = start + count + KEEP_BUFFER;
    for (const index of this.cache.keys()) {
      if (index < lo || index >= hi) this.cache.delete(index);
    }
  }

  private isInsideRequestedKeepRange(index: number): boolean {
    const window = this.requestedWindow;
    if (!window) return true;
    return (
      index >= window.start - KEEP_BUFFER
      && index < window.start + window.count + KEEP_BUFFER
    );
  }

  // ── frame handling (interpreter → renderer) ─────────────────────────────────
  private onFrame(frame: InterpreterFrame): void {
    // PTY output goes straight to xterm via the sink — it must NOT enter React
    // state (no version bump), or a TUI firehose would thrash rendering.
    if (frame.type === 'pty-data') {
      this.ptyReceived += frame.data.byteLength;
      this.deliverPtyData(frame.data, frame.suppressSideEffects === true);
      return;
    }
    switch (frame.type) {
      case 'start':
        // Status is already 'running'; capture the cwd this block ran in so its
        // prompt line can show it (terminal-style).
        this.startCwd = frame.cwd ?? this.startCwd;
        this.executionKind = frame.executionKind ?? this.executionKind;
        break;
      case 'schema':
        this.shape = frame.shape;
        this.columns = frame.columns;
        this.sshPrompt = null; // channel is up — any prompt phase is over
        break;
      case 'ssh-prompt':
        this.sshPrompt = {
          promptId: frame.promptId,
          kind: frame.kind,
          message: frame.message,
          fingerprint: frame.fingerprint,
          host: frame.host,
        };
        break;
      case 'chunk':
        for (let i = 0; i < frame.rows.length; i++) {
          const index = frame.start + i;
          if (this.requestedWindow && !this.isInsideRequestedKeepRange(index)) continue;
          this.cache.set(index, frame.rows[i]);
        }
        if (this.requestedWindow) {
          this.pruneCache(this.requestedWindow.start, this.requestedWindow.count);
        }
        break;
      case 'progress':
        this.rowCount = frame.count;
        this.exhausted = frame.done;
        break;
      case 'end':
        this.finishPlainAnsi();
        this.flushPlainSink();
        this.status = 'done';
        // cwd AFTER the command — a `cd` updates the live prompt off this.
        this.endCwd = frame.cwd ?? this.endCwd;
        break;
      case 'error':
        this.finishPlainAnsi();
        this.flushPlainSink();
        this.status = 'error';
        this.errorMessage = frame.message;
        this.sshPrompt = null;
        break;
      case 'cancelled':
        this.finishPlainAnsi();
        this.flushPlainSink();
        this.status = 'cancelled';
        this.sshPrompt = null;
        break;
      case 'pty-render-upgrade':
        // Irreversible: plain -> xterm only. The plain view's sink is dropped
        // here (it is about to unmount); PtyBlock.tsx's xterm view registers
        // setPtyDataSink on mount, replaying everything buffered so far.
        this.ptyRenderMode = 'xterm';
        this.plainSink = null;
        this.plainSinkFlush = null;
        this.plainAnsi = new AnsiHtmlStream();
        this.plainAnsiFinished = false;
        break;
      case 'pty-dims':
        this.ptyDims = { cols: frame.cols, rows: frame.rows };
        break;
      case 'pty-control':
        this.hasControl = frame.hasControl;
        break;
      case 'ssh-connection':
        this.sshConnectionId = frame.connectionId;
        this.sshConnectionState = frame.state;
        break;
      case 'pty-replay-reset':
        this.resetForPtyReplay();
        break;
      case 'pty-restore-warning':
        this.ptyRestoreWarning = frame;
        break;
    }
    // Only `progress` storms; every other frame is one-shot (or user-paced, like
    // `chunk` answering a viewport request) and notifies synchronously.
    this.emitChange(frame.type !== 'progress');
  }

  private emitChange(urgent: boolean): void {
    this.version += 1;
    this.snapshot = this.buildSnapshot();
    if (urgent) {
      if (this.notifyTimer !== null) {
        clearTimeout(this.notifyTimer);
        this.notifyTimer = null;
      }
      this.notifyListeners();
      return;
    }
    if (this.notifyTimer !== null) return; // trailing notify already scheduled
    const elapsed = Date.now() - this.lastNotifyAt;
    if (elapsed >= NOTIFY_THROTTLE_MS) {
      this.notifyListeners();
      return;
    }
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.notifyListeners(); // snapshot is current — nothing coalesced is lost
    }, NOTIFY_THROTTLE_MS - elapsed);
  }

  private notifyListeners(): void {
    this.lastNotifyAt = Date.now();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): BlockSnapshot {
    return {
      status: this.status,
      executionKind: this.executionKind,
      sshConnectionId: this.sshConnectionId,
      sshConnectionState: this.sshConnectionState,
      ptyRestoreWarning: this.ptyRestoreWarning,
      shape: this.shape,
      columns: this.columns,
      rowCount: this.rowCount,
      exhausted: this.exhausted,
      errorMessage: this.errorMessage,
      startCwd: this.startCwd,
      endCwd: this.endCwd,
      sshPrompt: this.sshPrompt,
      ptyRenderMode: this.ptyRenderMode,
      ptyDims: this.ptyDims,
      hasControl: this.hasControl,
      version: this.version,
    };
  }
}
