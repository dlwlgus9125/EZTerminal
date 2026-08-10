import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type {
  DesktopControlCapabilities,
  DesktopControlEndedMessage,
  DesktopControlStartResultMessage,
  DesktopControlStatusMessage,
  DesktopDisplay,
  DesktopNormalizedRegion,
  DesktopQualityPreference,
  DesktopSessionSignal,
  DesktopSignalMessage,
  DesktopVideoViewport,
  RemoteClientIdentity,
} from '../shared/remote-protocol';
import type {
  RemoteDesktopHostStatus,
  RemoteDesktopServiceHealth,
} from '../shared/ipc';
import { NATIVE_DESKTOP_PROTOCOL_VERSION } from './native-desktop-protocol';

const MAX_NATIVE_MESSAGE_BYTES = 272 * 1024;
const NATIVE_READY_TIMEOUT_MS = 12_000;
export const DESKTOP_RESUME_GRACE_MS = 15_000;

export type DesktopServerEvent =
  | DesktopSignalMessage
  | DesktopControlStatusMessage
  | DesktopControlEndedMessage;

type DistributedOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K & keyof T> : never;
export type DesktopStartResult = DistributedOmit<
  DesktopControlStartResultMessage,
  'kind' | 'requestId'
>;

export interface DesktopConnectionEndpoint {
  readonly localAddress: string;
  readonly peerAddress: string;
}

interface NativeTransport {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onExit(listener: () => void): () => void;
  stop(): Promise<void>;
}

interface RemoteDesktopControllerOptions {
  readonly hostPath: string;
  readonly udpPort?: number;
  readonly createTransport?: () => NativeTransport;
  readonly resumeGraceMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly probeService?: () => Promise<RemoteDesktopServiceHealth>;
}

interface ActiveDesktopSession {
  readonly sessionId: string;
  identity: RemoteClientIdentity;
  connectionId: string;
  endpoint: DesktopConnectionEndpoint;
  transport: NativeTransport | null;
  transportStart: Promise<boolean> | null;
  emit: (event: DesktopServerEvent) => void;
  state: DesktopControlStatusMessage['state'];
  displays: readonly DesktopDisplay[];
  selectedDisplayId: string | null;
  disconnectedAt: number | null;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  expectedExit: boolean;
  connectedAt: number;
  framesPerSecond: number | null;
  roundTripTimeMs: number | null;
  bitrateKbps: number | null;
  qualityTier: string | null;
  viewport: DesktopVideoViewport | null;
  qualityPreference: DesktopQualityPreference;
  nativeFeatures: Set<string>;
}

const DEFAULT_CAPABILITIES: DesktopControlCapabilities = {
  ctrlAltDelete: false,
  clipboardText: true,
  directTouch: true,
  multiMonitor: true,
  adaptiveViewport: true,
};

const NATIVE_FEATURE_ADAPTIVE_REGION = 'adaptive-region-v1';
const NATIVE_FEATURE_QUALITY_PREFERENCE = 'quality-preference-v1';
const NATIVE_FEATURE_CLIENT_VIDEO_STATS_V2 = 'client-video-stats-v2';

/**
 * Owns the single desktop-control lease and the unprivileged WebRTC child.
 * The child opens the VPN-bound UDP socket; the LocalSystem service never
 * owns a network listener.
 */
export class RemoteDesktopController {
  private readonly udpPort: number;
  private readonly resumeGraceMs: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<RemoteDesktopControllerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<RemoteDesktopControllerOptions['clearTimer']>;
  private active: ActiveDesktopSession | null = null;
  private service: RemoteDesktopServiceHealth = 'unknown';
  private errorCode: string | null = null;
  private transportTeardown: Promise<void> = Promise.resolve();
  private transportStopsInFlight = 0;
  private readonly authenticatedConnections = new Map<
    string,
    { latestConnectionId: string; readonly liveConnectionIds: Set<string> }
  >();
  private readonly statusListeners = new Set<(status: RemoteDesktopHostStatus) => void>();

  constructor(private readonly options: RemoteDesktopControllerOptions) {
    this.udpPort = options.udpPort ?? 7422;
    this.resumeGraceMs = options.resumeGraceMs ?? DESKTOP_RESUME_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  /** Records authenticated socket order before any desktop-control request.
   * Only the newest still-connected socket for an install may claim/resume its
   * lease; an older socket cannot arrive late and take ownership back. */
  connected(clientId: string, connectionId: string): void {
    const current = this.authenticatedConnections.get(clientId);
    if (current) {
      current.liveConnectionIds.add(connectionId);
      current.latestConnectionId = connectionId;
      return;
    }
    this.authenticatedConnections.set(clientId, {
      latestConnectionId: connectionId,
      liveConnectionIds: new Set([connectionId]),
    });
  }

  async start(
    identity: RemoteClientIdentity,
    connectionId: string,
    endpoint: DesktopConnectionEndpoint,
    emit: (event: DesktopServerEvent) => void,
    viewport?: DesktopVideoViewport,
    qualityPreference: DesktopQualityPreference = 'balanced',
  ): Promise<DesktopStartResult> {
    if (this.options.probeService && this.service !== 'ready') await this.probeService();
    if (this.options.probeService && this.service !== 'ready') {
      return { ok: false, reason: 'unavailable', errorCode: 'SERVICE_UNAVAILABLE' };
    }
    if (!this.isAuthoritativeConnection(identity.clientId, connectionId)) {
      return { ok: false, reason: 'unavailable', errorCode: 'SERVICE_UNAVAILABLE' };
    }
    this.expireDisconnectedLease();
    const current = this.active;
    if (current && current.identity.clientId !== identity.clientId) {
      return {
        ok: false,
        reason: 'busy',
        controllerName: current.identity.clientName.slice(0, 80),
      };
    }

    if (current) {
      current.identity = identity;
      current.connectionId = connectionId;
      current.endpoint = endpoint;
      current.emit = emit;
      if (viewport) current.viewport = viewport;
      current.qualityPreference = qualityPreference;
      const resumed = current.disconnectedAt !== null;
      current.disconnectedAt = null;
      if (current.releaseTimer) this.clearTimer(current.releaseTimer);
      current.releaseTimer = null;
      this.publishStatus();
      if (!current.transport || current.transportStart) {
        const started = await this.ensureTransport(current);
        if (!started) {
          if (this.active === current && current.connectionId === connectionId) {
            this.active = null;
            this.errorCode = 'SERVICE_UNAVAILABLE';
            this.publishStatus();
          }
          return { ok: false, reason: 'unavailable', errorCode: 'SERVICE_UNAVAILABLE' };
        }
      }
      if (this.active !== current || current.connectionId !== connectionId) {
        return { ok: false, reason: 'unavailable', errorCode: 'SERVICE_UNAVAILABLE' };
      }
      if (!this.isAuthoritativeConnection(identity.clientId, connectionId)) {
        await this.discardUnauthorizedStart(current, connectionId);
        return { ok: false, reason: 'unavailable', errorCode: 'SERVICE_UNAVAILABLE' };
      }
      return this.success(current, resumed);
    }

    const session: ActiveDesktopSession = {
      sessionId: randomUUID(),
      identity,
      connectionId,
      endpoint,
      transport: null,
      transportStart: null,
      emit,
      state: 'starting',
      displays: [],
      selectedDisplayId: null,
      disconnectedAt: null,
      releaseTimer: null,
      expectedExit: false,
      connectedAt: this.now(),
      framesPerSecond: null,
      roundTripTimeMs: null,
      bitrateKbps: null,
      qualityTier: null,
      viewport: viewport ?? null,
      qualityPreference,
      nativeFeatures: new Set(),
    };
    this.active = session;
    this.errorCode = null;
    this.publishStatus();
    if (!(await this.ensureTransport(session))) {
      if (this.active === session && session.connectionId === connectionId) {
        this.active = null;
        this.errorCode = 'SERVICE_UNAVAILABLE';
        this.publishStatus();
      }
      return { ok: false, reason: 'unavailable', errorCode: 'SERVICE_UNAVAILABLE' };
    }
    if (this.active !== session || session.connectionId !== connectionId) {
      return { ok: false, reason: 'unavailable', errorCode: 'SERVICE_UNAVAILABLE' };
    }
    if (!this.isAuthoritativeConnection(identity.clientId, connectionId)) {
      await this.discardUnauthorizedStart(session, connectionId);
      return { ok: false, reason: 'unavailable', errorCode: 'SERVICE_UNAVAILABLE' };
    }
    return this.success(session, false);
  }

  signal(
    clientId: string,
    connectionId: string,
    sessionId: string,
    signal: DesktopSessionSignal,
  ): boolean {
    const session = this.active;
    if (
      !session
      || session.identity.clientId !== clientId
      || session.connectionId !== connectionId
      || session.sessionId !== sessionId
    ) return false;
    if (!session.transport) return false;
    if (signal.type === 'offer') {
      session.transport.send({ type: 'offer', sessionId, sdp: signal.sdp });
    } else if (signal.type === 'ice') {
      session.transport.send({ type: 'ice', sessionId, candidate: signal.candidate });
    }
    return true;
  }

  async stop(
    clientId: string,
    connectionId: string,
    sessionId: string,
    reason: DesktopControlEndedMessage['reason'] = 'client-stop',
  ): Promise<boolean> {
    const session = this.active;
    if (
      !session
      || session.identity.clientId !== clientId
      || session.connectionId !== connectionId
      || session.sessionId !== sessionId
    ) return false;
    this.active = null;
    if (session.releaseTimer) this.clearTimer(session.releaseTimer);
    session.releaseTimer = null;
    session.expectedExit = true;
    const transport = session.transport;
    session.transport = null;
    if (transport) {
      transport.send({ type: 'stop', sessionId, reason });
      await this.trackTransportStop(transport);
    }
    session.emit({ kind: 'desktop-control-ended', sessionId, reason });
    this.errorCode = null;
    this.publishStatus();
    return true;
  }

  /** A dropped WS stops video/input immediately but reserves the lease briefly. */
  disconnected(clientId: string, connectionId: string): void {
    const authenticatedConnections = this.authenticatedConnections.get(clientId);
    if (authenticatedConnections) {
      authenticatedConnections.liveConnectionIds.delete(connectionId);
      // Never roll generation authority back to an older half-open socket.
      // Once every socket in this authority epoch is gone, the next
      // authenticated connection establishes a fresh high-water mark.
      if (authenticatedConnections.liveConnectionIds.size === 0) {
        this.authenticatedConnections.delete(clientId);
      }
    }
    const session = this.active;
    if (
      !session
      || session.identity.clientId !== clientId
      || session.connectionId !== connectionId
      || session.disconnectedAt !== null
    ) return;
    session.disconnectedAt = this.now();
    session.state = 'reconnecting';
    session.expectedExit = true;
    const transport = session.transport;
    session.transport = null;
    // A reconnect owns a new child attempt. The old promise remains attached
    // to its old caller and settles when that child exits, but must not be
    // reused by the new socket generation.
    session.transportStart = null;
    if (transport) void this.trackTransportStop(transport).catch(() => undefined);
    this.publishStatus();
    session.releaseTimer = this.setTimer(() => {
      if (this.active === session && session.disconnectedAt !== null) {
        this.active = null;
        this.publishStatus();
      }
    }, this.resumeGraceMs);
  }

  getStatus(): RemoteDesktopHostStatus {
    const session = this.active;
    return {
      state: session
        ? session.state === 'reconnecting' ? 'reconnecting'
          : session.state === 'active' ? 'active'
            : 'starting'
        : this.errorCode ? 'error' : 'idle',
      service: this.service,
      controllerName: session?.identity.clientName ?? null,
      connectedAt: session?.connectedAt ?? null,
      localAddress: session?.endpoint.localAddress ?? null,
      peerAddress: session?.endpoint.peerAddress ?? null,
      framesPerSecond: session?.framesPerSecond ?? null,
      roundTripTimeMs: session?.roundTripTimeMs ?? null,
      bitrateKbps: session?.bitrateKbps ?? null,
      qualityTier: session?.qualityTier ?? null,
      errorCode: this.errorCode,
    };
  }

  isAvailable(): boolean {
    return !this.options.probeService || this.service === 'ready';
  }

  onStatus(listener: (status: RemoteDesktopHostStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async probeService(): Promise<RemoteDesktopHostStatus> {
    if (this.options.probeService) {
      try {
        this.service = await this.options.probeService();
      } catch {
        this.service = 'unknown';
      }
      this.publishStatus();
    }
    return this.getStatus();
  }

  async shutdown(reason: DesktopControlEndedMessage['reason'] = 'app-quit'): Promise<void> {
    const session = this.active;
    if (session) {
      await this.stop(
        session.identity.clientId,
        session.connectionId,
        session.sessionId,
        reason,
      );
    }
    await this.awaitTransportTeardown();
    this.authenticatedConnections.clear();
  }

  private isAuthoritativeConnection(clientId: string, connectionId: string): boolean {
    const authority = this.authenticatedConnections.get(clientId);
    return !authority || authority.latestConnectionId === connectionId;
  }

  private async discardUnauthorizedStart(
    session: ActiveDesktopSession,
    connectionId: string,
  ): Promise<void> {
    if (this.active !== session || session.connectionId !== connectionId) return;
    this.active = null;
    if (session.releaseTimer) this.clearTimer(session.releaseTimer);
    session.releaseTimer = null;
    session.expectedExit = true;
    session.transportStart = null;
    const transport = session.transport;
    session.transport = null;
    if (transport) {
      transport.send({
        type: 'stop',
        sessionId: session.sessionId,
        reason: 'local-disconnect',
      });
      await this.trackTransportStop(transport).catch(() => undefined);
    }
    this.errorCode = null;
    this.publishStatus();
  }

  private ensureTransport(session: ActiveDesktopSession): Promise<boolean> {
    if (session.transportStart) return session.transportStart;
    if (session.transport) return Promise.resolve(true);

    const attempt = this.startTransport(session).catch(() => false);
    const tracked = attempt.finally(() => {
      if (session.transportStart === tracked) session.transportStart = null;
    });
    session.transportStart = tracked;
    return tracked;
  }

  private async startTransport(session: ActiveDesktopSession): Promise<boolean> {
    if (this.transportStopsInFlight > 0) await this.awaitTransportTeardown();
    if (this.active !== session || session.disconnectedAt !== null) return false;

    const transport = this.options.createTransport?.() ?? createNativeTransport(this.options.hostPath);
    session.transport = transport;
    session.expectedExit = false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (ready: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        resolve(ready);
      };
      const readyTimer = setTimeout(() => {
        if (session.transport === transport) {
          session.expectedExit = true;
          session.transport = null;
        }
        void this.trackTransportStop(transport).catch(() => undefined);
        settle(false);
      }, NATIVE_READY_TIMEOUT_MS);

      transport.onMessage((message) => {
        // A same-client resume reuses the session object but replaces its
        // native child. The old child may still flush a final answer/error
        // after stop() resolves; only the child currently owned by the session
        // is allowed to mutate or emit for that session.
        if (
          this.active !== session
          || session.transport !== transport
          || !isRecord(message)
          || typeof message.type !== 'string'
        ) return;
        if (message.type === 'ready') {
          this.service = nativeServiceHealth(message.service);
          session.nativeFeatures = nativeFeatures(message.features);
          this.publishStatus();
          const accepted = message.protocolVersion === NATIVE_DESKTOP_PROTOCOL_VERSION
            && this.service === 'ready';
          if (!accepted) {
            session.expectedExit = true;
            if (session.transport === transport) session.transport = null;
            void this.trackTransportStop(transport).catch(() => undefined);
          }
          settle(accepted);
          return;
        }
        if (!settled && (message.type === 'error' || message.type === 'ended')) {
          session.expectedExit = true;
          if (session.transport === transport) session.transport = null;
          void this.trackTransportStop(transport).catch(() => undefined);
          settle(false);
          return;
        }
        this.handleNativeMessage(session, message);
      });
      transport.onExit(() => {
        const wasCurrentTransport = session.transport === transport;
        if (wasCurrentTransport) session.transport = null;
        if (!settled) {
          if (wasCurrentTransport) session.expectedExit = true;
          settle(false);
          return;
        }
        if (
          !wasCurrentTransport
          || this.active !== session
          || session.expectedExit
          || session.disconnectedAt !== null
        ) return;
        session.state = 'error';
        this.errorCode = 'NATIVE_PROCESS_EXITED';
        session.emit({
          kind: 'desktop-control-ended',
          sessionId: session.sessionId,
          reason: 'transport-failed',
          errorCode: 'NATIVE_PROCESS_EXITED',
        });
        this.active = null;
        this.publishStatus();
      });
      transport.send({
        type: 'hello',
        protocolVersion: NATIVE_DESKTOP_PROTOCOL_VERSION,
        sessionId: session.sessionId,
        clientId: session.identity.clientId,
        clientName: session.identity.clientName.slice(0, 80),
        localAddress: session.endpoint.localAddress,
        peerAddress: session.endpoint.peerAddress,
        udpPort: this.udpPort,
        viewport: session.viewport,
        qualityPreference: session.qualityPreference,
      });
    });
  }

  private handleNativeMessage(session: ActiveDesktopSession, message: Record<string, unknown>): void {
    switch (message.type) {
      case 'answer':
        if (message.sessionId === session.sessionId && typeof message.sdp === 'string') {
          session.emit({
            kind: 'desktop-signal',
            sessionId: session.sessionId,
            signal: { type: 'answer', sdp: message.sdp },
          });
        }
        break;
      case 'ice':
        if (message.sessionId === session.sessionId && isIceCandidate(message.candidate)) {
          session.emit({
            kind: 'desktop-signal',
            sessionId: session.sessionId,
            signal: { type: 'ice', candidate: message.candidate },
          });
        }
        break;
      case 'state': {
        if (message.sessionId !== session.sessionId) break;
        const state = nativeState(message.state);
        if (!state) break;
        session.state = state;
        const metrics = isRecord(message.metrics) ? message.metrics : null;
        const qualityTier = nativeQualityTier(metrics?.qualityTier);
        session.qualityTier = qualityTier;
        session.framesPerSecond = metrics && typeof metrics.framesPerSecond === 'number' ? metrics.framesPerSecond : null;
        session.roundTripTimeMs = metrics && typeof metrics.roundTripTimeMs === 'number' ? metrics.roundTripTimeMs : null;
        session.bitrateKbps = metrics && typeof metrics.bitrateBps === 'number' ? metrics.bitrateBps / 1_000 : null;
        session.emit({
          kind: 'desktop-control-status',
          sessionId: session.sessionId,
          state,
          ...(qualityTier ? { qualityTier } : {}),
          ...(metrics && typeof metrics.framesPerSecond === 'number' ? { framesPerSecond: metrics.framesPerSecond } : {}),
          ...(metrics && typeof metrics.roundTripTimeMs === 'number' ? { roundTripTimeMs: metrics.roundTripTimeMs } : {}),
          ...(metrics && typeof metrics.packetLossPercent === 'number' ? { packetLossPercent: metrics.packetLossPercent } : {}),
          ...(metrics && typeof metrics.bitrateBps === 'number' ? { bitrateKbps: metrics.bitrateBps / 1_000 } : {}),
          ...(metrics && typeof metrics.streamWidth === 'number' ? { streamWidth: metrics.streamWidth } : {}),
          ...(metrics && typeof metrics.streamHeight === 'number' ? { streamHeight: metrics.streamHeight } : {}),
          ...(metrics && isDesktopQualityPreference(metrics.qualityPreference)
            ? { qualityPreference: metrics.qualityPreference }
            : {}),
          ...(metrics && typeof metrics.targetFramesPerSecond === 'number'
            ? { targetFramesPerSecond: metrics.targetFramesPerSecond }
            : {}),
          ...(metrics && typeof metrics.decodedFramesPerSecond === 'number'
            ? { decodedFramesPerSecond: metrics.decodedFramesPerSecond }
            : {}),
          ...(metrics && typeof metrics.clientDroppedFramePercent === 'number'
            ? { clientDroppedFramePercent: metrics.clientDroppedFramePercent }
            : {}),
          ...(metrics && typeof metrics.clientFreezeDurationMs === 'number'
            ? { clientFreezeDurationMs: metrics.clientFreezeDurationMs }
            : {}),
          ...(metrics && isCaptureBackend(metrics.captureBackend)
            ? { captureBackend: metrics.captureBackend }
            : {}),
          ...(metrics && isEncoderBackend(metrics.encoderBackend)
            ? { encoderBackend: metrics.encoderBackend }
            : {}),
          ...(metrics && typeof metrics.appliedViewRevision === 'number'
            ? { appliedViewRevision: metrics.appliedViewRevision }
            : {}),
          ...(metrics && isDesktopNormalizedRegion(metrics.sourceRegion)
            ? { sourceRegion: metrics.sourceRegion }
            : {}),
        });
        this.publishStatus();
        break;
      }
      case 'displays':
        if (message.sessionId === session.sessionId && Array.isArray(message.displays)) {
          session.displays = message.displays.filter(isDesktopDisplay);
          session.selectedDisplayId = typeof message.selectedDisplayId === 'string' ? message.selectedDisplayId : null;
          session.emit({
            kind: 'desktop-control-status',
            sessionId: session.sessionId,
            state: session.state,
            displays: session.displays,
            selectedDisplayId: session.selectedDisplayId,
          });
          this.publishStatus();
        }
        break;
      case 'ended':
        if (message.sessionId === session.sessionId) {
          session.emit({
            kind: 'desktop-control-ended',
            sessionId: session.sessionId,
            reason: isEndReason(message.reason) ? message.reason : 'transport-failed',
          });
          this.endNativeTransport(session);
          this.publishStatus();
        }
        break;
      case 'error':
        session.emit({
          kind: 'desktop-control-ended',
          sessionId: session.sessionId,
          reason: 'transport-failed',
          errorCode: typeof message.code === 'string' ? message.code : 'NATIVE_ERROR',
        });
        this.endNativeTransport(session);
        this.errorCode = typeof message.code === 'string' ? message.code : 'NATIVE_ERROR';
        this.publishStatus();
        break;
    }
  }

  private success(session: ActiveDesktopSession, resumed: boolean): DesktopStartResult {
    return {
      ok: true,
      sessionId: session.sessionId,
      displays: session.displays,
      selectedDisplayId: session.selectedDisplayId,
      endpoint: { address: session.endpoint.localAddress, port: this.udpPort },
      capabilities: capabilitiesFor(session.nativeFeatures),
      resumed,
    };
  }

  private endNativeTransport(session: ActiveDesktopSession): void {
    if (this.active === session) this.active = null;
    if (session.releaseTimer) this.clearTimer(session.releaseTimer);
    session.releaseTimer = null;
    session.expectedExit = true;
    const transport = session.transport;
    session.transport = null;
    if (transport) void this.trackTransportStop(transport).catch(() => undefined);
  }

  /**
   * A broker lease is PID-bound. Do not create a replacement child until all
   * prior child shutdowns have settled, otherwise a fast resume can race the
   * old PID's explicit release and receive a spurious LeaseBusy rejection.
   */
  private trackTransportStop(transport: NativeTransport): Promise<void> {
    let stopping: Promise<void>;
    try {
      stopping = Promise.resolve(transport.stop());
    } catch (error) {
      stopping = Promise.reject(error);
    }
    this.transportStopsInFlight += 1;
    const settled = stopping
      .catch(() => undefined)
      .finally(() => {
        this.transportStopsInFlight = Math.max(0, this.transportStopsInFlight - 1);
      });
    this.transportTeardown = Promise.all([this.transportTeardown, settled]).then(() => undefined);
    return stopping;
  }

  private async awaitTransportTeardown(): Promise<void> {
    for (;;) {
      const pending = this.transportTeardown;
      await pending;
      if (pending === this.transportTeardown) return;
    }
  }

  private expireDisconnectedLease(): void {
    const session = this.active;
    if (
      session
      && session.disconnectedAt !== null
      && this.now() - session.disconnectedAt >= this.resumeGraceMs
    ) {
      if (session.releaseTimer) this.clearTimer(session.releaseTimer);
      this.active = null;
      this.publishStatus();
    }
  }

  private publishStatus(): void {
    const status = this.getStatus();
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        // A destroyed renderer/tray observer is not part of the controller's
        // state transition and must never interrupt connection cleanup.
      }
    }
  }
}

function createNativeTransport(hostPath: string): NativeTransport {
  const child = spawn(hostPath, ['--transport'], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return childTransport(child);
}

function childTransport(child: ChildProcessWithoutNullStreams): NativeTransport {
  const messageListeners = new Set<(message: unknown) => void>();
  const exitListeners = new Set<() => void>();
  let buffer = Buffer.alloc(0);
  let stopped = false;
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_NATIVE_MESSAGE_BYTES * 2) {
      child.kill();
      return;
    }
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (line.length === 0 || line.length > MAX_NATIVE_MESSAGE_BYTES) continue;
      try {
        const message = JSON.parse(line.toString('utf8')) as unknown;
        for (const listener of messageListeners) listener(message);
      } catch {
        // A malformed native frame is ignored; process exit/timeout is the
        // stable public failure channel and no raw payload is logged.
      }
    }
  });
  child.once('exit', () => {
    for (const listener of exitListeners) listener();
  });
  // Drain without logging: stderr could include platform/WebRTC internals.
  child.stderr.resume();
  return {
    send: (message) => {
      const encoded = `${JSON.stringify(message)}\n`;
      if (Buffer.byteLength(encoded) > MAX_NATIVE_MESSAGE_BYTES || child.stdin.destroyed) return;
      child.stdin.write(encoded);
    },
    onMessage: (listener) => {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      child.stdin.end();
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          child.kill();
          resolve();
        }, 1_500);
        force.unref?.();
        child.once('exit', () => {
          clearTimeout(force);
          resolve();
        });
      });
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIceCandidate(value: unknown): value is { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } {
  return isRecord(value) && typeof value.candidate === 'string';
}

function isDesktopDisplay(value: unknown): value is DesktopDisplay {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.width === 'number'
    && typeof value.height === 'number'
    && typeof value.rotationDegrees === 'number'
    && typeof value.primary === 'boolean';
}

function nativeFeatures(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((entry): entry is string => (
    typeof entry === 'string' && entry.length > 0 && entry.length <= 64
  )).slice(0, 32));
}

function capabilitiesFor(features: ReadonlySet<string>): DesktopControlCapabilities {
  if (features.size === 0) return DEFAULT_CAPABILITIES;
  return {
    ...DEFAULT_CAPABILITIES,
    ...(features.has(NATIVE_FEATURE_ADAPTIVE_REGION) ? { adaptiveRegion: true } : {}),
    ...(features.has(NATIVE_FEATURE_QUALITY_PREFERENCE)
      ? { qualityPreferences: ['balanced', 'clarity', 'responsiveness'] as const }
      : {}),
    ...(features.has(NATIVE_FEATURE_CLIENT_VIDEO_STATS_V2) ? { clientVideoStatsV2: true } : {}),
  };
}

function isDesktopQualityPreference(value: unknown): value is DesktopQualityPreference {
  return value === 'balanced' || value === 'clarity' || value === 'responsiveness';
}

function isCaptureBackend(value: unknown): value is NonNullable<DesktopControlStatusMessage['captureBackend']> {
  return value === 'dxgi' || value === 'gdi';
}

function isEncoderBackend(value: unknown): value is NonNullable<DesktopControlStatusMessage['encoderBackend']> {
  return value === 'media-foundation-hardware' || value === 'openh264-software';
}

function isDesktopNormalizedRegion(value: unknown): value is DesktopNormalizedRegion {
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

function nativeState(value: unknown): DesktopControlStatusMessage['state'] | null {
  switch (value) {
    case 'starting': return 'starting';
    case 'connecting': return 'starting';
    case 'active': return 'active';
    case 'reconnecting': return 'reconnecting';
    case 'stopping': return 'stopping';
    default: return null;
  }
}

function nativeQualityTier(value: unknown): NonNullable<DesktopControlStatusMessage['qualityTier']> | null {
  switch (value) {
    case 'high': case 'medium': case 'low': case 'survival': return value;
    default: return null;
  }
}

function nativeServiceHealth(value: unknown): RemoteDesktopServiceHealth {
  switch (value) {
    case 'ready': return 'ready';
    case 'missing': return 'missing';
    case 'stopped': return 'stopped';
    case 'denied': return 'denied';
    default: return 'unknown';
  }
}

function isEndReason(value: unknown): value is DesktopControlEndedMessage['reason'] {
  return typeof value === 'string' && [
    'client-stop', 'local-disconnect', 'bridge-disabled', 'token-rotated', 'app-quit',
    'peer-timeout', 'service-stopped', 'agent-stopped', 'capture-failed',
    'encoder-failed', 'transport-failed',
  ].includes(value);
}
