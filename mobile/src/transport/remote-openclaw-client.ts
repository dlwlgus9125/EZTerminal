import { type ClientToServerMessage, type ServerToClientMessage } from '../../../src/shared/remote-protocol';

import {
  OPENCLAW_CONFIG_ALLOWLIST,
  OPENCLAW_CONFIG_UNSET,
  type OpenClawAgentSession,
  type OpenClawControlSnapshot,
  type OpenClawCoreConfig,
  type OpenClawLifecycleAction,
  type OpenClawLifecycleReceipt,
  type OpenClawLogLine,
  type OpenClawSetConfigResult,
  type OpenClawStatus,
} from '../../../src/shared/openclaw';

import { type OpenClawChatTicket, isOpenClawChatFailureReason } from './ws-transport-contract';

interface OpenClawConnection {
  isAuthenticated(): boolean;
  readonly openClawTicketTimeoutMs: number;
  readonly openClawConfigTimeoutMs: number;
  readonly openClawLifecycleTimeoutMs: number;
  send(message: ClientToServerMessage): boolean;
  newId(): string;
  tryStartTimedMapRequest<K, R>(message: ClientToServerMessage, pending: Map<K, (result: R) => void>, key: K, resolve: (result: R) => void, timeoutMs: number, timeoutResult: R): boolean;
}

/** Owns OpenClaw waiters and subscriptions across authenticated socket generations. */
export class RemoteOpenClawClient {
  constructor(private readonly connection: OpenClawConnection) { }

  // OpenClaw management (M4) — status/logs use the SAME two-method split as
  // stats (`onStatsUpdate`/`setStatsPanelVisible`): a plain listener set, plus
  // a separate desired-state flag that is remembered and REPLAYED on the
  // 'auth-ok' handler below (same reconnect-safety precedent as
  // `statsVisible`/`packetsSubscribed`). Lifecycle/sessions/config/chat-ticket
  // are request/reply, correlated by a locally-minted `requestId` (same FIFO-
  // map precedent as `pendingFileOps` above) — a dropped connection resolves
  // every in-flight entry with a "connection lost" result, never left pending.
  private readonly openclawStatusListeners = new Set<(status: OpenClawStatus) => void>();

  private readonly openclawControlListeners = new Set<(snapshot: OpenClawControlSnapshot) => void>();

  /** REFCOUNT, not a boolean (openclaw-stabilization M3): MobileWorkspace
   * (for the entry-button status dot) and MobileOpenClawView (while it's
   * open) both call `setOpenClawStatusSubscribed` independently on the SAME
   * transport instance — a boolean would let the view's unmount-time
   * `setOpenClawStatusSubscribed(false)` cancel the workspace's own still-
   * wanted subscription. Clamped at 0, same "combine independent
   * acquire/release callers" shape as `StatsVisibility` (src/main/stats-
   * visibility.ts) on the desktop side, just inlined here rather than a
   * separate class (only one subscription to combine, not N remote viewers). */
  private openclawStatusRefcount = 0;

  private readonly openclawLogListeners = new Set<(lines: readonly OpenClawLogLine[]) => void>();

  private openclawLogsSubscribed = false;

  private readonly pendingOpenClawLifecycle = new Map<string, (result: OpenClawLifecycleReceipt) => void>();

  private readonly pendingOpenClawSessions = new Map<string, (sessions: readonly OpenClawAgentSession[]) => void>();

  private readonly pendingOpenClawConfigGet = new Map<string, (config: OpenClawCoreConfig) => void>();

  private readonly pendingOpenClawConfigSet = new Map<string, (result: OpenClawSetConfigResult) => void>();

  private readonly pendingOpenClawChatTicket = new Map<string, (reply: OpenClawChatTicket) => void>();

  // OpenClaw availability (M3) — pushed unconditionally (no subscribe
  // message, unlike status/logs above) right after auth and on every desktop
  // mode change. `openclawAvailable` is `undefined` until the first push
  // arrives (or after a disconnect resets it — see `endConnection`); `onOpen
  // ClawAvailability` folds that to `false` on replay, same "unknown reads as
  // not-visible" contract MobileWorkspace's effective-visibility derivation uses.
  private openclawAvailable: boolean | undefined;

  private readonly openclawAvailabilityListeners = new Set<(visible: boolean) => void>();

  // ── OpenClaw management (openclaw-management M4, mobile-only) ────────────
  // Mirrors the desktop drawer's IPC surface (src/shared/openclaw.ts +
  // openclaw-service.ts's method names) over the wire protocol added in
  // remote-protocol.ts. Not part of `EzTerminalApi` — see the module doc.

  /** Fires on every `openclaw-status` push while subscribed (see
   * `setOpenClawStatusSubscribed`). */
  onOpenClawStatus(listener: (status: OpenClawStatus) => void): () => void {
    this.openclawStatusListeners.add(listener);
    return () => this.openclawStatusListeners.delete(listener);
  }

  /** Desired state, recovery phase, and critical remediation paired with status. */
  onOpenClawControl(listener: (snapshot: OpenClawControlSnapshot) => void): () => void {
    this.openclawControlListeners.add(listener);
    return () => this.openclawControlListeners.delete(listener);
  }

  /** Tell the bridge whether THIS caller wants the OpenClaw status push —
   * REFCOUNTED (see `openclawStatusRefcount`'s doc): only the 0->1 and 1->0
   * transitions actually send a wire message; an already-subscribed second
   * caller (or a not-yet-zero release) is a no-op on the wire, same
   * "transition only" discipline as `StatsVisibility.recompute`. */
  setOpenClawStatusSubscribed(subscribed: boolean): void {
    const wasSubscribed = this.openclawStatusRefcount > 0;
    this.openclawStatusRefcount = Math.max(0, this.openclawStatusRefcount + (subscribed ? 1 : -1));
    const isSubscribed = this.openclawStatusRefcount > 0;
    if (wasSubscribed === isSubscribed) return;
    if (this.connection.isAuthenticated()) this.connection.send({ kind: isSubscribed ? 'openclaw-status-subscribe' : 'openclaw-status-unsubscribe' });
  }

  /** Fires on every `openclaw-log-lines` push (coalesced batch of lines, see
   * remote-protocol.ts) while subscribed. */
  onOpenClawLogLines(listener: (lines: readonly OpenClawLogLine[]) => void): () => void {
    this.openclawLogListeners.add(listener);
    return () => this.openclawLogListeners.delete(listener);
  }

  /** Tell the bridge whether THIS connection wants the OpenClaw log tail —
   * same replay-on-reconnect shape as `setOpenClawStatusSubscribed`. */
  setOpenClawLogsSubscribed(subscribed: boolean): void {
    this.openclawLogsSubscribed = subscribed;
    if (this.connection.isAuthenticated()) this.connection.send({ kind: subscribed ? 'openclaw-logs-subscribe' : 'openclaw-logs-unsubscribe' });
  }

  runOpenClawLifecycle(action: OpenClawLifecycleAction): Promise<OpenClawLifecycleReceipt> {
    return new Promise((resolve) => {
      const requestId = this.connection.newId();
      if (!this.connection.tryStartTimedMapRequest(
        { kind: 'openclaw-lifecycle', requestId, action },
        this.pendingOpenClawLifecycle,
        requestId,
        resolve,
        this.connection.openClawLifecycleTimeoutMs,
        {
          accepted: false,
          issue: {
            code: 'supervisor-failed',
            detail: 'OpenClaw lifecycle request timed out.',
            remediation: 'Reconnect to EZTerminal and retry the action.',
            diagnosticId: `mobile-timeout-${requestId}`,
          },
        },
      )) resolve({
        accepted: false,
        issue: {
          code: 'supervisor-failed',
          detail: 'Not connected to EZTerminal.',
          remediation: 'Reconnect to EZTerminal and retry the action.',
          diagnosticId: `mobile-offline-${requestId}`,
        },
      });
    });
  }

  getOpenClawSessions(): Promise<readonly OpenClawAgentSession[]> {
    return new Promise((resolve) => {
      const requestId = this.connection.newId();
      if (!this.connection.tryStartTimedMapRequest(
        { kind: 'openclaw-sessions-get', requestId },
        this.pendingOpenClawSessions,
        requestId,
        resolve,
        this.connection.openClawConfigTimeoutMs,
        [],
      )) resolve([]);
    });
  }

  getOpenClawConfig(): Promise<OpenClawCoreConfig> {
    return new Promise((resolve) => {
      const requestId = this.connection.newId();
      if (!this.connection.tryStartTimedMapRequest(
        { kind: 'openclaw-config-get', requestId },
        this.pendingOpenClawConfigGet,
        requestId,
        resolve,
        this.connection.openClawConfigTimeoutMs,
        Object.fromEntries(
          OPENCLAW_CONFIG_ALLOWLIST.map((key) => [key, OPENCLAW_CONFIG_UNSET]),
        ) as OpenClawCoreConfig,
      )) {
        resolve(Object.fromEntries(
          OPENCLAW_CONFIG_ALLOWLIST.map((key) => [key, OPENCLAW_CONFIG_UNSET]),
        ) as OpenClawCoreConfig);
      }
    });
  }

  setOpenClawConfig(key: string, value: string): Promise<OpenClawSetConfigResult> {
    return new Promise((resolve) => {
      const requestId = this.connection.newId();
      if (!this.connection.tryStartTimedMapRequest(
        { kind: 'openclaw-config-set', requestId, key, value },
        this.pendingOpenClawConfigSet,
        requestId,
        resolve,
        this.connection.openClawConfigTimeoutMs,
        { ok: false, restartRequired: false, code: 'timeout', error: 'OpenClaw config request timed out' },
      )) {
        resolve({
          ok: false,
          restartRequired: false,
          error: 'Not connected to EZTerminal',
        });
      }
    });
  }

  /** Fires on every `openclaw-availability` push (openclaw-stabilization
   * M3) — the desktop's effective OpenClaw visibility. REPLAYS the current
   * cached value immediately to a new subscriber (same precedent as
   * `onAuthChange` above), folding "haven't heard yet" to `false`. No
   * subscribe/unsubscribe call needed (unlike `onOpenClawStatus`) — the
   * bridge pushes this unconditionally to every authed connection. */
  onOpenClawAvailability(listener: (visible: boolean) => void): () => void {
    this.openclawAvailabilityListeners.add(listener);
    listener(this.openclawAvailable ?? false);
    return () => this.openclawAvailabilityListeners.delete(listener);
  }

  /** Mint a fresh chat ticket for the mobile chat embed (M5) — see
   * openclaw-proxy.ts's module doc for the ticket+cookie auth flow this feeds. */
  getOpenClawChatTicket(): Promise<OpenClawChatTicket> {
    return new Promise((resolve) => {
      const requestId = this.connection.newId();
      if (!this.connection.tryStartTimedMapRequest(
        { kind: 'openclaw-chat-ticket', requestId },
        this.pendingOpenClawChatTicket,
        requestId,
        resolve,
        this.connection.openClawTicketTimeoutMs,
        { ok: false, reason: 'timeout' },
      )) resolve({ ok: false, reason: 'gateway-unreachable' });
    });
  }

  reconnected(): void {
    if (this.openclawStatusRefcount > 0) this.connection.send({ kind: 'openclaw-status-subscribe' });
    if (this.openclawLogsSubscribed) this.connection.send({ kind: 'openclaw-logs-subscribe' });
  }

  disconnected(): void {
    if (this.openclawAvailable !== false) {
      this.openclawAvailable = false;
      for (const listener of this.openclawAvailabilityListeners) listener(false);
    }
  }

  drain(): void {
    for (const resolve of this.pendingOpenClawLifecycle.values()) {
      resolve({
        accepted: false,
        issue: {
          code: 'supervisor-failed',
          detail: 'Connection to EZTerminal lost.',
          remediation: 'Reconnect to observe or retry the OpenClaw action.',
          diagnosticId: `mobile-disconnect-${Date.now().toString(36)}`,
        },
      });
    }
    this.pendingOpenClawLifecycle.clear();
    for (const resolve of this.pendingOpenClawSessions.values()) resolve([]);
    this.pendingOpenClawSessions.clear();
    for (const resolve of this.pendingOpenClawConfigGet.values()) {
      resolve(Object.fromEntries(OPENCLAW_CONFIG_ALLOWLIST.map((key) => [key, OPENCLAW_CONFIG_UNSET])) as OpenClawCoreConfig);
    }
    this.pendingOpenClawConfigGet.clear();
    for (const resolve of this.pendingOpenClawConfigSet.values()) {
      resolve({ ok: false, restartRequired: false, error: 'Connection to EZTerminal lost' });
    }
    this.pendingOpenClawConfigSet.clear();
    for (const resolve of this.pendingOpenClawChatTicket.values()) {
      resolve({ ok: false, reason: 'gateway-unreachable' });
    }
    this.pendingOpenClawChatTicket.clear();
  }

  handleMessage(msg: Extract<ServerToClientMessage, { kind: 'openclaw-status' | 'openclaw-control' | 'openclaw-availability' | 'openclaw-lifecycle-result' | 'openclaw-log-lines' | 'openclaw-sessions-reply' | 'openclaw-config-reply' | 'openclaw-config-set-reply' | 'openclaw-chat-ticket-reply'; }>): void {
    switch (msg.kind) {
      case 'openclaw-status':
        for (const listener of this.openclawStatusListeners) listener(msg.status);
        break;
      case 'openclaw-control':
        for (const listener of this.openclawControlListeners) listener(msg.control);
        break;
      case 'openclaw-availability':
        this.openclawAvailable = msg.visible;
        for (const listener of this.openclawAvailabilityListeners) listener(msg.visible);
        break;
      case 'openclaw-lifecycle-result': {
        const resolve = this.pendingOpenClawLifecycle.get(msg.requestId);
        this.pendingOpenClawLifecycle.delete(msg.requestId);
        resolve?.(msg.result);
        break;
      }
      case 'openclaw-log-lines':
        for (const listener of this.openclawLogListeners) listener(msg.lines);
        break;
      case 'openclaw-sessions-reply': {
        const resolve = this.pendingOpenClawSessions.get(msg.requestId);
        this.pendingOpenClawSessions.delete(msg.requestId);
        resolve?.(msg.sessions);
        break;
      }
      case 'openclaw-config-reply': {
        const resolve = this.pendingOpenClawConfigGet.get(msg.requestId);
        this.pendingOpenClawConfigGet.delete(msg.requestId);
        resolve?.(msg.config);
        break;
      }
      case 'openclaw-config-set-reply': {
        const resolve = this.pendingOpenClawConfigSet.get(msg.requestId);
        this.pendingOpenClawConfigSet.delete(msg.requestId);
        resolve?.(msg.result);
        break;
      }
      case 'openclaw-chat-ticket-reply': {
        const resolve = this.pendingOpenClawChatTicket.get(msg.requestId);
        this.pendingOpenClawChatTicket.delete(msg.requestId);
        const reply = msg as typeof msg & { readonly reason?: unknown; };
        if (msg.ticket && msg.token && msg.proxyPort > 0) {
          resolve?.({ ok: true, ticket: msg.ticket, proxyPort: msg.proxyPort, token: msg.token });
        } else {
          resolve?.({
            ok: false,
            reason: isOpenClawChatFailureReason(reply.reason) ? reply.reason : 'proxy-unavailable',
          });
        }
        break;
      }
    }
  }
}
