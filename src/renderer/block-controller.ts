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
  InterpreterFrame,
  ResultRow,
  ResultShape,
} from '../shared/ipc';
// AnsiHtmlStream is a pure browser-safe utility (ansi_up + TextDecoder, no Node
// APIs) — reused as-is from the interpreter side rather than duplicated, for the
// PTY block's plain-mode render (M3), which needs the SAME ansi->html conversion
// TextBlock.tsx gets for free from the interpreter's byte-stream path.
import { AnsiHtmlStream } from '../interpreter/external/ansi';

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

/**
 * Minimum gap between listener notifications for `progress` frames. A fast
 * builtin (`gen-rows 100000000`) reports progress every 5000-row drain batch —
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

/** PTY byte sink: `onFlushed` MUST be called once xterm has consumed `bytes`
 * (term.write's callback) — it drives the backpressure ack. */
export type PtyDataSink = (bytes: Uint8Array, onFlushed: () => void) => void;

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
  private readonly port: MessagePort;
  /** True for a non-initiating `attach-run` observer (mobile mirroring fix,
   * D4) — PtyBlock.tsx reads this to size its xterm from `ptyDims` instead of
   * FitAddon-reporting its own size back (which would resize the shared PTY). */
  readonly isMirror: boolean;

  private readonly cache = new Map<number, ResultRow>();
  private status: BlockStatus = 'running';
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

  /** PTY blocks stream raw bytes straight to xterm — NEVER into React state. The
   * sink is the mounted PtyBlock's `term.write`; bytes that arrive before it
   * mounts are buffered and flushed on registration. While `ptyRenderMode` is
   * `plain`, this buffer ALSO doubles as the pre-upgrade history: nothing is
   * ever written to `ptyDataSink` in plain mode, so every plain-mode byte stays
   * queued here until (if) an xterm sink registers post-upgrade and replays it
   * (Phase 3 "resize then replay" — PtyBlock.tsx sends the real pane size
   * before registering, so replay renders at the right dimensions). The buffer
   * is NOT unbounded: buffered bytes are never xterm-acked, so the interpreter
   * pauses the PTY at its high-water mark (gate B2) — plain mode acks
   * separately/immediately below (M3), so this only throttles once xterm is
   * the active (and lagging) consumer.
   */
  private ptyDataSink: PtyDataSink | null = null;
  private ptyBuffer: Uint8Array[] = [];

  /** Paste seam (mobile long-press menu): an xterm view registers
   * `term.paste` here so pasted text gets bracketed-paste framing and \n→\r
   * normalization when the child enabled it (claude/codex do) instead of
   * landing as raw keystroke bytes. Absent (plain view / not mounted), paste
   * falls back to a raw `sendPtyInput`. */
  private pasteHandler: ((text: string) => void) | null = null;

  /** Phase 3 adaptive render: mode + the plain-mode ansi->html pipeline. A
   * single `AnsiHtmlStream` instance is reused for the block's entire plain
   * phase so SGR state (current fg/bg/bold) carries across chunks; `plainHtml`
   * accumulates the converted output so a LATE-registering plain sink (e.g. the
   * block re-expanding after being collapsed) can replay it in one shot. */
  private ptyRenderMode: PtyRenderMode = 'plain';
  private readonly plainAnsi = new AnsiHtmlStream();
  private plainHtml = '';
  private plainSink: PlainDataSink | null = null;

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

  private snapshot: BlockSnapshot;
  private readonly listeners = new Set<() => void>();

  /** Throttle state for coalesced (progress-frame) notifications. */
  private lastNotifyAt = 0;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(command: string, port: MessagePort, opts?: { readonly mirror?: boolean }) {
    this.command = command;
    this.port = port;
    this.isMirror = opts?.mirror ?? false;
    this.hasControl = !this.isMirror;
    this.snapshot = this.buildSnapshot();
    liveControllers.add(this);

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

  // ── PTY block (Phase 2 TUI + Phase 3 adaptive render) ────────────────────────
  /** Register the xterm write sink; flushes bytes buffered before mount (which,
   * post-upgrade, is the ENTIRE plain-mode history — see `ptyBuffer`'s doc).
   * Returns an unsubscribe for unmount. */
  setPtyDataSink(sink: PtyDataSink): () => void {
    this.ptyDataSink = sink;
    if (this.ptyBuffer.length > 0) {
      const buffered = this.ptyBuffer;
      this.ptyBuffer = [];
      for (const bytes of buffered) this.deliverPtyData(bytes);
    }
    return () => {
      if (this.ptyDataSink === sink) this.ptyDataSink = null;
    };
  }

  /** Register the plain-mode sink; replays already-converted HTML so a
   * late-registering (or re-registering, e.g. collapse -> expand) view starts
   * with the full accumulated output. Returns an unsubscribe. */
  setPlainDataSink(sink: PlainDataSink): () => void {
    this.plainSink = sink;
    if (this.plainHtml) sink(this.plainHtml);
    return () => {
      if (this.plainSink === sink) this.plainSink = null;
    };
  }

  /** Route bytes to the current render mode. Plain mode converts + acks
   * IMMEDIATELY (no async flush to wait on — there is no xterm yet) and always
   * retains the raw bytes for a future xterm replay if the block upgrades.
   * Xterm mode is unchanged from Phase 2: hand to the sink and ack once
   * xterm's `term.write` actually flushes it. */
  private deliverPtyData(bytes: Uint8Array): void {
    if (this.ptyRenderMode === 'plain') {
      this.ptyBuffer.push(bytes); // retained for a possible xterm replay later
      const html = this.plainAnsi.push(bytes);
      if (html) {
        this.plainHtml += html;
        this.plainSink?.(html);
      }
      this.ptyConsumed += bytes.byteLength;
      this.maybeSendPtyAck();
      return;
    }
    const sink = this.ptyDataSink;
    if (!sink) {
      this.ptyBuffer.push(bytes);
      return;
    }
    const size = bytes.byteLength;
    sink(bytes, () => {
      this.ptyConsumed += size;
      this.maybeSendPtyAck();
    });
  }

  /** Send a cumulative `pty-ack` once at least one quantum of NEW bytes has
   * been consumed since the last ack. Shared by both plain (immediate) and
   * xterm (flush-driven) consumption — `ptyConsumed` is a single monotonic
   * counter across a plain -> xterm upgrade, so accounting never regresses. */
  private maybeSendPtyAck(): void {
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
  }

  private fetchWindow(type: 'requestRows' | 'setViewport', start: number, count: number): void {
    const s = Math.max(0, Math.trunc(start));
    const c = Math.max(0, Math.trunc(count));
    const key = `${s}:${c}`;
    if (key === this.requestedKey) return; // already asked for this exact window
    this.requestedKey = key;
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

  // ── frame handling (interpreter → renderer) ─────────────────────────────────
  private onFrame(frame: InterpreterFrame): void {
    // PTY output goes straight to xterm via the sink — it must NOT enter React
    // state (no version bump), or a TUI firehose would thrash rendering.
    if (frame.type === 'pty-data') {
      this.ptyReceived += frame.data.byteLength;
      this.deliverPtyData(frame.data);
      return;
    }
    switch (frame.type) {
      case 'start':
        // Status is already 'running'; capture the cwd this block ran in so its
        // prompt line can show it (terminal-style).
        this.startCwd = frame.cwd ?? this.startCwd;
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
          this.cache.set(frame.start + i, frame.rows[i]);
        }
        break;
      case 'progress':
        this.rowCount = frame.count;
        this.exhausted = frame.done;
        break;
      case 'end':
        this.status = 'done';
        // cwd AFTER the command — a `cd` updates the live prompt off this.
        this.endCwd = frame.cwd ?? this.endCwd;
        break;
      case 'error':
        this.status = 'error';
        this.errorMessage = frame.message;
        this.sshPrompt = null;
        break;
      case 'cancelled':
        this.status = 'cancelled';
        this.sshPrompt = null;
        break;
      case 'pty-render-upgrade':
        // Irreversible: plain -> xterm only. The plain view's sink is dropped
        // here (it is about to unmount); PtyBlock.tsx's xterm view registers
        // setPtyDataSink on mount, replaying everything buffered so far.
        this.ptyRenderMode = 'xterm';
        this.plainSink = null;
        break;
      case 'pty-dims':
        this.ptyDims = { cols: frame.cols, rows: frame.rows };
        break;
      case 'pty-control':
        this.hasControl = frame.hasControl;
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
