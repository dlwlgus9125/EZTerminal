import {
  classifyCloseRisk,
  planPaneClose,
  sameActiveRunSet,
  type CloseRisk,
} from '../shared/close-risk';
import type {
  PreparedSessionSurfaceCloseItem,
  SessionSurfaceCloseDecision,
  SessionSurfaceCloseEntry,
  SessionSurfaceCommitCloseResult,
  SessionSurfacePrepareCloseResult,
} from '../shared/session-surface';
import { isPassiveDockPanelComponent } from '../shared/dock-panel-capabilities';
import type { PaneHandle, PaneSnapshot } from './pane-registry';

/**
 * React-independent lifecycle transaction types shared by ordinary pane and
 * auxiliary-window close. Presentation and Dockview mutation stay with App;
 * session ownership and destruction stay behind the host surface authority.
 */

export type PaneLifecycleKind = 'single-pane' | 'auxiliary-window';
export type PaneDisposition = 'terminate' | 'keep';

export interface PaneLifecycleTarget {
  readonly panelId: string;
  readonly title: string;
  readonly component: string;
  readonly instanceToken: object;
}

export interface PaneLifecycleItem {
  readonly panelId: string;
  readonly title: string;
  readonly risk: CloseRisk | null;
  readonly creator: boolean;
  readonly passive: boolean;
}

export type PaneLifecycleRequest =
  | {
      readonly kind: 'single-pane';
      readonly target: PaneLifecycleTarget;
      readonly activeAgentSessionIds: ReadonlySet<string>;
      readonly confirmRiskyClose: boolean;
    }
  | {
      readonly kind: 'auxiliary-window';
      readonly targets: readonly PaneLifecycleTarget[];
      readonly activeAgentSessionIds: ReadonlySet<string>;
    };

export type PaneLifecycleFailureReason = 'state-changed' | 'unavailable' | 'busy';
export type PaneLifecycleFailureStage = 'validation' | 'destroy' | 'ownership' | 'busy';

export interface PaneLifecycleFailure {
  readonly ok: false;
  readonly reason: PaneLifecycleFailureReason;
  readonly stage: PaneLifecycleFailureStage;
}

const PREPARED_DATA: unique symbol = Symbol('prepared-pane-lifecycle-data');
const COMMITTED_DATA: unique symbol = Symbol('committed-pane-lifecycle-data');

interface PaneLifecycleCandidate {
  readonly panelId: string;
  readonly title: string;
  readonly component: string;
  readonly instanceToken: object | null;
  readonly snapshot: PaneSnapshot | null;
  readonly risk: CloseRisk | null;
}

interface PreparedPaneLifecycleData {
  readonly kind: PaneLifecycleKind;
  readonly candidates: readonly PaneLifecycleCandidate[];
  readonly mutationKey: string;
}

interface CommittedPaneLifecycleData {
  readonly kind: PaneLifecycleKind;
  readonly candidates: readonly PaneLifecycleCandidate[];
}

export interface PreparedPaneLifecycle {
  readonly kind: PaneLifecycleKind;
  readonly items: readonly PaneLifecycleItem[];
  readonly requiresConfirmation: boolean;
  readonly [PREPARED_DATA]: PreparedPaneLifecycleData;
}

export interface CommittedPaneLifecycle {
  readonly kind: PaneLifecycleKind;
  readonly targets: readonly PaneLifecycleTarget[];
  readonly keptSessionIds: readonly string[];
  readonly [COMMITTED_DATA]: CommittedPaneLifecycleData;
}

export type PaneLifecyclePreparation =
  | { readonly ok: true; readonly plan: PreparedPaneLifecycle }
  | PaneLifecycleFailure;

export type PaneLifecycleCommitResult =
  | { readonly ok: true; readonly commit: CommittedPaneLifecycle }
  | PaneLifecycleFailure;

export type PaneLifecycleValidationResult =
  | { readonly ok: true }
  | PaneLifecycleFailure;

export interface PaneLifecycleCommitOptions {
  /** Must contain exactly one decision for every owner in the plan. */
  readonly dispositions: ReadonlyMap<string, PaneDisposition>;
  readonly resolveCurrentTargets?: () => readonly PaneLifecycleTarget[] | null;
  readonly activeAgentSessionIds?: ReadonlySet<string>;
}

export interface PaneLifecycleValidationOptions {
  readonly resolveCurrentTargets?: () => readonly PaneLifecycleTarget[] | null;
  readonly activeAgentSessionIds?: ReadonlySet<string>;
}

export interface PaneLifecycleCoordinatorOptions {
  readonly getPaneHandle: (panelId: string) => PaneHandle | undefined;
  readonly prepareSessionSurfaceClose: (
    entries: readonly SessionSurfaceCloseEntry[],
  ) => Promise<SessionSurfacePrepareCloseResult>;
  readonly commitSessionSurfaceClose: (
    closeToken: string,
    decisions: readonly SessionSurfaceCloseDecision[],
  ) => Promise<SessionSurfaceCommitCloseResult>;
}

function freezeSnapshot(snapshot: PaneSnapshot): PaneSnapshot {
  return Object.freeze({
    ...snapshot,
    history: Object.freeze([...snapshot.history]),
    activeRunIds: Object.freeze([...snapshot.activeRunIds]),
  });
}

function freezeTarget(target: PaneLifecycleTarget): PaneLifecycleTarget {
  return Object.freeze({ ...target });
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
    hasActiveAgent: snapshot.sessionId !== null && activeAgentSessionIds.has(snapshot.sessionId),
    isDead: snapshot.isDead,
  });
}

function sameSurfaceSnapshot(
  current: PaneSnapshot,
  expected: PaneSnapshot,
  currentRisk: CloseRisk | null,
  expectedRisk: CloseRisk | null,
): boolean {
  return current.panelId === expected.panelId
    && current.sessionId === expected.sessionId
    && current.sessionBindingPending === expected.sessionBindingPending
    && current.sessionSurfaceBindingId === expected.sessionSurfaceBindingId
    && current.sessionSurfaceRole === expected.sessionSurfaceRole
    && current.isBusy === expected.isBusy
    && current.isDead === expected.isDead
    && current.executionKind === expected.executionKind
    && current.hasSshPrompt === expected.hasSshPrompt
    && sameActiveRunSet(current.activeRunIds, expected.activeRunIds)
    && currentRisk === expectedRisk;
}

function validationFailure(stage: PaneLifecycleFailureStage = 'validation'): PaneLifecycleFailure {
  return { ok: false, reason: 'state-changed', stage };
}

function unavailableFailure(stage: PaneLifecycleFailureStage = 'validation'): PaneLifecycleFailure {
  return { ok: false, reason: 'unavailable', stage };
}

function authorityFailure(
  result: Extract<SessionSurfacePrepareCloseResult | SessionSurfaceCommitCloseResult, { ok: false }>,
  stage: PaneLifecycleFailureStage,
): PaneLifecycleFailure {
  if (result.reason === 'busy') return { ok: false, reason: 'busy', stage: 'busy' };
  if (result.reason === 'unavailable') return unavailableFailure(stage);
  return validationFailure(stage);
}

function planTargets(candidates: readonly PaneLifecycleCandidate[]): readonly PaneLifecycleTarget[] {
  return Object.freeze(candidates.flatMap((candidate) => (
    candidate.instanceToken === null
      ? []
      : [Object.freeze({
          panelId: candidate.panelId,
          title: candidate.title,
          component: candidate.component,
          instanceToken: candidate.instanceToken,
        })]
  )));
}

function dispositionsCoverOwners(
  candidates: readonly PaneLifecycleCandidate[],
  dispositions: ReadonlyMap<string, PaneDisposition>,
): boolean {
  const ownerIds = new Set(candidates
    .filter((candidate) => candidate.snapshot?.sessionSurfaceRole === 'owner')
    .map((candidate) => candidate.panelId));
  if (ownerIds.size !== dispositions.size) return false;
  for (const [panelId, disposition] of dispositions) {
    if (!ownerIds.has(panelId)) return false;
    if (disposition !== 'terminate' && disposition !== 'keep') return false;
  }
  return true;
}

function surfaceEntries(candidates: readonly PaneLifecycleCandidate[]): readonly SessionSurfaceCloseEntry[] {
  return Object.freeze(candidates.flatMap((candidate) => {
    const snapshot = candidate.snapshot;
    return snapshot?.sessionSurfaceBindingId
      ? [Object.freeze({
          bindingId: snapshot.sessionSurfaceBindingId,
          expectedActiveRunIds: Object.freeze([...snapshot.activeRunIds]),
        })]
      : [];
  }));
}

function preparedItemsMatch(
  candidates: readonly PaneLifecycleCandidate[],
  items: readonly PreparedSessionSurfaceCloseItem[],
): boolean {
  const expected = new Map(candidates.flatMap((candidate) => {
    const snapshot = candidate.snapshot;
    return snapshot?.sessionSurfaceBindingId && snapshot.sessionId && snapshot.sessionSurfaceRole
      ? [[snapshot.sessionSurfaceBindingId, snapshot] as const]
      : [];
  }));
  if (expected.size !== items.length) return false;
  return items.every((item) => {
    const snapshot = expected.get(item.bindingId);
    return snapshot !== undefined
      && item.sessionId === snapshot.sessionId
      && item.role === snapshot.sessionSurfaceRole;
  });
}

/** Coordinates a single-use, fail-closed surface lifecycle transaction. */
export class PaneLifecycleCoordinator {
  private readonly consumedPlans = new WeakSet<object>();
  private readonly activeMutationKeys = new Set<string>();

  public constructor(private readonly options: PaneLifecycleCoordinatorOptions) {}

  public prepare(request: PaneLifecycleRequest): PaneLifecyclePreparation {
    return request.kind === 'single-pane'
      ? this.prepareSinglePane(request)
      : this.prepareAuxiliaryWindow(request);
  }

  public validatePreparation(
    plan: PreparedPaneLifecycle,
    options: PaneLifecycleValidationOptions = {},
  ): PaneLifecycleValidationResult {
    if (this.consumedPlans.has(plan)) {
      return { ok: false, reason: 'busy', stage: 'busy' };
    }
    return this.validatePreparedData(plan[PREPARED_DATA], options);
  }

  public async commit(
    plan: PreparedPaneLifecycle,
    options: PaneLifecycleCommitOptions,
  ): Promise<PaneLifecycleCommitResult> {
    const data = plan[PREPARED_DATA];
    if (this.consumedPlans.has(plan) || this.activeMutationKeys.has(data.mutationKey)) {
      return { ok: false, reason: 'busy', stage: 'busy' };
    }
    if (!dispositionsCoverOwners(data.candidates, options.dispositions)) {
      return validationFailure();
    }

    this.consumedPlans.add(plan);
    this.activeMutationKeys.add(data.mutationKey);
    try {
      const validation = this.validatePreparedData(data, options);
      if (!validation.ok) return validation;

      const entries = surfaceEntries(data.candidates);
      if (entries.length === 0) return this.createCommit(data, []);

      let preparation: SessionSurfacePrepareCloseResult;
      try {
        preparation = await this.options.prepareSessionSurfaceClose(entries);
      } catch {
        return unavailableFailure('destroy');
      }
      if (!preparation.ok) return authorityFailure(preparation, 'destroy');
      if (!preparedItemsMatch(data.candidates, preparation.prepared.items)) {
        return validationFailure('ownership');
      }

      const finalValidation = this.validatePreparedData(data, options);
      if (!finalValidation.ok) return finalValidation;

      const decisions: SessionSurfaceCloseDecision[] = [];
      for (const candidate of data.candidates) {
        const snapshot = candidate.snapshot;
        if (snapshot?.sessionSurfaceRole !== 'owner' || !snapshot.sessionSurfaceBindingId) continue;
        const disposition = options.dispositions.get(candidate.panelId);
        if (!disposition) return validationFailure('ownership');
        decisions.push({ bindingId: snapshot.sessionSurfaceBindingId, disposition });
      }

      let result: SessionSurfaceCommitCloseResult;
      try {
        result = await this.options.commitSessionSurfaceClose(
          preparation.prepared.closeToken,
          Object.freeze(decisions),
        );
      } catch {
        return unavailableFailure('destroy');
      }
      if (!result.ok) return authorityFailure(result, 'destroy');
      return this.createCommit(data, result.keptSessionIds);
    } finally {
      this.activeMutationKeys.delete(data.mutationKey);
    }
  }

  public validateFinalization(
    commit: CommittedPaneLifecycle,
    options: PaneLifecycleValidationOptions = {},
  ): PaneLifecycleValidationResult {
    const data = commit[COMMITTED_DATA];
    if (data.kind === 'single-pane') return { ok: true };
    return this.validateAuxiliaryTargets(data.candidates, options.resolveCurrentTargets, true)
      ? { ok: true }
      : validationFailure();
  }

  private prepareSinglePane(
    request: Extract<PaneLifecycleRequest, { kind: 'single-pane' }>,
  ): PaneLifecyclePreparation {
    const snapshot = this.options.getPaneHandle(request.target.panelId)?.getSnapshot();
    if (
      !snapshot
      || snapshot.sessionBindingPending
      || !snapshot.sessionId
      || !snapshot.sessionSurfaceBindingId
      || !snapshot.sessionSurfaceRole
    ) {
      return unavailableFailure();
    }
    const frozenSnapshot = freezeSnapshot(snapshot);
    const risk = riskOf(frozenSnapshot, request.activeAgentSessionIds);
    const closePlan = planPaneClose({
      destroysSession: frozenSnapshot.sessionSurfaceRole === 'owner',
      isBusy: frozenSnapshot.isBusy,
      executionKind: frozenSnapshot.executionKind,
      hasSshPrompt: frozenSnapshot.hasSshPrompt,
      hasActiveAgent: request.activeAgentSessionIds.has(frozenSnapshot.sessionId!),
      isDead: frozenSnapshot.isDead,
    }, request.confirmRiskyClose);
    if (closePlan.kind === 'blocked') return unavailableFailure();
    const candidate = Object.freeze({
      ...freezeTarget(request.target),
      snapshot: frozenSnapshot,
      risk,
    });
    return this.createPreparation(
      'single-pane',
      [candidate],
      closePlan.kind === 'confirm',
      `single:${request.target.panelId}`,
    );
  }

  private prepareAuxiliaryWindow(
    request: Extract<PaneLifecycleRequest, { kind: 'auxiliary-window' }>,
  ): PaneLifecyclePreparation {
    if (request.targets.length === 0) return unavailableFailure();
    const candidates: PaneLifecycleCandidate[] = [];
    for (const rawTarget of request.targets) {
      const target = freezeTarget(rawTarget);
      const handle = this.options.getPaneHandle(target.panelId);
      const snapshot = handle?.getSnapshot();
      if (!snapshot && isPassiveDockPanelComponent(target.component) && !handle) {
        candidates.push(Object.freeze({ ...target, snapshot: null, risk: null }));
        continue;
      }
      if (
        !snapshot
        || snapshot.sessionBindingPending
        || !snapshot.sessionId
        || !snapshot.sessionSurfaceBindingId
        || !snapshot.sessionSurfaceRole
      ) {
        return unavailableFailure();
      }
      const frozenSnapshot = freezeSnapshot(snapshot);
      candidates.push(Object.freeze({
        ...target,
        snapshot: frozenSnapshot,
        risk: riskOf(frozenSnapshot, request.activeAgentSessionIds),
      }));
    }
    const requiresConfirmation = candidates.length !== 1 || candidates[0]?.risk !== null;
    const targetKey = candidates.map((candidate) => candidate.panelId).sort().join(',');
    return this.createPreparation(
      'auxiliary-window',
      candidates,
      requiresConfirmation,
      `auxiliary:${targetKey}`,
    );
  }

  private createPreparation(
    kind: PaneLifecycleKind,
    candidates: readonly PaneLifecycleCandidate[],
    requiresConfirmation: boolean,
    mutationKey: string,
  ): PaneLifecyclePreparation {
    const frozenCandidates = Object.freeze([...candidates]);
    const data = Object.freeze({ kind, candidates: frozenCandidates, mutationKey });
    const items = Object.freeze(frozenCandidates.map((candidate) => Object.freeze({
      panelId: candidate.panelId,
      title: candidate.title,
      risk: candidate.risk,
      creator: candidate.snapshot?.sessionSurfaceRole === 'owner',
      passive: candidate.snapshot === null,
    })));
    return {
      ok: true,
      plan: Object.freeze({
        kind,
        items,
        requiresConfirmation,
        [PREPARED_DATA]: data,
      }),
    };
  }

  private validatePreparedData(
    data: PreparedPaneLifecycleData,
    options: PaneLifecycleValidationOptions,
  ): PaneLifecycleValidationResult {
    if (
      data.kind === 'auxiliary-window'
      && !this.validateAuxiliaryTargets(data.candidates, options.resolveCurrentTargets, false)
    ) {
      return validationFailure();
    }
    const activeAgentSessionIds = options.activeAgentSessionIds ?? new Set<string>();
    for (const candidate of data.candidates) {
      const handle = this.options.getPaneHandle(candidate.panelId);
      if (!candidate.snapshot) {
        if (!isPassiveDockPanelComponent(candidate.component) || candidate.risk !== null || handle) {
          return validationFailure();
        }
        continue;
      }
      const snapshot = handle?.getSnapshot();
      if (
        !snapshot
        || !sameSurfaceSnapshot(
          snapshot,
          candidate.snapshot,
          riskOf(snapshot, activeAgentSessionIds),
          candidate.risk,
        )
      ) {
        return validationFailure();
      }
    }
    return { ok: true };
  }

  private validateAuxiliaryTargets(
    candidates: readonly PaneLifecycleCandidate[],
    resolveCurrentTargets: (() => readonly PaneLifecycleTarget[] | null) | undefined,
    requirePassiveHandlesAbsent: boolean,
  ): boolean {
    const currentTargets = resolveCurrentTargets?.();
    if (!currentTargets || currentTargets.length !== candidates.length) return false;
    const byPanel = new Map(currentTargets.map((target) => [target.panelId, target]));
    if (byPanel.size !== currentTargets.length) return false;
    return candidates.every((candidate) => {
      const current = byPanel.get(candidate.panelId);
      if (
        !current
        || current.instanceToken !== candidate.instanceToken
        || current.component !== candidate.component
      ) {
        return false;
      }
      return !requirePassiveHandlesAbsent
        || candidate.snapshot !== null
        || !this.options.getPaneHandle(candidate.panelId);
    });
  }

  private createCommit(
    data: PreparedPaneLifecycleData,
    keptSessionIds: readonly string[],
  ): PaneLifecycleCommitResult {
    const committedData = Object.freeze({ kind: data.kind, candidates: data.candidates });
    return {
      ok: true,
      commit: Object.freeze({
        kind: data.kind,
        targets: planTargets(data.candidates),
        keptSessionIds: Object.freeze([...keptSessionIds]),
        [COMMITTED_DATA]: committedData,
      }),
    };
  }
}
