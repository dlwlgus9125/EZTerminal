import { describe, expect, it, vi } from 'vitest';

import type { LayoutEnvelope } from '../shared/layout-schema';
import type { PaneSnapshot } from './pane-registry';
import {
  WorkspaceReplacementCoordinator,
  type WorkspaceReplacementCoordinatorOptions,
} from './workspace-replacement-coordinator';

const OWNER: PaneSnapshot = {
  panelId: 'tab-1',
  sessionId: 'session-1',
  cwd: 'C:\\repo',
  history: [],
  draft: '',
  isBusy: true,
  isDead: false,
  sessionBindingPending: false,
  sessionSurfaceBindingId: 'binding-1',
  sessionSurfaceRole: 'owner',
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
      panels: Object.fromEntries(panelIds.map((id) => [id, {
        id,
        contentComponent: 'terminal' as const,
        renderer: 'always' as const,
      }])),
    },
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

function harness(initial: readonly PaneSnapshot[] = [OWNER]) {
  let snapshots = [...initial];
  let activeAgentSessionIds: ReadonlySet<string> = new Set();
  const events: string[] = [];
  const preset = layoutEnvelope();
  const release = vi.fn(() => events.push('release'));
  const prepareSessionSurfaceClose = vi.fn<
    WorkspaceReplacementCoordinatorOptions['prepareSessionSurfaceClose']
  >(async (entries) => {
    events.push('prepare-close');
    return {
      ok: true,
      prepared: {
        closeToken: 'close-1',
        items: entries.map((entry) => {
          const pane = snapshots.find(
            (candidate) => candidate.sessionSurfaceBindingId === entry.bindingId,
          );
          if (!pane?.sessionId || !pane.sessionSurfaceRole) throw new Error('missing binding');
          return {
            bindingId: entry.bindingId,
            surfaceId: `surface-${pane.panelId}`,
            sessionId: pane.sessionId,
            role: pane.sessionSurfaceRole,
          };
        }),
      },
    };
  });
  const commitSessionSurfaceClose = vi.fn<
    WorkspaceReplacementCoordinatorOptions['commitSessionSurfaceClose']
  >(async () => {
    events.push('commit-close');
    return { ok: true, keptSessionIds: [] };
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
    listPaneSnapshots: () => snapshots,
    getActiveAgentSessionIds: () => activeAgentSessionIds,
    prepareSessionSurfaceClose,
    commitSessionSurfaceClose,
    loadPreset,
    preflightLayout,
    replaceLayout,
    acquireLease,
    onError,
  });

  return {
    coordinator,
    prepareSessionSurfaceClose,
    commitSessionSurfaceClose,
    loadPreset,
    preflightLayout,
    replaceLayout,
    acquireLease,
    release,
    events,
    preset,
    onError,
    setSnapshots(next: readonly PaneSnapshot[]): void {
      snapshots = [...next];
    },
    setActiveAgentSessionIds(next: ReadonlySet<string>): void {
      activeAgentSessionIds = new Set(next);
    },
  };
}

describe('WorkspaceReplacementCoordinator', () => {
  it('summarizes only owner risk while retaining adopted surfaces for detach', () => {
    const adopted: PaneSnapshot = {
      ...OWNER,
      panelId: 'tab-2',
      sessionId: 'session-2',
      sessionSurfaceBindingId: 'binding-2',
      sessionSurfaceRole: 'adopted',
      destroysSessionOnClose: false,
    };
    const h = harness([OWNER, adopted]);

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
  });

  it('loads, preflights, closes all surfaces, then authorizes layout replacement', async () => {
    const adopted: PaneSnapshot = {
      ...OWNER,
      panelId: 'tab-2',
      sessionId: 'session-2',
      sessionSurfaceBindingId: 'binding-2',
      sessionSurfaceRole: 'adopted',
      destroysSessionOnClose: false,
      isBusy: false,
      activeRunIds: [],
    };
    const h = harness([OWNER, adopted]);
    const plan = h.coordinator.prepare(new Set());

    await expect(h.coordinator.applyPreset(plan, 'focus')).resolves.toEqual({ kind: 'applied' });
    expect(h.prepareSessionSurfaceClose).toHaveBeenCalledWith([
      { bindingId: 'binding-1', expectedActiveRunIds: ['run-1'] },
      { bindingId: 'binding-2', expectedActiveRunIds: [] },
    ]);
    expect(h.commitSessionSurfaceClose).toHaveBeenCalledWith('close-1', [{
      bindingId: 'binding-1',
      disposition: 'terminate',
    }]);
    expect(h.events).toEqual([
      'acquire',
      'load',
      'preflight',
      'prepare-close',
      'commit-close',
      'replace',
      'authorize',
      'release',
    ]);
  });

  it('does no lifecycle mutation for a missing or invalid preset', async () => {
    const missing = harness();
    missing.loadPreset.mockResolvedValue(null);
    await expect(missing.coordinator.applyPreset(
      missing.coordinator.prepare(new Set()), 'missing',
    )).resolves.toEqual({ kind: 'rejected', reason: 'preset-unavailable' });
    expect(missing.prepareSessionSurfaceClose).not.toHaveBeenCalled();

    const invalid = harness();
    invalid.preflightLayout.mockReturnValue(false);
    await expect(invalid.coordinator.applyPreset(
      invalid.coordinator.prepare(new Set()), 'invalid',
    )).resolves.toEqual({ kind: 'rejected', reason: 'layout-invalid' });
    expect(invalid.prepareSessionSurfaceClose).not.toHaveBeenCalled();
    expect(invalid.release).toHaveBeenCalledOnce();
  });

  it('rejects changed run sets, roles, and pending bindings after confirmation', async () => {
    for (const next of [
      [{ ...OWNER, activeRunIds: ['run-1', 'run-2'] }],
      [{ ...OWNER, sessionSurfaceRole: 'adopted' as const, destroysSessionOnClose: false }],
      [OWNER, {
        ...OWNER,
        panelId: 'tab-pending',
        sessionId: null,
        sessionBindingPending: true,
        sessionSurfaceBindingId: null,
        sessionSurfaceRole: null,
        destroysSessionOnClose: false,
        activeRunIds: [],
      }],
    ] satisfies readonly (readonly PaneSnapshot[])[]) {
      const h = harness();
      const plan = h.coordinator.prepare(new Set());
      h.setSnapshots(next);
      await expect(h.coordinator.applyPreset(plan, 'focus')).resolves.toEqual({
        kind: 'rejected',
        reason: 'state-changed',
      });
      expect(h.prepareSessionSurfaceClose).not.toHaveBeenCalled();
    }
  });

  it('rejects a newly active agent after confirmation', async () => {
    const h = harness();
    const plan = h.coordinator.prepare(new Set());
    h.setActiveAgentSessionIds(new Set(['session-1']));

    await expect(h.coordinator.applyPreset(plan, 'focus')).resolves.toEqual({
      kind: 'rejected',
      reason: 'state-changed',
    });
    expect(h.prepareSessionSurfaceClose).not.toHaveBeenCalled();
  });

  it('reports host preparation and commit failures without applying the layout', async () => {
    const rejected = harness();
    rejected.commitSessionSurfaceClose.mockResolvedValue({ ok: false, reason: 'state-changed' });
    await expect(rejected.coordinator.applyPreset(
      rejected.coordinator.prepare(new Set()), 'focus',
    )).resolves.toEqual({ kind: 'destroy-failed', reason: 'state-changed' });
    expect(rejected.replaceLayout).not.toHaveBeenCalled();

    const unavailable = harness();
    unavailable.prepareSessionSurfaceClose.mockRejectedValue(new Error('bridge unavailable'));
    await expect(unavailable.coordinator.applyPreset(
      unavailable.coordinator.prepare(new Set()), 'focus',
    )).resolves.toEqual({ kind: 'destroy-failed', reason: 'unavailable' });
    expect(unavailable.onError).toHaveBeenCalledOnce();
    expect(unavailable.release).toHaveBeenCalledOnce();
  });

  it('revalidates immediately before layout mutation after host acknowledgement', async () => {
    const h = harness();
    const plan = h.coordinator.prepare(new Set());
    h.replaceLayout.mockImplementation(async (_envelope, authorize) => {
      h.setSnapshots([
        OWNER,
        {
          ...OWNER,
          panelId: 'tab-2',
          sessionId: 'session-2',
          sessionSurfaceBindingId: 'binding-2',
        },
      ]);
      return authorize()
        ? { kind: 'applied' }
        : { kind: 'rejected', reason: 'state-changed' };
    });

    await expect(h.coordinator.applyPreset(plan, 'focus')).resolves.toEqual({
      kind: 'rejected',
      reason: 'state-changed',
    });
    expect(h.commitSessionSurfaceClose).toHaveBeenCalledOnce();
  });

  it('serializes concurrent attempts and consumes a plan once', async () => {
    const h = harness();
    const pendingPreset = deferred<LayoutEnvelope | null>();
    h.loadPreset.mockReturnValue(pendingPreset.promise);
    const firstPlan = h.coordinator.prepare(new Set());
    const otherPlan = h.coordinator.prepare(new Set());

    const first = h.coordinator.applyPreset(firstPlan, 'focus');
    await expect(h.coordinator.applyPreset(firstPlan, 'focus')).resolves.toEqual({
      kind: 'rejected', reason: 'busy',
    });
    await expect(h.coordinator.applyPreset(otherPlan, 'focus')).resolves.toEqual({
      kind: 'rejected', reason: 'busy',
    });
    pendingPreset.resolve(h.preset);
    await expect(first).resolves.toEqual({ kind: 'applied' });
    await expect(h.coordinator.applyPreset(firstPlan, 'focus')).resolves.toEqual({
      kind: 'rejected', reason: 'busy',
    });
  });

  it('normalizes thrown preflight and layout dependencies and always releases', async () => {
    const preflight = harness();
    preflight.preflightLayout.mockImplementation(() => {
      throw new Error('bad dockview shape');
    });
    await expect(preflight.coordinator.applyPreset(
      preflight.coordinator.prepare(new Set()), 'focus',
    )).resolves.toEqual({ kind: 'rejected', reason: 'layout-invalid' });
    expect(preflight.release).toHaveBeenCalledOnce();

    const replacement = harness();
    replacement.replaceLayout.mockRejectedValue(new Error('dockview unavailable'));
    await expect(replacement.coordinator.applyPreset(
      replacement.coordinator.prepare(new Set()), 'focus',
    )).resolves.toEqual({ kind: 'rejected', reason: 'apply-failed' });
    expect(replacement.release).toHaveBeenCalledOnce();
  });
});
