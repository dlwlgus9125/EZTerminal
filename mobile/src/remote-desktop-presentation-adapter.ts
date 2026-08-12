import {
  MAX_DESKTOP_VIEWPORT_PIXELS,
  MIN_DESKTOP_VIEWPORT_PIXELS,
  type DesktopControlCapabilities,
  type DesktopControlEndedMessage,
  type DesktopControlStartResultMessage,
  type DesktopControlStatusMessage,
  type DesktopDisplay,
  type DesktopNormalizedRegion,
  type DesktopQualityPreference,
  type DesktopSessionSignal,
  type DesktopSignalMessage,
  type DesktopVideoViewport,
} from '../../src/shared/remote-protocol';
import type { RemoteConnectionState } from './transport/connection-health';

export const MAX_DESKTOP_CONTROL_FRAME_BYTES = 64 * 1024;
export const MAX_DESKTOP_CLIPBOARD_BYTES = 256 * 1024;
export const MAX_DESKTOP_INBOUND_CONTROL_FRAME_BYTES =
  MAX_DESKTOP_CLIPBOARD_BYTES * 6 + 4 * 1024;

const MAX_DESKTOP_SDP_BYTES = 256 * 1024;
const MAX_DESKTOP_ICE_BYTES = 8 * 1024;
const MAX_PENDING_DESKTOP_ICE_CANDIDATES = 128;
const MAX_KEY_CODE_CHARS = 128;
const MAX_DISPLAY_ID_CHARS = 256;
const MAX_POINTER_DELTA = 1_000_000;
const POINTER_BACKPRESSURE_BYTES = 32 * 1024;
const POINTER_FLUSH_DELAY_MS = 16;
const CLIENT_VIDEO_STATS_INTERVAL_MS = 2_000;

export type DesktopPresentationPhase =
  | 'starting'
  | 'active'
  | 'reconnecting'
  | 'busy'
  | 'error';

export type DesktopPresentationDetail =
  | { readonly kind: 'busy'; readonly controllerName?: string }
  | { readonly kind: 'start-error'; readonly errorCode?: string }
  | { readonly kind: 'start-failed' }
  | { readonly kind: 'negotiation-failed' }
  | {
      readonly kind: 'ended';
      readonly reason: DesktopControlEndedMessage['reason'];
    }
  | null;

export type DesktopClipboardFeedback =
  | 'none'
  | 'sent'
  | 'copied'
  | 'permission'
  | 'invalid'
  | 'input-unavailable';

export interface DesktopPresentationSnapshot {
  readonly phase: DesktopPresentationPhase;
  readonly detail: DesktopPresentationDetail;
  readonly displays: readonly DesktopDisplay[];
  readonly selectedDisplayId: string | null;
  readonly capabilities: DesktopControlCapabilities | null;
  readonly status: DesktopControlStatusMessage | null;
  readonly clipboardFeedback: DesktopClipboardFeedback;
  readonly appliedView: DesktopAppliedView | null;
}

export interface DesktopAppliedView {
  readonly revision: number;
  readonly sourceRegion: DesktopNormalizedRegion;
  readonly frameWidth: number;
  readonly frameHeight: number;
}

export type DesktopPointerCommand =
  | { readonly type: 'pointer-absolute'; readonly x: number; readonly y: number }
  | { readonly type: 'pointer-relative'; readonly dx: number; readonly dy: number };

export type DesktopMouseButton = 'left' | 'right' | 'middle';
export type DesktopKeyModifier = 'control' | 'alt' | 'shift' | 'meta';

export type DesktopControlCommand =
  | {
      readonly type: 'pointer-button';
      readonly button: DesktopMouseButton;
      readonly down: boolean;
      readonly x?: number;
      readonly y?: number;
    }
  | {
      readonly type: 'pointer-click';
      readonly button: DesktopMouseButton;
      readonly count: 1 | 2;
    }
  | { readonly type: 'wheel'; readonly deltaX: number; readonly deltaY: number }
  | {
      readonly type: 'key';
      readonly code: string;
      readonly down: boolean;
      readonly modifiers: readonly DesktopKeyModifier[];
    }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'clipboard-write'; readonly text: string }
  | { readonly type: 'clipboard-read' }
  | { readonly type: 'set-display'; readonly displayId: string }
  | ({ readonly type: 'set-viewport' } & DesktopVideoViewport)
  | {
      readonly type: 'client-video-stats';
      readonly droppedFramePercent: number;
      readonly decodedFramesPerSecond?: number;
      readonly targetFramesPerSecond?: number;
      readonly freezeDurationMs?: number;
    }
  | { readonly type: 'set-quality-preference'; readonly preference: DesktopQualityPreference }
  | { readonly type: 'secure-attention' };

export interface DesktopPresentationTransport {
  startDesktopControl(
    viewport?: DesktopVideoViewport,
    qualityPreference?: DesktopQualityPreference,
  ): Promise<DesktopControlStartResultMessage>;
  sendDesktopSignal(sessionId: string, signal: DesktopSessionSignal): boolean;
  stopDesktopControl(
    sessionId: string,
    reason: 'client-stop' | 'background' | 'navigation',
  ): boolean;
  onDesktopSignal(listener: (message: DesktopSignalMessage) => void): () => void;
  onDesktopStatus(listener: (message: DesktopControlStatusMessage) => void): () => void;
  onDesktopEnded(listener: (message: DesktopControlEndedMessage) => void): () => void;
  onConnectionStateChange(listener: (state: RemoteConnectionState) => void): () => void;
}

export interface DesktopClipboardAdapter {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export interface DesktopVisibilityAdapter {
  isHidden(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface DesktopPresentationDependencies {
  readonly clipboard: DesktopClipboardAdapter;
  readonly visibility: DesktopVisibilityAdapter;
  readonly createPeerConnection: () => RTCPeerConnection;
}

export interface DesktopPresentationAdapter {
  readonly getSnapshot: () => DesktopPresentationSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  start(): void;
  attachVideo(video: HTMLVideoElement | null): void;
  setViewport(viewport: DesktopVideoViewport): void;
  setQualityPreference(preference: DesktopQualityPreference): boolean;
  resume(): void;
  sendControl(command: DesktopControlCommand): boolean;
  sendPointer(command: DesktopPointerCommand): boolean;
  selectDisplay(displayId: string): boolean;
  sendLocalClipboard(): Promise<void>;
  copyRemoteClipboard(): void;
  stop(reason: 'client-stop' | 'background' | 'navigation'): void;
  dispose(): void;
}

type InboundControlMessage =
  | { readonly type: 'clipboard-text'; readonly text: string }
  | { readonly type: 'input-error' }
  | ({ readonly type: 'view-applied' } & DesktopAppliedView);

interface PeerBinding {
  readonly generation: number;
  readonly peer: RTCPeerConnection;
  readonly control: RTCDataChannel;
  readonly pointer: RTCDataChannel;
  readonly cleanup: () => void;
  answerQueued: boolean;
  pendingIce: Array<Extract<DesktopSessionSignal, { readonly type: 'ice' }>>;
  signalChain: Promise<void>;
}

export const INITIAL_DESKTOP_PRESENTATION_SNAPSHOT: DesktopPresentationSnapshot = {
  phase: 'starting',
  detail: null,
  displays: [],
  selectedDisplayId: null,
  capabilities: null,
  status: null,
  clipboardFeedback: 'none',
  appliedView: null,
};

const textEncoder = new TextEncoder();

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasBoundedUtf8(value: string, maximumBytes: number): boolean {
  // Every UTF-16 code unit produces at least one UTF-8 byte. This cheap guard
  // avoids allocating an encoded copy for an obviously hostile frame.
  return value.length <= maximumBytes
    && hasWellFormedUnicode(value)
    && textEncoder.encode(value).byteLength <= maximumBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decodeDesktopControlFrame(data: unknown): InboundControlMessage | null {
  if (
    typeof data !== 'string'
    || !hasBoundedUtf8(data, MAX_DESKTOP_INBOUND_CONTROL_FRAME_BYTES)
  ) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'input-error') return { type: 'input-error' };
  if (value.type === 'view-applied') {
    if (
      !Number.isSafeInteger(value.revision)
      || (value.revision as number) <= 0
      || !validNormalizedRegion(value.sourceRegion)
      || !Number.isSafeInteger(value.frameWidth)
      || (value.frameWidth as number) < MIN_DESKTOP_VIEWPORT_PIXELS
      || (value.frameWidth as number) > MAX_DESKTOP_VIEWPORT_PIXELS
      || !Number.isSafeInteger(value.frameHeight)
      || (value.frameHeight as number) < MIN_DESKTOP_VIEWPORT_PIXELS
      || (value.frameHeight as number) > MAX_DESKTOP_VIEWPORT_PIXELS
    ) return null;
    return {
      type: 'view-applied',
      revision: value.revision as number,
      sourceRegion: value.sourceRegion,
      frameWidth: value.frameWidth as number,
      frameHeight: value.frameHeight as number,
    };
  }
  if (
    value.type !== 'clipboard-text'
    || typeof value.text !== 'string'
    || !hasBoundedUtf8(value.text, MAX_DESKTOP_CLIPBOARD_BYTES)
  ) {
    return null;
  }
  return { type: 'clipboard-text', text: value.text };
}

function isUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validNormalizedRegion(value: unknown): value is DesktopNormalizedRegion {
  if (!isRecord(value)) return false;
  const { x, y, width, height } = value;
  return [x, y, width, height].every((entry) => (
    typeof entry === 'number' && Number.isFinite(entry)
  )) && (x as number) >= 0
    && (y as number) >= 0
    && (x as number) < 1
    && (y as number) < 1
    && (width as number) > 0
    && (height as number) > 0
    && (x as number) + (width as number) <= 1 + 1e-9
    && (y as number) + (height as number) <= 1 + 1e-9;
}

function validQualityPreference(value: unknown): value is DesktopQualityPreference {
  return value === 'balanced' || value === 'clarity' || value === 'responsiveness';
}

function isDelta(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_POINTER_DELTA;
}

function isMouseButton(value: DesktopMouseButton): boolean {
  return value === 'left' || value === 'right' || value === 'middle';
}

function isModifier(value: DesktopKeyModifier): boolean {
  return value === 'control' || value === 'alt' || value === 'shift' || value === 'meta';
}

function validPointerCommand(command: DesktopPointerCommand): boolean {
  if (command.type === 'pointer-absolute') return isUnit(command.x) && isUnit(command.y);
  return isDelta(command.dx) && isDelta(command.dy);
}

function coalescePointer(
  current: DesktopPointerCommand | null,
  next: DesktopPointerCommand,
): DesktopPointerCommand {
  if (current?.type === 'pointer-relative' && next.type === 'pointer-relative') {
    return {
      type: 'pointer-relative',
      dx: Math.max(-MAX_POINTER_DELTA, Math.min(MAX_POINTER_DELTA, current.dx + next.dx)),
      dy: Math.max(-MAX_POINTER_DELTA, Math.min(MAX_POINTER_DELTA, current.dy + next.dy)),
    };
  }
  return next;
}

function validViewport(viewport: DesktopVideoViewport): boolean {
  return Number.isInteger(viewport.pixelWidth)
    && viewport.pixelWidth >= MIN_DESKTOP_VIEWPORT_PIXELS
    && viewport.pixelWidth <= MAX_DESKTOP_VIEWPORT_PIXELS
    && Number.isInteger(viewport.pixelHeight)
    && viewport.pixelHeight >= MIN_DESKTOP_VIEWPORT_PIXELS
    && viewport.pixelHeight <= MAX_DESKTOP_VIEWPORT_PIXELS
    && (viewport.visibleRegion === undefined || validNormalizedRegion(viewport.visibleRegion))
    && (viewport.revision === undefined
      || (Number.isSafeInteger(viewport.revision) && viewport.revision > 0));
}

function validControlCommand(command: DesktopControlCommand): boolean {
  switch (command.type) {
    case 'pointer-button': {
      if (!isMouseButton(command.button) || typeof command.down !== 'boolean') return false;
      const hasX = command.x !== undefined;
      const hasY = command.y !== undefined;
      return hasX === hasY && (!hasX || (isUnit(command.x!) && isUnit(command.y!)));
    }
    case 'pointer-click':
      return isMouseButton(command.button) && (command.count === 1 || command.count === 2);
    case 'wheel':
      return isDelta(command.deltaX) && isDelta(command.deltaY);
    case 'key':
      return command.code.length > 0
        && command.code.length <= MAX_KEY_CODE_CHARS
        && command.modifiers.length <= 4
        && command.modifiers.every(isModifier);
    case 'text':
      return command.text.length > 0
        && hasBoundedUtf8(command.text, MAX_DESKTOP_CLIPBOARD_BYTES);
    case 'clipboard-write':
      return command.text.length > 0
        && hasBoundedUtf8(command.text, MAX_DESKTOP_CLIPBOARD_BYTES);
    case 'clipboard-read':
    case 'secure-attention':
      return true;
    case 'set-display':
      return command.displayId.length > 0
        && command.displayId.length <= MAX_DISPLAY_ID_CHARS;
    case 'set-viewport':
      return validViewport(command);
    case 'client-video-stats':
      return Number.isFinite(command.droppedFramePercent)
        && command.droppedFramePercent >= 0
        && command.droppedFramePercent <= 100
        && (command.decodedFramesPerSecond === undefined
          || (Number.isFinite(command.decodedFramesPerSecond)
            && command.decodedFramesPerSecond >= 0
            && command.decodedFramesPerSecond <= 240))
        && (command.targetFramesPerSecond === undefined
          || (Number.isFinite(command.targetFramesPerSecond)
            && command.targetFramesPerSecond >= 0
            && command.targetFramesPerSecond <= 240))
        && (command.freezeDurationMs === undefined
          || (Number.isInteger(command.freezeDurationMs)
            && command.freezeDurationMs >= 0
            && command.freezeDurationMs <= 10_000));
    case 'set-quality-preference':
      return validQualityPreference(command.preference);
  }
}

function safeCapabilities(value: DesktopControlCapabilities): DesktopControlCapabilities {
  return {
    ctrlAltDelete: value?.ctrlAltDelete === true,
    clipboardText: value?.clipboardText === true,
    directTouch: value?.directTouch === true,
    multiMonitor: value?.multiMonitor === true,
    adaptiveViewport: value?.adaptiveViewport === true,
    adaptiveRegion: value?.adaptiveRegion === true,
    qualityPreferences: Array.isArray(value?.qualityPreferences)
      ? value.qualityPreferences.filter(validQualityPreference).slice(0, 3)
      : undefined,
    clientVideoStatsV2: value?.clientVideoStatsV2 === true,
  };
}

function regionsEqual(
  left: DesktopNormalizedRegion | undefined,
  right: DesktopNormalizedRegion | undefined,
): boolean {
  if (left === right) return true;
  return Boolean(left && right
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height);
}

function safeDisplays(values: readonly DesktopDisplay[]): readonly DesktopDisplay[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((display) => {
    if (
      typeof display?.id !== 'string'
      || display.id.length === 0
      || display.id.length > MAX_DISPLAY_ID_CHARS
      || typeof display.name !== 'string'
      || !Number.isFinite(display.width)
      || display.width <= 0
      || !Number.isFinite(display.height)
      || display.height <= 0
    ) {
      return [];
    }
    return [{
      id: display.id,
      name: display.name,
      width: display.width,
      height: display.height,
      rotationDegrees: Number.isFinite(display.rotationDegrees) ? display.rotationDegrees : 0,
      primary: display.primary === true,
    }];
  });
}

function validSignal(signal: unknown): signal is DesktopSessionSignal {
  if (!isRecord(signal) || typeof signal.type !== 'string') return false;
  if (signal.type === 'ice') {
    const candidate = signal.candidate;
    if (!isRecord(candidate) || typeof candidate.candidate !== 'string') {
      return false;
    }
    return candidate.candidate.length > 0
      && hasBoundedUtf8(candidate.candidate, MAX_DESKTOP_ICE_BYTES)
      && (
        candidate.sdpMid === undefined
        || candidate.sdpMid === null
        || (
          typeof candidate.sdpMid === 'string'
          && hasBoundedUtf8(candidate.sdpMid, 128)
        )
      )
      && (
        candidate.sdpMLineIndex === undefined
        || candidate.sdpMLineIndex === null
        || (
          typeof candidate.sdpMLineIndex === 'number'
          && Number.isInteger(candidate.sdpMLineIndex)
          && candidate.sdpMLineIndex >= 0
        )
      );
  }
  return (signal.type === 'offer' || signal.type === 'answer')
    && typeof signal.sdp === 'string'
    && signal.sdp.length > 0
    && hasBoundedUtf8(signal.sdp, MAX_DESKTOP_SDP_BYTES);
}

function startFailureDetail(
  result: Extract<DesktopControlStartResultMessage, { readonly ok: false }>,
): DesktopPresentationDetail {
  if (result.reason === 'busy') {
    return { kind: 'busy', controllerName: result.controllerName };
  }
  return { kind: 'start-error', errorCode: result.errorCode };
}

/**
 * Owns the remote desktop presentation lifecycle behind one small seam.
 *
 * Ordering invariant: `start()` is idempotent; `stop()` invalidates every
 * outstanding negotiation before returning; `dispose()` releases one
 * activation and stops at most one live session. `start()` may reactivate the
 * same Adapter (React StrictMode does this) and reuses an unresolved start
 * request. A successful late result is either adopted by that new generation
 * or released as an orphan.
 */
export class RemoteDesktopPresentationAdapter implements DesktopPresentationAdapter {
  private snapshot: DesktopPresentationSnapshot = INITIAL_DESKTOP_PRESENTATION_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: Array<() => void> = [];
  private started = false;
  private disposed = false;
  private lifecycleGeneration = 0;
  private negotiationGeneration = 0;
  private activeNegotiation: number | null = null;
  private pendingStart: Promise<DesktopControlStartResultMessage> | null = null;
  private peerGeneration = 0;
  private peerBinding: PeerBinding | null = null;
  private video: HTMLVideoElement | null = null;
  private remoteStream: MediaStream | null = null;
  private viewport: DesktopVideoViewport | null = null;
  private sessionId: string | null = null;
  private resumePending = false;
  private sequence = 0;
  private clipboardReadPending = false;
  private clipboardOperationGeneration = 0;
  private queuedPointer: DesktopPointerCommand | null = null;
  private pointerFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private videoStatsTimer: ReturnType<typeof setInterval> | null = null;
  private previousVideoFrames: { total: number; dropped: number } | null = null;
  private qualityPreference: DesktopQualityPreference = 'balanced';
  private lastPresentedFrameAt: number | null = null;
  private largestPresentedFrameGapMs = 0;
  private videoFrameCallbackId: number | null = null;

  constructor(
    private readonly transport: DesktopPresentationTransport,
    private readonly dependencies: DesktopPresentationDependencies,
  ) {}

  readonly getSnapshot = (): DesktopPresentationSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.started && !this.disposed) return;
    this.disposed = false;
    this.started = true;
    if (this.video && this.videoStatsTimer === null) this.startClientVideoStats();
    this.update({
      phase: this.sessionId ? this.snapshot.phase : 'starting',
      detail: null,
    });
    this.unsubscribe.push(
      this.transport.onDesktopSignal(this.handleSignal),
      this.transport.onDesktopStatus(this.handleStatus),
      this.transport.onDesktopEnded(this.handleEnded),
      this.transport.onConnectionStateChange(this.handleConnectionState),
      this.dependencies.visibility.subscribe(this.handleVisibility),
    );
    if (this.dependencies.visibility.isHidden()) {
      this.stop('background');
      return;
    }
    void this.beginDesktop();
  }

  attachVideo(video: HTMLVideoElement | null): void {
    if (this.video === video) return;
    if (this.video?.srcObject === this.remoteStream) this.video.srcObject = null;
    this.stopClientVideoStats();
    this.video = video;
    this.applyRemoteStream();
    if (video) this.startClientVideoStats();
  }

  setViewport(viewport: DesktopVideoViewport): void {
    if (!validViewport(viewport)) return;
    if (
      this.viewport?.pixelWidth === viewport.pixelWidth
      && this.viewport.pixelHeight === viewport.pixelHeight
      && this.viewport.revision === viewport.revision
      && regionsEqual(this.viewport.visibleRegion, viewport.visibleRegion)
    ) {
      return;
    }
    this.viewport = viewport;
    if (this.sessionId && this.snapshot.capabilities?.adaptiveRegion === true) {
      this.sendControl({ type: 'set-viewport', ...viewport });
    } else if (this.sessionId && this.snapshot.capabilities?.adaptiveViewport === true) {
      this.sendControl({
        type: 'set-viewport',
        pixelWidth: viewport.pixelWidth,
        pixelHeight: viewport.pixelHeight,
      });
    }
  }

  setQualityPreference(preference: DesktopQualityPreference): boolean {
    if (!validQualityPreference(preference)) return false;
    this.qualityPreference = preference;
    const supported = this.snapshot.capabilities?.qualityPreferences;
    if (!this.sessionId) return true;
    if (!supported?.includes(preference)) return false;
    return this.sendControl({ type: 'set-quality-preference', preference });
  }

  resume(): void {
    if (
      this.disposed
      || !this.started
      || this.sessionId
      || this.activeNegotiation !== null
      || this.dependencies.visibility.isHidden()
    ) return;
    this.update({ phase: 'starting', detail: null });
    void this.beginDesktop();
  }

  sendControl(command: DesktopControlCommand): boolean {
    if (!validControlCommand(command)) return false;
    const capabilities = this.snapshot.capabilities;
    if (
      ((command.type === 'clipboard-read' || command.type === 'clipboard-write')
        && capabilities?.clipboardText !== true)
      || (command.type === 'secure-attention' && capabilities?.ctrlAltDelete !== true)
      || (command.type === 'set-display' && capabilities?.multiMonitor !== true)
      || (command.type === 'set-quality-preference'
        && !capabilities?.qualityPreferences?.includes(command.preference))
      || (command.type === 'set-viewport'
        && command.visibleRegion !== undefined
        && capabilities?.adaptiveRegion !== true)
      || (
        command.type === 'pointer-button'
        && command.x !== undefined
        && capabilities?.directTouch !== true
      )
    ) {
      return false;
    }
    if (
      command.type === 'pointer-button'
      || command.type === 'pointer-click'
      || command.type === 'wheel'
    ) {
      this.flushQueuedPointer();
    }
    return this.sendFrame(this.peerBinding?.control ?? null, command);
  }

  sendPointer(command: DesktopPointerCommand): boolean {
    if (!validPointerCommand(command)) return false;
    if (
      command.type === 'pointer-absolute'
      && this.snapshot.capabilities?.directTouch !== true
    ) {
      return false;
    }
    const channel = this.peerBinding?.pointer ?? null;
    if (
      !channel
      || channel.readyState !== 'open'
      || !this.sessionId
      || this.disposed
    ) {
      return false;
    }
    if (channel.bufferedAmount >= POINTER_BACKPRESSURE_BYTES || this.queuedPointer) {
      this.queuedPointer = coalescePointer(this.queuedPointer, command);
      this.schedulePointerFlush();
      return true;
    }
    return this.sendFrame(channel, command);
  }

  selectDisplay(displayId: string): boolean {
    if (
      this.snapshot.capabilities?.multiMonitor !== true
      || !this.snapshot.displays.some((display) => display.id === displayId)
    ) {
      return false;
    }
    this.update({ selectedDisplayId: displayId, appliedView: null });
    return this.sendControl({ type: 'set-display', displayId });
  }

  async sendLocalClipboard(): Promise<void> {
    const generation = this.lifecycleGeneration;
    this.update({ clipboardFeedback: 'none' });
    try {
      const text = await this.dependencies.clipboard.readText();
      if (this.disposed || generation !== this.lifecycleGeneration) return;
      if (!text || !hasBoundedUtf8(text, MAX_DESKTOP_CLIPBOARD_BYTES)) {
        this.update({ clipboardFeedback: 'invalid' });
        return;
      }
      this.update({
        clipboardFeedback: this.sendControl({ type: 'clipboard-write', text })
          ? 'sent'
          : 'input-unavailable',
      });
    } catch {
      if (!this.disposed && generation === this.lifecycleGeneration) {
        this.update({ clipboardFeedback: 'permission' });
      }
    }
  }

  copyRemoteClipboard(): void {
    this.clipboardReadPending = true;
    this.update({ clipboardFeedback: 'none' });
    if (!this.sendControl({ type: 'clipboard-read' })) {
      this.clipboardReadPending = false;
      this.update({ clipboardFeedback: 'input-unavailable' });
    }
  }

  stop(reason: 'client-stop' | 'background' | 'navigation'): void {
    this.lifecycleGeneration += 1;
    this.invalidateNegotiation();
    this.stopClientVideoStats();
    this.resumePending = false;
    this.clipboardReadPending = false;
    this.clipboardOperationGeneration += 1;
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.closePeer();
    if (sessionId) this.transport.stopDesktopControl(sessionId, reason);
    if (!this.disposed && reason === 'background') {
      this.update({ phase: 'reconnecting', detail: null });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    this.stop('navigation');
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.attachVideo(null);
  }

  private readonly handleSignal = (message: DesktopSignalMessage): void => {
    const binding = this.peerBinding;
    if (
      this.disposed
      || message.sessionId !== this.sessionId
      || !binding
      || !validSignal(message.signal)
    ) {
      return;
    }
    const { generation, peer } = binding;
    const { signal } = message;
    if (signal.type === 'answer') {
      if (binding.answerQueued) return;
      binding.answerQueued = true;
      binding.signalChain = binding.signalChain.then(async () => {
        if (!this.isCurrentPeer(peer, generation)) return;
        await peer.setRemoteDescription({
          type: 'answer',
          sdp: signal.sdp,
        });
      }).catch(() => {
        this.failPeer(binding, { kind: 'negotiation-failed' });
      });
      for (const pending of binding.pendingIce.splice(0)) {
        this.enqueueIce(binding, pending);
      }
      return;
    }
    if (signal.type === 'ice') {
      if (!binding.answerQueued) {
        if (binding.pendingIce.length >= MAX_PENDING_DESKTOP_ICE_CANDIDATES) {
          this.failPeer(binding, { kind: 'negotiation-failed' });
          return;
        }
        binding.pendingIce.push(signal);
        return;
      }
      this.enqueueIce(binding, signal);
    }
  };

  private readonly handleStatus = (status: DesktopControlStatusMessage): void => {
    if (this.disposed || status.sessionId !== this.sessionId) return;
    const phase = status.state === 'active'
      ? 'active'
      : status.state === 'reconnecting'
        ? 'reconnecting'
        : status.state === 'error'
          ? 'error'
          : undefined;
    this.update({
      status,
      ...(status.displays ? { displays: safeDisplays(status.displays) } : {}),
      ...(status.selectedDisplayId !== undefined
        ? { selectedDisplayId: status.selectedDisplayId }
        : {}),
      ...(phase ? { phase } : {}),
    });
  };

  private readonly handleEnded = (message: DesktopControlEndedMessage): void => {
    if (this.disposed || message.sessionId !== this.sessionId) return;
    this.lifecycleGeneration += 1;
    this.invalidateNegotiation();
    this.resumePending = false;
    this.sessionId = null;
    this.closePeer();
    this.update({
      phase: 'error',
      detail: { kind: 'ended', reason: message.reason },
    });
  };

  private readonly handleConnectionState = (state: RemoteConnectionState): void => {
    if (
      this.disposed
      || (!this.sessionId && this.activeNegotiation === null && !this.resumePending)
    ) {
      return;
    }
    if (state === 'reconnecting' || state === 'connecting' || state === 'suspended') {
      this.resumePending = true;
      this.invalidateNegotiation();
      this.closePeer();
      this.update({ phase: 'reconnecting' });
      return;
    }
    if (state === 'connected' && this.resumePending && this.activeNegotiation === null) {
      this.resumePending = false;
      void this.beginDesktop();
      return;
    }
    if (
      state === 'auth-rejected'
      || state === 'protocol-incompatible'
      || state === 'disconnected'
    ) {
      this.resumePending = false;
      this.invalidateNegotiation();
      this.closePeer();
      this.update({ phase: 'error' });
    }
  };

  private readonly handleVisibility = (): void => {
    if (!this.disposed && this.dependencies.visibility.isHidden()) {
      this.stop('background');
    }
  };

  private async beginDesktop(): Promise<void> {
    if (this.disposed || this.activeNegotiation !== null) return;
    const generation = ++this.negotiationGeneration;
    this.activeNegotiation = generation;
    let startRequest: Promise<DesktopControlStartResultMessage>;
    try {
      startRequest = this.pendingStart
        ?? this.transport.startDesktopControl(this.viewport ?? undefined, this.qualityPreference);
      this.pendingStart = startRequest;
      const result = await startRequest;
      if (!this.isCurrentNegotiation(generation)) {
        const reusedByCurrentGeneration = this.pendingStart === startRequest
          && this.activeNegotiation !== null;
        if (
          result.ok
          && !reusedByCurrentGeneration
          && result.sessionId !== this.sessionId
        ) {
          this.transport.stopDesktopControl(
            result.sessionId,
            this.dependencies.visibility.isHidden() ? 'background' : 'navigation',
          );
        }
        return;
      }
      if (this.pendingStart === startRequest) this.pendingStart = null;
      if (!result.ok) {
        this.update({
          phase: result.reason === 'busy' ? 'busy' : 'error',
          detail: startFailureDetail(result),
        });
        return;
      }

      const previousSessionId = this.sessionId;
      if (previousSessionId && previousSessionId !== result.sessionId) {
        this.transport.stopDesktopControl(previousSessionId, 'navigation');
      }
      this.sessionId = result.sessionId;
      this.resumePending = false;
      if (previousSessionId !== result.sessionId) this.sequence = 0;
      const displays = safeDisplays(result.displays);
      const selectedDisplayId = result.selectedDisplayId !== null
        && displays.some((display) => display.id === result.selectedDisplayId)
        ? result.selectedDisplayId
        : displays[0]?.id ?? null;
      this.update({
        detail: null,
        displays,
        selectedDisplayId,
        capabilities: safeCapabilities(result.capabilities),
        status: null,
        clipboardFeedback: 'none',
        appliedView: null,
      });

      this.closePeer();
      const peer = this.dependencies.createPeerConnection();
      const peerBinding = this.bindPeer(peer, result.sessionId);
      this.peerBinding = peerBinding;
      peer.addTransceiver('video', { direction: 'recvonly' });
      const offer = await peer.createOffer();
      if (!this.isCurrentPeer(peer, peerBinding.generation)) return;
      await peer.setLocalDescription(offer);
      if (!this.isCurrentPeer(peer, peerBinding.generation)) return;
      const signal: DesktopSessionSignal = { type: 'offer', sdp: offer.sdp ?? '' };
      if (!validSignal(signal) || !this.transport.sendDesktopSignal(result.sessionId, signal)) {
        throw new Error('desktop offer could not be sent');
      }
    } catch {
      if (this.isCurrentNegotiation(generation)) {
        const sessionId = this.sessionId;
        this.sessionId = null;
        this.closePeer();
        if (sessionId) this.transport.stopDesktopControl(sessionId, 'navigation');
        this.update({ phase: 'error', detail: { kind: 'start-failed' } });
      }
    } finally {
      if (this.activeNegotiation === generation) {
        this.activeNegotiation = null;
        if (this.pendingStart === startRequest!) this.pendingStart = null;
      } else if (this.activeNegotiation === null && this.pendingStart === startRequest!) {
        this.pendingStart = null;
      }
    }
  }

  private bindPeer(peer: RTCPeerConnection, sessionId: string): PeerBinding {
    const generation = ++this.peerGeneration;
    const control = peer.createDataChannel('ez-control-v1', { ordered: true });
    const pointer = peer.createDataChannel('ez-pointer-v1', {
      ordered: false,
      maxRetransmits: 0,
    });
    const onControlMessage = (event: MessageEvent<unknown>): void => {
      if (!this.isCurrentPeer(peer, generation)) return;
      const message = decodeDesktopControlFrame(event.data);
      if (!message) {
        if (this.clipboardReadPending) {
          this.clipboardReadPending = false;
          this.update({ clipboardFeedback: 'input-unavailable' });
        }
        return;
      }
      if (message.type === 'input-error') {
        this.clipboardReadPending = false;
        this.update({ clipboardFeedback: 'input-unavailable' });
        return;
      }
      if (message.type === 'view-applied') {
        const currentRevision = this.snapshot.appliedView?.revision ?? 0;
        if (message.revision < currentRevision) return;
        const appliedView: DesktopAppliedView = {
          revision: message.revision,
          sourceRegion: message.sourceRegion,
          frameWidth: message.frameWidth,
          frameHeight: message.frameHeight,
        };
        this.update({
          appliedView,
          status: this.snapshot.status
            ? {
                ...this.snapshot.status,
                appliedViewRevision: message.revision,
                sourceRegion: message.sourceRegion,
                streamWidth: message.frameWidth,
                streamHeight: message.frameHeight,
              }
            : this.snapshot.status,
        });
        return;
      }
      if (!this.clipboardReadPending || message.text === undefined) return;
      this.clipboardReadPending = false;
      const operationGeneration = ++this.clipboardOperationGeneration;
      const lifecycleGeneration = this.lifecycleGeneration;
      void this.dependencies.clipboard.writeText(message.text).then(() => {
        if (
          !this.disposed
          && operationGeneration === this.clipboardOperationGeneration
          && lifecycleGeneration === this.lifecycleGeneration
        ) {
          this.update({ clipboardFeedback: 'copied' });
        }
      }).catch(() => {
        if (
          !this.disposed
          && operationGeneration === this.clipboardOperationGeneration
          && lifecycleGeneration === this.lifecycleGeneration
        ) {
          this.update({ clipboardFeedback: 'permission' });
        }
      });
    };
    const onTrack = (event: RTCTrackEvent): void => {
      if (!this.isCurrentPeer(peer, generation) || !event.streams[0]) return;
      this.remoteStream = event.streams[0];
      this.applyRemoteStream();
    };
    const onIceCandidate = (event: RTCPeerConnectionIceEvent): void => {
      if (!this.isCurrentPeer(peer, generation) || !event.candidate) return;
      const candidate = event.candidate.toJSON();
      if (!candidate.candidate) return;
      const signal: DesktopSessionSignal = {
        type: 'ice',
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        },
      };
      if (validSignal(signal)) this.transport.sendDesktopSignal(sessionId, signal);
    };
    const onConnectionStateChange = (): void => {
      if (!this.isCurrentPeer(peer, generation)) return;
      if (peer.connectionState === 'connected') this.update({ phase: 'active' });
      else if (peer.connectionState === 'disconnected') this.update({ phase: 'reconnecting' });
      else if (peer.connectionState === 'failed') this.failPeer(binding, null);
    };
    control.addEventListener('message', onControlMessage);
    peer.addEventListener('track', onTrack);
    peer.addEventListener('icecandidate', onIceCandidate);
    peer.addEventListener('connectionstatechange', onConnectionStateChange);
    const binding: PeerBinding = {
      generation,
      peer,
      control,
      pointer,
      answerQueued: false,
      pendingIce: [],
      signalChain: Promise.resolve(),
      cleanup: () => {
        control.removeEventListener('message', onControlMessage);
        peer.removeEventListener('track', onTrack);
        peer.removeEventListener('icecandidate', onIceCandidate);
        peer.removeEventListener('connectionstatechange', onConnectionStateChange);
      },
    };
    return binding;
  }

  private enqueueIce(
    binding: PeerBinding,
    signal: Extract<DesktopSessionSignal, { readonly type: 'ice' }>,
  ): void {
    const { generation, peer } = binding;
    binding.signalChain = binding.signalChain.then(async () => {
      if (!this.isCurrentPeer(peer, generation)) return;
      await peer.addIceCandidate(signal.candidate);
    }).catch(() => {
      // A stale or host-rejected candidate does not make the control session
      // authoritative. Terminal peer state still releases the host lease.
    });
  }

  private failPeer(binding: PeerBinding, detail: DesktopPresentationDetail): void {
    if (!this.isCurrentPeer(binding.peer, binding.generation)) return;
    this.lifecycleGeneration += 1;
    this.invalidateNegotiation();
    this.resumePending = false;
    this.clipboardReadPending = false;
    this.clipboardOperationGeneration += 1;
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.closePeer();
    if (sessionId) this.transport.stopDesktopControl(sessionId, 'navigation');
    this.update({ phase: 'error', detail });
  }

  private sendFrame(
    channel: RTCDataChannel | null,
    payload: DesktopControlCommand | DesktopPointerCommand,
  ): boolean {
    if (
      this.disposed
      || !channel
      || channel.readyState !== 'open'
      || !this.sessionId
      || this.sequence >= Number.MAX_SAFE_INTEGER
    ) {
      return false;
    }
    const sequence = this.sequence + 1;
    let encoded: string;
    try {
      encoded = JSON.stringify({ ...payload, sessionId: this.sessionId, sequence });
    } catch {
      return false;
    }
    if (!hasBoundedUtf8(encoded, MAX_DESKTOP_CONTROL_FRAME_BYTES)) return false;
    try {
      channel.send(encoded);
      this.sequence = sequence;
      return true;
    } catch {
      return false;
    }
  }

  private applyRemoteStream(): void {
    if (!this.video || !this.remoteStream) return;
    this.video.srcObject = this.remoteStream;
    void this.video.play().catch(() => undefined);
  }

  private schedulePointerFlush(): void {
    if (this.pointerFlushTimer !== null) return;
    this.pointerFlushTimer = setTimeout(() => {
      this.pointerFlushTimer = null;
      this.flushQueuedPointer();
      if (this.queuedPointer) this.schedulePointerFlush();
    }, POINTER_FLUSH_DELAY_MS);
  }

  private flushQueuedPointer(): void {
    const command = this.queuedPointer;
    const channel = this.peerBinding?.pointer ?? null;
    if (!command) return;
    if (!channel || channel.readyState !== 'open' || !this.sessionId || this.disposed) {
      this.queuedPointer = null;
      return;
    }
    if (channel.bufferedAmount >= POINTER_BACKPRESSURE_BYTES) return;
    this.queuedPointer = null;
    this.sendFrame(channel, command);
  }

  private startClientVideoStats(): void {
    this.previousVideoFrames = null;
    this.startVideoFrameCallbacks();
    this.videoStatsTimer = setInterval(() => {
      const video = this.video;
      if (!video || typeof video.getVideoPlaybackQuality !== 'function') return;
      const quality = video.getVideoPlaybackQuality();
      const current = {
        total: quality.totalVideoFrames,
        dropped: quality.droppedVideoFrames,
      };
      const previous = this.previousVideoFrames;
      this.previousVideoFrames = current;
      if (!previous) return;
      const total = current.total - previous.total;
      const dropped = current.dropped - previous.dropped;
      if (total <= 0 || dropped < 0) return;
      const decodedFramesPerSecond = Math.max(0, total - dropped)
        / (CLIENT_VIDEO_STATS_INTERVAL_MS / 1_000);
      const supportsV2 = this.snapshot.capabilities?.clientVideoStatsV2 === true;
      const ongoingFrameGapMs = this.lastPresentedFrameAt === null
        ? 0
        : performance.now() - this.lastPresentedFrameAt;
      this.sendControl({
        type: 'client-video-stats',
        droppedFramePercent: Math.min(100, Math.max(0, (dropped / total) * 100)),
        ...(supportsV2 ? {
          decodedFramesPerSecond,
          targetFramesPerSecond: this.snapshot.status?.targetFramesPerSecond
            ?? this.snapshot.status?.framesPerSecond
            ?? 30,
          freezeDurationMs: Math.min(10_000, Math.max(
            0,
            Math.round(Math.max(this.largestPresentedFrameGapMs, ongoingFrameGapMs) - 250),
          )),
        } : {}),
      });
      this.largestPresentedFrameGapMs = 0;
    }, CLIENT_VIDEO_STATS_INTERVAL_MS);
  }

  private stopClientVideoStats(): void {
    if (this.videoStatsTimer !== null) clearInterval(this.videoStatsTimer);
    this.videoStatsTimer = null;
    this.previousVideoFrames = null;
    this.stopVideoFrameCallbacks();
  }

  private startVideoFrameCallbacks(): void {
    this.stopVideoFrameCallbacks();
    const video = this.video;
    if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
    const onFrame: VideoFrameRequestCallback = (now) => {
      if (this.video !== video || this.disposed) return;
      if (this.lastPresentedFrameAt !== null) {
        this.largestPresentedFrameGapMs = Math.max(
          this.largestPresentedFrameGapMs,
          now - this.lastPresentedFrameAt,
        );
      }
      this.lastPresentedFrameAt = now;
      this.videoFrameCallbackId = video.requestVideoFrameCallback(onFrame);
    };
    this.lastPresentedFrameAt = null;
    this.largestPresentedFrameGapMs = 0;
    this.videoFrameCallbackId = video.requestVideoFrameCallback(onFrame);
  }

  private stopVideoFrameCallbacks(): void {
    if (
      this.video
      && this.videoFrameCallbackId !== null
      && typeof this.video.cancelVideoFrameCallback === 'function'
    ) {
      this.video.cancelVideoFrameCallback(this.videoFrameCallbackId);
    }
    this.videoFrameCallbackId = null;
    this.lastPresentedFrameAt = null;
    this.largestPresentedFrameGapMs = 0;
  }

  private closePeer(): void {
    const binding = this.peerBinding;
    this.peerBinding = null;
    this.peerGeneration += 1;
    this.remoteStream = null;
    this.queuedPointer = null;
    if (this.pointerFlushTimer !== null) clearTimeout(this.pointerFlushTimer);
    this.pointerFlushTimer = null;
    this.previousVideoFrames = null;
    if (this.video) this.video.srcObject = null;
    if (!binding) return;
    binding.cleanup();
    try {
      binding.control.close();
    } catch {
      // A browser may already have torn the channel down.
    }
    try {
      binding.pointer.close();
    } catch {
      // A browser may already have torn the channel down.
    }
    try {
      binding.peer.close();
    } catch {
      // A browser may already have torn the peer down.
    }
  }

  private invalidateNegotiation(): void {
    this.negotiationGeneration += 1;
    this.activeNegotiation = null;
  }

  private isCurrentNegotiation(generation: number): boolean {
    return !this.disposed
      && this.activeNegotiation === generation
      && this.negotiationGeneration === generation;
  }

  private isCurrentPeer(peer: RTCPeerConnection, generation: number): boolean {
    return !this.disposed
      && this.peerBinding?.peer === peer
      && this.peerBinding.generation === generation;
  }

  private update(patch: Partial<DesktopPresentationSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
