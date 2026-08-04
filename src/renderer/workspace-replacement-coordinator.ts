import {
  classifyCloseRisk,
  countCloseRisks,
  sameActiveRunSet,
  type CloseRisk,
} from '../shared/close-risk';
import type { LayoutEnvelope } from '../shared/layout-schema';
import type {
  PreparedSessionSurfaceCloseItem,
  SessionSurfaceCloseDecision,
  SessionSurfaceCloseEntry,
  SessionSurfaceCommitCloseResult,
  SessionSurfacePrepareCloseResult,
} from '../shared/session-surface';
import type { PaneSnapshot } from './pane-registry';
import type { WorkspaceReplacementLease } from './session-mirroring-coordinator';
import type { WorkbenchLayoutReplacementResult } from './workbench-coordinator';

const PREPARED_DATA: unique symbol = Symbol('prepared-workspace-replacement-data');

interface PreparedWorkspaceReplacementData {
  readonly owner: object;
  readonly surfaces: readonly PaneSnapshot[];
  readonly expectedActiveAgentSessionIds: ReadonlySet<string>;
}

export interface PreparedWorkspaceReplacement {
  readonly summary: {
    readonly creatorCount: number;
    readonly riskCounts: Readonly<Record<CloseRisk, number>>;
  };
  readonly [PREPARED_DATA]: PreparedWorkspaceReplacementData;
}

export type WorkspaceReplacementOutcome =
  | { readonly kind: 'applied' }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'busy'
        | 'state-changed'
        | 'preset-unavailable'
        | 'layout-invalid'
        | 'apply-failed';
    }
  | {
      readonly kind: 'destroy-failed';
      readonly reason: 'state-changed' | 'unavailable';
    };

export interface WorkspaceReplacementCoordinatorOptions {
  readonly listPaneSnapshots: () => readonly PaneSnapshot[];
  readonly getActiveAgentSessionIds: () => ReadonlySet<string>;
  readonly prepareSessionSurfaceClose: (
    entries: readonly SessionSurfaceCloseEntry[],
  ) => Promise<SessionSurfacePrepareCloseResult>;
  readonly commitSessionSurfaceClose: (
    closeToken: string,
    decisions: readonly SessionSurfaceCloseDecision[],
  ) => Promise<SessionSurfaceCommitCloseResult>;
  readonly loadPreset: (presetName: string) => Promise<LayoutEnvelope | null>;
  readonly preflightLayout: (envelope: LayoutEnvelope) => boolean;
  readonly replaceLayout: (
    envelope: LayoutEnvelope,
    authorize: () => boolean,
  ) => Promise<WorkbenchLayoutReplacementResult>;
  readonly acquireLease: () => WorkspaceReplacementLease | null;
  readonly onError?: (message: string, error: unknown) => void;
}

function freezeSnapshot(snapshot: PaneSnapshot): PaneSnapshot {
  return Object.freeze({
    ...snapshot,
    history: Object.freeze([...snapshot.history]),
    activeRunIds: Object.freeze([...snapshot.activeRunIds]),
  });
}

function surfaceSnapshots(snapshots: readonly PaneSnapshot[]): readonly PaneSnapshot[] {
  return Object.freeze(snapshots
    .filter((pane) => (
      pane.sessionId !== null
      && pane.sessionSurfaceBindingId !== null
      && pane.sessionSurfaceRole !== null
    ))
    .map(freezeSnapshot));
}

function hasIncompleteBinding(snapshots: readonly PaneSnapshot[]): boolean {
  return snapshots.some((pane) => (
    pane.sessionBindingPending
    || (pane.sessionId !== null && (
      pane.sessionSurfaceBindingId === null
      || pane.sessionSurfaceRole === null
    ))
  ));
}

function riskOf(
  snapshot: PaneSnapshot,
  activeAgentSessionIds: ReadonlySet<string>,
): CloseRisk | null {
  return classifyCloseRisk({
    destroysSession: snapshot.sessionSurfaceRole === 'owner',
    isBusy: snapshot.isBusy,
    executionKind: snapshot.executionKind,
    hasSshPrompt: snapshot.hasSshPrompt,
    hasActiveAgent:
      snapshot.sessionId !== null && activeAgentSessionIds.has(snapshot.sessionId),
    isDead: snapshot.isDead,
  });
}

function sameSurface(
  current: PaneSnapshot,
  expected: PaneSnapshot,
  expectedActiveAgentSessionIds: ReadonlySet<string>,
  currentActiveAgentSessionIds: ReadonlySet<string>,
): boolean {
  return current.panelId === expected.panelId
    && current.sessionId === expected.sessionId
    && current.sessionSurfaceBindingId === expected.sessionSurfaceBindingId
    && current.sessionSurfaceRole === expected.sessionSurfaceRole
    && current.sessionBindingPending === expected.sessionBindingPending
    && current.isBusy === expected.isBusy
    && current.isDead === expected.isDead
    && current.executionKind === expected.executionKind
    && current.hasSshPrompt === expected.hasSshPrompt
    && sameActiveRunSet(current.activeRunIds, expected.activeRunIds)
    && riskOf(current, currentActiveAgentSessionIds)
      === riskOf(expected, expectedActiveAgentSessionIds);
}

function hasExactSurfaceSet(
  expected: readonly PaneSnapshot[],
  current: readonly PaneSnapshot[],
  expectedActiveAgentSessionIds: ReadonlySet<string>,
  currentActiveAgentSessionIds: ReadonlySet<string>,
): boolean {
  if (expected.length !== current.length) return false;
  const expectedByPanel = new Map(expected.map((pane) => [pane.panelId, pane]));
  return current.every((pane) => {
    const prior = expectedByPanel.get(pane.panelId);
    return prior !== undefined && sameSurface(
      pane,
      prior,
      expectedActiveAgentSessionIds,
      currentActiveAgentSessionIds,
    );
  });
}

function hasNoUnexpectedSurfaces(
  expected: readonly PaneSnapshot[],
  current: readonly PaneSnapshot[],
): boolean {
  const expectedByPanel = new Map(expected.map((pane) => [pane.panelId, pane]));
  return current.every((pane) => {
    const prior = expectedByPanel.get(pane.panelId);
    if (
      !prior
      || pane.sessionId !== prior.sessionId
      || pane.sessionSurfaceBindingId !== prior.sessionSurfaceBindingId
      || pane.sessionSurfaceRole !== prior.sessionSurfaceRole
    ) {
      return false;
    }
    const expectedRuns = new Set(prior.activeRunIds);
    return pane.activeRunIds.every((runId) => expectedRuns.has(runId));
  });
}

function closeEntries(surfaces: readonly PaneSnapshot[]): readonly SessionSurfaceCloseEntry[] {
  return Object.freeze(surfaces.map((pane) => Object.freeze({
    bindingId: pane.sessionSurfaceBindingId!,
    expectedActiveRunIds: Object.freeze([...pane.activeRunIds]),
  })));
}

function preparedItemsMatch(
  surfaces: readonly PaneSnapshot[],
  items: readonly PreparedSessionSurfaceCloseItem[],
): boolean {
  const expected = new Map(surfaces.map((pane) => [pane.sessionSurfaceBindingId!, pane]));
  if (expected.size !== items.length) return false;
  return items.every((item) => {
    const pane = expected.get(item.bindingId);
    return pane !== undefined
      && pane.sessionId === item.sessionId
      && pane.sessionSurfaceRole === item.role;
  });
}

/**
 * Owns destructive runtime preset application as one fail-closed transaction.
 * The host authority atomically terminates owner bindings and detaches adopted
 * bindings; Dockview replacement begins only after that acknowledgement.
 */
export class WorkspaceReplacementCoordinator {
  private readonly identity = Object.freeze({});
  private readonly consumedPlans = new WeakSet<object>();
  private active = false;

  public constructor(private readonly options: WorkspaceReplacementCoordinatorOptions) {}

  public prepare(
    activeAgentSessionIds: ReadonlySet<string>,
  ): PreparedWorkspaceReplacement {
    const surfaces = surfaceSnapshots(this.options.listPaneSnapshots());
    const creators = surfaces.filter((pane) => pane.sessionSurfaceRole === 'owner');
    const risks = creators
      .map((snapshot) => riskOf(snapshot, activeAgentSessionIds))
      .filter((risk): risk is CloseRisk => risk !== null);
    const riskCounts = Object.freeze({ ...countCloseRisks(risks) });
    const data = Object.freeze({
      owner: this.identity,
      surfaces,
      expectedActiveAgentSessionIds: new Set(activeAgentSessionIds),
    });
    return Object.freeze({
      summary: Object.freeze({ creatorCount: creators.length, riskCounts }),
      [PREPARED_DATA]: data,
    });
  }

  public async applyPreset(
    plan: PreparedWorkspaceReplacement,
    presetName: string,
  ): Promise<WorkspaceReplacementOutcome> {
    const data = plan[PREPARED_DATA];
    if (data.owner !== this.identity) return { kind: 'rejected', reason: 'state-changed' };
    if (this.active || this.consumedPlans.has(plan)) return { kind: 'rejected', reason: 'busy' };

    this.active = true;
    let lease: WorkspaceReplacementLease | null = null;
    try {
      try {
        lease = this.options.acquireLease();
      } catch (error) {
        this.reportError('workspace replacement lease acquisition failed', error);
        return { kind: 'rejected', reason: 'apply-failed' };
      }
      if (!lease) return { kind: 'rejected', reason: 'busy' };
      this.consumedPlans.add(plan);

      let preset: LayoutEnvelope | null;
      try {
        preset = await this.options.loadPreset(presetName);
      } catch (error) {
        this.reportError('workspace preset load failed', error);
        return { kind: 'rejected', reason: 'preset-unavailable' };
      }
      if (!preset) return { kind: 'rejected', reason: 'preset-unavailable' };

      try {
        if (!this.options.preflightLayout(preset)) {
          return { kind: 'rejected', reason: 'layout-invalid' };
        }
      } catch (error) {
        this.reportError('workspace preset preflight failed', error);
        return { kind: 'rejected', reason: 'layout-invalid' };
      }

      const current = this.readExactSurfaceSet(data);
      if (!current) return { kind: 'rejected', reason: 'state-changed' };
      const closeResult = await this.closeSurfaces(data, current);
      if (closeResult) return closeResult;

      let replacement: WorkbenchLayoutReplacementResult;
      try {
        replacement = await this.options.replaceLayout(
          preset,
          () => this.validateFinalization(data.surfaces),
        );
      } catch (error) {
        this.reportError('workspace layout replacement failed', error);
        return { kind: 'rejected', reason: 'apply-failed' };
      }
      return replacement.kind === 'applied'
        ? replacement
        : { kind: 'rejected', reason: replacement.reason };
    } finally {
      try {
        lease?.release();
      } catch (error) {
        this.reportError('workspace replacement lease release failed', error);
      }
      this.active = false;
    }
  }

  private readExactSurfaceSet(
    data: PreparedWorkspaceReplacementData,
  ): readonly PaneSnapshot[] | null {
    try {
      const snapshots = this.options.listPaneSnapshots();
      const current = surfaceSnapshots(snapshots);
      return !hasIncompleteBinding(snapshots)
        && hasExactSurfaceSet(
          data.surfaces,
          current,
          data.expectedActiveAgentSessionIds,
          this.options.getActiveAgentSessionIds(),
        )
        ? current
        : null;
    } catch (error) {
      this.reportError('workspace surface validation failed', error);
      return null;
    }
  }

  private validateFinalization(expected: readonly PaneSnapshot[]): boolean {
    try {
      const snapshots = this.options.listPaneSnapshots();
      return !hasIncompleteBinding(snapshots)
        && hasNoUnexpectedSurfaces(expected, surfaceSnapshots(snapshots));
    } catch (error) {
      this.reportError('workspace finalization validation failed', error);
      return false;
    }
  }

  private async closeSurfaces(
    data: PreparedWorkspaceReplacementData,
    surfaces: readonly PaneSnapshot[],
  ): Promise<Exclude<WorkspaceReplacementOutcome, { kind: 'applied' }> | null> {
    if (surfaces.length === 0) return null;

    let preparation: SessionSurfacePrepareCloseResult;
    try {
      preparation = await this.options.prepareSessionSurfaceClose(closeEntries(surfaces));
    } catch (error) {
      this.reportError('workspace surface close preparation failed', error);
      return { kind: 'destroy-failed', reason: 'unavailable' };
    }
    if (!preparation.ok) {
      if (preparation.reason === 'busy') return { kind: 'rejected', reason: 'busy' };
      return {
        kind: 'destroy-failed',
        reason: preparation.reason === 'unavailable' ? 'unavailable' : 'state-changed',
      };
    }
    if (!preparedItemsMatch(surfaces, preparation.prepared.items)) {
      return { kind: 'destroy-failed', reason: 'state-changed' };
    }

    const latest = this.readExactSurfaceSet(data);
    if (!latest) return { kind: 'rejected', reason: 'state-changed' };

    const decisions: readonly SessionSurfaceCloseDecision[] = Object.freeze(latest.flatMap((pane) => (
      pane.sessionSurfaceRole === 'owner'
        ? [{ bindingId: pane.sessionSurfaceBindingId!, disposition: 'terminate' as const }]
        : []
    )));
    let result: SessionSurfaceCommitCloseResult;
    try {
      result = await this.options.commitSessionSurfaceClose(
        preparation.prepared.closeToken,
        decisions,
      );
    } catch (error) {
      this.reportError('workspace surface close commit failed', error);
      return { kind: 'destroy-failed', reason: 'unavailable' };
    }
    if (!result.ok) {
      if (result.reason === 'busy') return { kind: 'rejected', reason: 'busy' };
      return {
        kind: 'destroy-failed',
        reason: result.reason === 'unavailable' ? 'unavailable' : 'state-changed',
      };
    }
    return null;
  }

  private reportError(message: string, error: unknown): void {
    if (this.options.onError) {
      this.options.onError(message, error);
      return;
    }
    console.error(`[renderer] ${message}:`, error);
  }
}
