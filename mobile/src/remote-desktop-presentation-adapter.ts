import type {
  DesktopControlCapabilities,
  DesktopControlEndedMessage,
  DesktopControlStartResultMessage,
  DesktopControlStatusMessage,
  DesktopDisplay,
  DesktopSessionSignal,
  DesktopSignalMessage,
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
  | { readonly type: 'secure-attention' };

export interface DesktopPresentationTransport {
  startDesktopControl(): Promise<DesktopControlStartResultMessage>;
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
  sendControl(command: DesktopControlCommand): boolean;
  sendPointer(command: DesktopPointerCommand): boolean;
  selectDisplay(displayId: string): boolean;
  sendLocalClipboard(): Promise<void>;
  copyRemoteClipboard(): void;
  stop(reason: 'client-stop' | 'background' | 'navigation'): void;
  dispose(): void;
}

interface InboundControlMessage {
  readonly type: 'clipboard-text' | 'input-error';
  readonly text?: string;
}

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
  }
}

function safeCapabilities(value: DesktopControlCapabilities): DesktopControlCapabilities {
  return {
    ctrlAltDelete: value?.ctrlAltDelete === true,
    clipboardText: value?.clipboardText === true,
    directTouch: value?.directTouch === true,
    multiMonitor: value?.multiMonitor === true,
  };
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
  private sessionId: string | null = null;
  private resumePending = false;
  private sequence = 0;
  private clipboardReadPending = false;
  private clipboardOperationGeneration = 0;

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
    this.video = video;
    this.applyRemoteStream();
  }

  sendControl(command: DesktopControlCommand): boolean {
    if (!validControlCommand(command)) return false;
    const capabilities = this.snapshot.capabilities;
    if (
      ((command.type === 'clipboard-read' || command.type === 'clipboard-write')
        && capabilities?.clipboardText !== true)
      || (command.type === 'secure-attention' && capabilities?.ctrlAltDelete !== true)
      || (command.type === 'set-display' && capabilities?.multiMonitor !== true)
      || (
        command.type === 'pointer-button'
        && command.x !== undefined
        && capabilities?.directTouch !== true
      )
    ) {
      return false;
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
    return this.sendFrame(this.peerBinding?.pointer ?? null, command);
  }

  selectDisplay(displayId: string): boolean {
    if (
      this.snapshot.capabilities?.multiMonitor !== true
      || !this.snapshot.displays.some((display) => display.id === displayId)
    ) {
      return false;
    }
    this.update({ selectedDisplayId: displayId });
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
    this.resumePending = false;
    this.clipboardReadPending = false;
    this.clipboardOperationGeneration += 1;
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.closePeer();
    if (sessionId) this.transport.stopDesktopControl(sessionId, reason);
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
    if (state === 'reconnecting' || state === 'connecting') {
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
      startRequest = this.pendingStart ?? this.transport.startDesktopControl();
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

  private closePeer(): void {
    const binding = this.peerBinding;
    this.peerBinding = null;
    this.peerGeneration += 1;
    this.remoteStream = null;
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
