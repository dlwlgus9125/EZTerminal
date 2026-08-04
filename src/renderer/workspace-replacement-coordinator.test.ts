import { describe, expect, it, vi } from 'vitest';

import type { LayoutEnvelope } from '../shared/layout-schema';
import type { PaneHandle, PaneSnapshot } from './pane-registry';
import {
  WorkspaceReplacementCoordinator,
  type WorkspaceReplacementCoordinatorOptions,
} from './workspace-replacement-coordinator';

const BASE_SNAPSHOT: PaneSnapshot = {
  panelId: 'tab-1',
  sessionId: 'session-1',
  cwd: 'C:\\repo',
  history: [],
  draft: '',
  isBusy: true,
  isDead: false,
  sessionBindingPending: false,
  destroysSessionOnClose: true,
  activeRunIds: ['run-1'],
  executionKind: 'local',
  hasSshPrompt: false,
  activePty: true,
  activeCommand: 'node task.js',
};

function layoutEnvelope(panelIds: readonly string[] = ['tab-9']): LayoutEnvelope {
  return {
    schemaVersion: 1,
    savedAt: '2026-08-04T00:00:00.000Z',
    layout: {
      grid: {
        root: { type: 'branch', data: [] },
        width: 1200,
        height: 800,
        orientation: 'HORIZONTAL',
      },
      panels: Object.fromEntries(
        panelIds.map((id) => [id, {
          id,
          contentComponent: 'terminal' as const,
          renderer: 'always' as const,
        }]),
      ),
    },
  };
}

function handle(snapshot: PaneSnapshot, events: string[]): PaneHandle & {
  getSnapshot: ReturnType<typeof vi.fn<() => PaneSnapshot>>;
  markSessionDestroyHandled: ReturnType<typeof vi.fn<(sessionId: string) => boolean>>;
} {
  return {
    getSnapshot: vi.fn(() => snapshot),
    markSessionDestroyHandled: vi.fn<(sessionId: string) => boolean>((sessionId) => {
      events.push(`mark:${snapshot.panelId}:${sessionId}`);
      return true;
    }),
    releaseSessionOwnership: vi.fn(() => snapshot.sessionId),
    insertText: vi.fn(() => ({ ok: true as const })),
    runText: vi.fn(() => ({ ok: true as const })),
    pasteToPty: vi.fn(() => ({ ok: true as const })),
    focus: vi.fn(() => true),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function harness(initial: readonly PaneSnapshot[] = [BASE_SNAPSHOT]) {
  let snapshots = [...initial];
  const events: string[] = [];
  const handles = new Map<string, ReturnType<typeof handle>>(
    snapshots.map((snapshot) => [snapshot.panelId, handle(snapshot, events)]),
  );
  const preset = layoutEnvelope();
  const release = vi.fn(() => events.push('release'));
  const destroySessionsGuarded =
    vi.fn<WorkspaceReplacementCoordinatorOptions['destroySessionsGuarded']>(async () => {
      events.push('destroy');
      return { ok: true };
    });
  const loadPreset = vi.fn<WorkspaceReplacementCoordinatorOptions['loadPreset']>(async () => {
    events.push('load');
    return preset;
  });
  const preflightLayout = vi.fn<WorkspaceReplacementCoordinatorOptions['preflightLayout']>(() => {
    events.push('preflight');
    return true;
  });
  const replaceLayout = vi.fn<WorkspaceReplacementCoordinatorOptions['replaceLayout']>(
    async (_envelope, authorize) => {
      events.push('replace');
      const authorized = authorize();
      events.push('authorize');
      return authorized
        ? { kind: 'applied' }
        : { kind: 'rejected', reason: 'state-changed' };
    },
  );
  const acquireLease = vi.fn<WorkspaceReplacementCoordinatorOptions['acquireLease']>(() => {
    events.push('acquire');
    return { release };
  });
  const onError = vi.fn();
  const coordinator = new WorkspaceReplacementCoordinator({
    getPaneHandle: (panelId) => handles.get(panelId),
    listPaneSnapshots: () => snapshots.map((snapshot) => (
      handles.get(snapshot.panelId)?.getSnapshot() ?? snapshot
    )),
    destroySessionsGuarded,
    loadPreset,
    preflightLayout,
    replaceLayout,
    acquireLease,
    onError,
  });

  return {
    coordinator,
    destroySessionsGuarded,
    loadPreset,
    preflightLayout,
    replaceLayout,
    acquireLease,
    release,
    handles,
    events,
    preset,
    onError,
    setSnapshots(next: readonly PaneSnapshot[]): void {
      snapshots = [...next];
      for (const snapshot of snapshots) {
        const existing = handles.get(snapshot.panelId);
        if (existing) existing.getSnapshot.mockReturnValue(snapshot);
        else handles.set(snapshot.panelId, handle(snapshot, events));
      }
      for (const panelId of [...handles.keys()]) {
        if (!snapshots.some((snapshot) => snapshot.panelId === panelId)) handles.delete(panelId);
      }
    },
  };
}

describe('WorkspaceReplacementCoordinator', () => {
  it('freezes a creator-only confirmation summary with close-risk counts', () => {
    const passive = {
      ...BASE_SNAPSHOT,
      panelId: 'tab-passive',
      sessionId: 'session-passive',
      destroysSessionOnClose: false,
    };
    const h = harness([BASE_SNAPSHOT, passive]);

    const plan = h.coordinator.prepare(new Set(['session-1']));

    expect(plan.summary).toEqual({
      creatorCount: 1,
      riskCounts: {
        'ssh-prompt': 0,
        'active-agent': 1,
        'ssh-active': 0,
        'running-command': 0,
        unknown: 0,
      },
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.summary.riskCounts)).toBe(true);
  });

  it('owns load, preflight, guarded destroy, final authority, and lease ordering', async () => {
    const h = harness();
    const plan = h.coordinator.prepare(new Set());

    await expect(h.coordinator.applyPreset(plan, 'focus')).resolves.toEqual({ kind: 'applied' });

    expect(h.destroySessionsGuarded).toHaveBeenCalledWith([{
      sessionId: 'session-1',
      expectedActiveRunIds: ['run-1'],
    }]);
    expect(h.handles.get('tab-1')?.markSessionDestroyHandled)
      .toHaveBeenCalledWith('session-1');
    expect(h.events).toEqual([
      'acquire',
      'load',
      'preflight',
      'destroy',
      'mark:tab-1:session-1',
      'replace',
      'authorize',
      'release',
    ]);
  });

  it('does no destructive work for a missing or invalid preset', async () => {
    const missing = harness();
    missing.loadPreset.mockResolvedValue(null);
    await expect(missing.coordinator.applyPreset(
      missing.coordinator.prepare(new Set()),
      'missing',
    )).resolves.toEqual({ kind: 'rejected', reason: 'preset-unavailable' });
    expect(missing.preflightLayout).not.toHaveBeenCalled();
    expect(missing.destroySessionsGuarded).not.toHaveBeenCalled();
    expect(missing.release).toHaveBeenCalledOnce();

    const invalid = harness();
    invalid.preflightLayout.mockReturnValue(false);
    await expect(invalid.coordinator.applyPreset(
      invalid.coordinator.prepare(new Set()),
      'invalid',
    )).resolves.toEqual({ kind: 'rejected', reason: 'layout-invalid' });
    expect(invalid.destroySessionsGuarded).not.toHaveBeenCalled();
    expect(invalid.release).toHaveBeenCalledOnce();
  });

  it('rejects creator or pending-binding changes after confirmation', async () => {
    const changed = harness();
    const changedPlan = changed.coordinator.prepare(new Set());
    changed.setSnapshots([{ ...BASE_SNAPSHOT, activeRunIds: ['run-1', 'run-2'] }]);
    await expect(changed.coordinator.applyPreset(changedPlan, 'focus')).resolves.toEqual({
      kind: 'rejected',
      reason: 'state-changed',
    });
    expect(changed.destroySessionsGuarded).not.toHaveBeenCalled();

    const pending = harness();
    const pendingPlan = pending.coordinator.prepare(new Set());
    pending.setSnapshots([
      BASE_SNAPSHOT,
      {
        ...BASE_SNAPSHOT,
        panelId: 'tab-pending',
        sessionId: null,
        sessionBindingPending: true,
        destroysSessionOnClose: false,
        activeRunIds: [],
      },
    ]);
    await expect(pending.coordinator.applyPreset(pendingPlan, 'focus')).resolves.toEqual({
      kind: 'rejected',
      reason: 'state-changed',
    });
    expect(pending.destroySessionsGuarded).not.toHaveBeenCalled();
  });

  it('reports guarded rejection and transport failure without applying the layout', async () => {
    const rejected = harness();
    rejected.destroySessionsGuarded.mockResolvedValue({ ok: false, reason: 'state-changed' });
    await expect(rejected.coordinator.applyPreset(
      rejected.coordinator.prepare(new Set()),
      'focus',
    )).resolves.toEqual({ kind: 'destroy-failed', reason: 'state-changed' });
    expect(rejected.replaceLayout).not.toHaveBeenCalled();
    expect(rejected.release).toHaveBeenCalledOnce();

    const unavailable = harness();
    unavailable.destroySessionsGuarded.mockRejectedValue(new Error('bridge unavailable'));
    await expect(unavailable.coordinator.applyPreset(
      unavailable.coordinator.prepare(new Set()),
      'focus',
    )).resolves.toEqual({ kind: 'destroy-failed', reason: 'unavailable' });
    expect(unavailable.replaceLayout).not.toHaveBeenCalled();
    expect(unavailable.release).toHaveBeenCalledOnce();
    expect(unavailable.onError).toHaveBeenCalledOnce();
  });

  it('revalidates immediately before layout mutation after sessions were destroyed', async () => {
    const h = harness();
    const plan = h.coordinator.prepare(new Set());
    h.replaceLayout.mockImplementation(async (_envelope, authorize) => {
      h.setSnapshots([
        BASE_SNAPSHOT,
        { ...BASE_SNAPSHOT, panelId: 'tab-2', sessionId: 'session-2' },
      ]);
      return authorize()
        ? { kind: 'applied' }
        : { kind: 'rejected', reason: 'state-changed' };
    });

    await expect(h.coordinator.applyPreset(plan, 'focus')).resolves.toEqual({
      kind: 'rejected',
      reason: 'state-changed',
    });
    expect(h.destroySessionsGuarded).toHaveBeenCalledOnce();
    expect(h.handles.get('tab-1')?.markSessionDestroyHandled).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('surfaces layout apply failure and handles already-dead creators locally', async () => {
    const failed = harness();
    failed.replaceLayout.mockResolvedValue({ kind: 'rejected', reason: 'apply-failed' });
    await expect(failed.coordinator.applyPreset(
      failed.coordinator.prepare(new Set()),
      'focus',
    )).resolves.toEqual({ kind: 'rejected', reason: 'apply-failed' });
    expect(failed.release).toHaveBeenCalledOnce();

    const dead = harness([{ ...BASE_SNAPSHOT, isDead: true }]);
    await expect(dead.coordinator.applyPreset(
      dead.coordinator.prepare(new Set()),
      'focus',
    )).resolves.toEqual({ kind: 'applied' });
    expect(dead.destroySessionsGuarded).not.toHaveBeenCalled();
    expect(dead.handles.get('tab-1')?.markSessionDestroyHandled)
      .toHaveBeenCalledWith('session-1');
  });

  it('serializes concurrent attempts and consumes an acquired plan once', async () => {
    const h = harness();
    const pendingPreset = deferred<LayoutEnvelope | null>();
    h.loadPreset.mockReturnValue(pendingPreset.promise);
    const firstPlan = h.coordinator.prepare(new Set());
    const otherPlan = h.coordinator.prepare(new Set());

    const first = h.coordinator.applyPreset(firstPlan, 'focus');
    await expect(h.coordinator.applyPreset(firstPlan, 'focus')).resolves.toEqual({
      kind: 'rejected',
      reason: 'busy',
    });
    await expect(h.coordinator.applyPreset(otherPlan, 'focus')).resolves.toEqual({
      kind: 'rejected',
      reason: 'busy',
    });

    pendingPreset.resolve(h.preset);
    await expect(first).resolves.toEqual({ kind: 'applied' });
    await expect(h.coordinator.applyPreset(firstPlan, 'focus')).resolves.toEqual({
      kind: 'rejected',
      reason: 'busy',
    });
    expect(h.acquireLease).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it('normalizes thrown preflight and layout dependencies and always releases', async () => {
    const preflight = harness();
    preflight.preflightLayout.mockImplementation(() => {
      throw new Error('bad dockview shape');
    });
    await expect(preflight.coordinator.applyPreset(
      preflight.coordinator.prepare(new Set()),
      'focus',
    )).resolves.toEqual({ kind: 'rejected', reason: 'layout-invalid' });
    expect(preflight.release).toHaveBeenCalledOnce();

    const replacement = harness();
    replacement.replaceLayout.mockRejectedValue(new Error('dockview unavailable'));
    await expect(replacement.coordinator.applyPreset(
      replacement.coordinator.prepare(new Set()),
      'focus',
    )).resolves.toEqual({ kind: 'rejected', reason: 'apply-failed' });
    expect(replacement.release).toHaveBeenCalledOnce();
  });
});
