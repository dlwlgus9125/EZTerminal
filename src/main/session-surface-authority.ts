import { randomUUID } from 'node:crypto';

import type {
  DestroySessionGuardResult,
  GuardedSessionDestroyRequest,
  SessionInfo,
} from '../shared/ipc';
import type {
  PreparedSessionSurfaceCloseItem,
  SessionSurfaceCloseDecision,
  SessionSurfaceCloseEntry,
  SessionSurfaceCommitCloseResult,
  SessionSurfaceIntent,
  SessionSurfaceOpenResult,
  SessionSurfacePrepareCloseResult,
  SessionSurfaceReleaseResult,
} from '../shared/session-surface';
import { AsyncMutationGate, type MutationGate } from './async-mutation-gate';

export interface SessionSurfaceBroker {
  createSession(cwd?: string): Promise<SessionInfo>;
  listSessions(): readonly SessionInfo[];
  destroySessionsGuarded(
    sessions: readonly GuardedSessionDestroyRequest[],
  ): Promise<DestroySessionGuardResult>;
  destroySessionGuarded(
    sessionId: string,
    expectedActiveRunIds: readonly string[],
  ): Promise<DestroySessionGuardResult>;
  onSessionRemoved(listener: (sessionId: string) => void): () => void;
}

interface ClientRecord {
  readonly principalId: string;
  readonly continuityKey: string | null;
  readonly surfaces: Map<string, SurfaceReservation>;
  active: boolean;
}

interface SurfaceReservation {
  readonly intentKey: string;
  promise: Promise<SessionSurfaceOpenResult>;
  bindingId: string | null;
}

interface BindingRecord {
  readonly principal: ClientRecord;
  readonly surfaceId: string;
  readonly bindingId: string;
  readonly session: SessionInfo;
  readonly role: 'owner' | 'adopted';
}

interface PreparedCloseRecord {
  readonly principal: ClientRecord;
  readonly entries: readonly {
    readonly bindingId: string;
    readonly expectedActiveRunIds: readonly string[];
  }[];
  readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_PREPARED_CLOSE_TTL_MS = 60_000;
const MAX_PREPARED_CLOSES = 128;

function intentKey(intent: SessionSurfaceIntent): string {
  switch (intent.kind) {
    case 'create':
      return `create:${intent.cwd ?? ''}`;
    case 'adopt':
      return `adopt:${intent.sessionId}`;
    case 'restore':
      return `restore:${intent.sessionId}:${intent.cwd ?? ''}`;
  }
}

function normalizeRunIds(runIds: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(runIds)].sort());
}

/**
 * The sole host-side writer for view/session bindings and creator ownership.
 * The interpreter broker remains authoritative for session existence and run
 * sets; this module adds connection-scoped view leases and atomic close policy.
 */
export class SessionSurfaceAuthority {
  private readonly clients = new Map<string, ClientRecord>();
  private readonly principalsByContinuityKey = new Map<string, string>();
  private readonly bindings = new Map<string, BindingRecord>();
  private readonly ownerBySession = new Map<string, string>();
  private readonly preparedCloses = new Map<string, PreparedCloseRecord>();
  private readonly closeGate: MutationGate;
  private readonly newId: () => string;
  private readonly preparedCloseTtlMs: number;
  private readonly unsubscribeSessionRemoved: () => void;

  public constructor(
    private readonly broker: SessionSurfaceBroker,
    options: {
      readonly newId?: () => string;
      readonly closeGate?: MutationGate;
      readonly preparedCloseTtlMs?: number;
    } = {},
  ) {
    this.newId = options.newId ?? randomUUID;
    this.closeGate = options.closeGate ?? new AsyncMutationGate();
    this.preparedCloseTtlMs = options.preparedCloseTtlMs ?? DEFAULT_PREPARED_CLOSE_TTL_MS;
    this.unsubscribeSessionRemoved = broker.onSessionRemoved((sessionId) => {
      this.removeSessionBindings(sessionId);
    });
  }

  /**
   * Register one transport generation. A newer generation with the same
   * continuity key releases the older generation without transferring owners.
   */
  public connectClient(principalId: string, continuityKey?: string): void {
    const current = this.clients.get(principalId);
    if (current?.active) return;
    const normalizedContinuityKey = continuityKey ?? null;
    if (normalizedContinuityKey) {
      const previous = this.principalsByContinuityKey.get(normalizedContinuityKey);
      if (previous && previous !== principalId) this.disconnectClient(previous);
      this.principalsByContinuityKey.set(normalizedContinuityKey, principalId);
    }
    this.clients.set(principalId, {
      principalId,
      continuityKey: normalizedContinuityKey,
      surfaces: new Map(),
      active: true,
    });
  }

  public disconnectClient(principalId: string): void {
    const client = this.clients.get(principalId);
    if (!client || !client.active) return;
    client.active = false;
    this.clients.delete(principalId);
    if (
      client.continuityKey
      && this.principalsByContinuityKey.get(client.continuityKey) === principalId
    ) {
      this.principalsByContinuityKey.delete(client.continuityKey);
    }
    for (const reservation of client.surfaces.values()) {
      if (reservation.bindingId) this.removeBinding(reservation.bindingId);
    }
    client.surfaces.clear();
    for (const [token, prepared] of this.preparedCloses) {
      if (prepared.principal !== client) continue;
      clearTimeout(prepared.timer);
      this.preparedCloses.delete(token);
    }
  }

  public openSessionSurface(
    principalId: string,
    surfaceId: string,
    intent: SessionSurfaceIntent,
  ): Promise<SessionSurfaceOpenResult> {
    const client = this.clients.get(principalId);
    if (!client?.active) {
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    }
    const key = intentKey(intent);
    const existing = client.surfaces.get(surfaceId);
    if (existing) {
      return existing.intentKey === key
        ? existing.promise
        : Promise.resolve({ ok: false, reason: 'state-changed' });
    }

    const reservation: SurfaceReservation = {
      intentKey: key,
      promise: Promise.resolve({ ok: false, reason: 'unavailable' }),
      bindingId: null,
    };
    client.surfaces.set(surfaceId, reservation);
    reservation.promise = Promise.resolve().then(() => (
      this.resolveOpen(client, surfaceId, intent, reservation)
    ));
    return reservation.promise;
  }

  public prepareSessionSurfaceClose(
    principalId: string,
    entries: readonly SessionSurfaceCloseEntry[],
  ): SessionSurfacePrepareCloseResult {
    const client = this.clients.get(principalId);
    if (!client?.active) return { ok: false, reason: 'unavailable' };
    if (entries.length === 0) return { ok: false, reason: 'state-changed' };
    if (this.preparedCloses.size >= MAX_PREPARED_CLOSES) {
      return { ok: false, reason: 'busy' };
    }
    const unique = new Set(entries.map((entry) => entry.bindingId));
    if (unique.size !== entries.length) return { ok: false, reason: 'state-changed' };

    const items: PreparedSessionSurfaceCloseItem[] = [];
    const frozenEntries: Array<{
      readonly bindingId: string;
      readonly expectedActiveRunIds: readonly string[];
    }> = [];
    for (const entry of entries) {
      const binding = this.bindings.get(entry.bindingId);
      if (!binding) return { ok: false, reason: 'state-changed' };
      if (binding.principal !== client) return { ok: false, reason: 'forbidden' };
      items.push(Object.freeze({
        bindingId: binding.bindingId,
        surfaceId: binding.surfaceId,
        sessionId: binding.session.sessionId,
        role: binding.role,
      }));
      frozenEntries.push(Object.freeze({
        bindingId: binding.bindingId,
        expectedActiveRunIds: normalizeRunIds(entry.expectedActiveRunIds),
      }));
    }

    const closeToken = this.newId();
    const timer = setTimeout(() => {
      this.preparedCloses.delete(closeToken);
    }, this.preparedCloseTtlMs);
    timer.unref?.();
    this.preparedCloses.set(closeToken, {
      principal: client,
      entries: Object.freeze(frozenEntries),
      timer,
    });
    return {
      ok: true,
      prepared: Object.freeze({
        closeToken,
        items: Object.freeze(items),
      }),
    };
  }

  public commitSessionSurfaceClose(
    principalId: string,
    closeToken: string,
    decisions: readonly SessionSurfaceCloseDecision[],
  ): Promise<SessionSurfaceCommitCloseResult> {
    const prepared = this.preparedCloses.get(closeToken);
    if (!prepared) return Promise.resolve({ ok: false, reason: 'state-changed' });
    if (prepared.principal.principalId !== principalId) {
      return Promise.resolve({ ok: false, reason: 'forbidden' });
    }
    clearTimeout(prepared.timer);
    this.preparedCloses.delete(closeToken);
    return this.closeGate.runExclusive(() => this.commitPreparedClose(prepared, decisions));
  }

  public releaseSessionSurface(
    principalId: string,
    bindingId: string,
  ): SessionSurfaceReleaseResult {
    const binding = this.bindings.get(bindingId);
    if (!binding) return { ok: false, reason: 'state-changed' };
    if (binding.principal.principalId !== principalId) {
      return { ok: false, reason: 'forbidden' };
    }
    this.removeBinding(bindingId);
    return { ok: true };
  }

  public terminateSessionGuarded(
    sessionId: string,
    expectedActiveRunIds: readonly string[],
  ): Promise<DestroySessionGuardResult> {
    return this.broker.destroySessionGuarded(sessionId, normalizeRunIds(expectedActiveRunIds));
  }

  public dispose(): void {
    this.unsubscribeSessionRemoved();
    for (const principalId of [...this.clients.keys()]) this.disconnectClient(principalId);
    for (const prepared of this.preparedCloses.values()) clearTimeout(prepared.timer);
    this.preparedCloses.clear();
  }

  private async resolveOpen(
    client: ClientRecord,
    surfaceId: string,
    intent: SessionSurfaceIntent,
    reservation: SurfaceReservation,
  ): Promise<SessionSurfaceOpenResult> {
    try {
      let session: SessionInfo | undefined;
      let role: 'owner' | 'adopted';
      if (intent.kind === 'create') {
        session = await this.broker.createSession(intent.cwd);
        role = 'owner';
      } else {
        session = this.broker.listSessions().find((candidate) => candidate.sessionId === intent.sessionId);
        if (session) {
          role = 'adopted';
        } else if (intent.kind === 'restore') {
          session = await this.broker.createSession(intent.cwd);
          role = 'owner';
        } else {
          this.clearReservation(client, surfaceId, reservation);
          return { ok: false, reason: 'not-found' };
        }
      }

      if (
        !client.active
        || client.surfaces.get(surfaceId) !== reservation
      ) {
        return { ok: false, reason: 'state-changed' };
      }
      if (role === 'owner' && this.ownerBySession.has(session.sessionId)) {
        this.clearReservation(client, surfaceId, reservation);
        return { ok: false, reason: 'state-changed' };
      }
      const bindingId = this.newId();
      const binding: BindingRecord = {
        principal: client,
        surfaceId,
        bindingId,
        session,
        role,
      };
      reservation.bindingId = bindingId;
      this.bindings.set(bindingId, binding);
      if (role === 'owner') this.ownerBySession.set(session.sessionId, bindingId);
      return {
        ok: true,
        binding: Object.freeze({
          surfaceId,
          bindingId,
          session: Object.freeze({ ...session }),
          role,
        }),
      };
    } catch {
      this.clearReservation(client, surfaceId, reservation);
      return { ok: false, reason: 'unavailable' };
    }
  }

  private async commitPreparedClose(
    prepared: PreparedCloseRecord,
    decisions: readonly SessionSurfaceCloseDecision[],
  ): Promise<SessionSurfaceCommitCloseResult> {
    const bindings: BindingRecord[] = [];
    for (const entry of prepared.entries) {
      const binding = this.bindings.get(entry.bindingId);
      if (!binding || binding.principal !== prepared.principal) {
        return { ok: false, reason: 'state-changed' };
      }
      bindings.push(binding);
    }
    const ownerBindings = bindings.filter((binding) => binding.role === 'owner');
    const decisionMap = new Map(decisions.map((decision) => [decision.bindingId, decision.disposition]));
    if (
      decisionMap.size !== decisions.length
      || decisionMap.size !== ownerBindings.length
      || ownerBindings.some((binding) => !decisionMap.has(binding.bindingId))
      || decisions.some((decision) => !ownerBindings.some((binding) => binding.bindingId === decision.bindingId))
    ) {
      return { ok: false, reason: 'state-changed' };
    }

    const expectedByBinding = new Map(
      prepared.entries.map((entry) => [entry.bindingId, entry.expectedActiveRunIds]),
    );
    const terminate = ownerBindings.filter(
      (binding) => decisionMap.get(binding.bindingId) === 'terminate',
    );
    if (terminate.length > 0) {
      let result: DestroySessionGuardResult;
      try {
        result = await this.broker.destroySessionsGuarded(terminate.map((binding) => ({
          sessionId: binding.session.sessionId,
          expectedActiveRunIds: expectedByBinding.get(binding.bindingId) ?? [],
        })));
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      if (!result.ok) return result;
    }

    const keptSessionIds = ownerBindings
      .filter((binding) => decisionMap.get(binding.bindingId) === 'keep')
      .map((binding) => binding.session.sessionId);
    for (const binding of bindings) this.removeBinding(binding.bindingId);
    return { ok: true, keptSessionIds: Object.freeze(keptSessionIds) };
  }

  private clearReservation(
    client: ClientRecord,
    surfaceId: string,
    reservation: SurfaceReservation,
  ): void {
    if (client.surfaces.get(surfaceId) === reservation) client.surfaces.delete(surfaceId);
  }

  private removeBinding(bindingId: string): void {
    const binding = this.bindings.get(bindingId);
    if (!binding) return;
    this.bindings.delete(bindingId);
    if (this.ownerBySession.get(binding.session.sessionId) === bindingId) {
      this.ownerBySession.delete(binding.session.sessionId);
    }
    const reservation = binding.principal.surfaces.get(binding.surfaceId);
    if (reservation?.bindingId === bindingId) {
      binding.principal.surfaces.delete(binding.surfaceId);
    }
  }

  private removeSessionBindings(sessionId: string): void {
    for (const binding of [...this.bindings.values()]) {
      if (binding.session.sessionId === sessionId) this.removeBinding(binding.bindingId);
    }
  }
}
