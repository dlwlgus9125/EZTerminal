import { describe, expect, it, vi } from 'vitest';

import type { DestroySessionGuardResult } from '../shared/ipc';
import {
  PaneLifecycleCoordinator,
  type PaneDisposition,
  type PaneLifecycleCoordinatorOptions,
  type PaneLifecycleTarget,
  type PreparedPaneLifecycle,
} from './pane-lifecycle-coordinator';
import type { PaneHandle, PaneSnapshot } from './pane-registry';

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

function target(
  panelId: string,
  component = 'terminal',
  instanceToken: object = {},
): PaneLifecycleTarget {
  return {
    panelId,
    title: panelId,
    component,
    instanceToken,
  };
}

function handle(snapshot: PaneSnapshot): PaneHandle & {
  getSnapshot: ReturnType<typeof vi.fn<() => PaneSnapshot>>;
  markSessionDestroyHandled: ReturnType<typeof vi.fn<(sessionId: string) => boolean>>;
  releaseSessionOwnership: ReturnType<typeof vi.fn<() => string | null>>;
} {
  return {
    getSnapshot: vi.fn(() => snapshot),
    markSessionDestroyHandled: vi.fn<(sessionId: string) => boolean>(() => true),
    releaseSessionOwnership: vi.fn(() => snapshot.sessionId),
    insertText: vi.fn(() => ({ ok: true as const })),
    runText: vi.fn(() => ({ ok: true as const })),
    pasteToPty: vi.fn(() => ({ ok: true as const })),
    focus: vi.fn(() => true),
  };
}

function harness(initial: readonly PaneSnapshot[]) {
  let snapshots = [...initial];
  const handles = new Map<string, ReturnType<typeof handle>>(
    snapshots.map((snapshot) => [snapshot.panelId, handle(snapshot)]),
  );
  const destroySessionGuarded = vi.fn<PaneLifecycleCoordinatorOptions['destroySessionGuarded']>(
    async () => ({ ok: true }),
  );
  const destroySessionsGuarded = vi.fn<PaneLifecycleCoordinatorOptions['destroySessionsGuarded']>(
    async () => ({ ok: true }),
  );
  const coordinator = new PaneLifecycleCoordinator({
    getPaneHandle: (panelId) => handles.get(panelId),
    destroySessionGuarded,
    destroySessionsGuarded,
  });
  return {
    coordinator,
    destroySessionGuarded,
    destroySessionsGuarded,
    handles,
    setSnapshots(next: readonly PaneSnapshot[]): void {
      snapshots = [...next];
      for (const snapshot of snapshots) {
        const existing = handles.get(snapshot.panelId);
        if (existing) existing.getSnapshot.mockReturnValue(snapshot);
        else handles.set(snapshot.panelId, handle(snapshot));
      }
      for (const panelId of [...handles.keys()]) {
        if (!snapshots.some((snapshot) => snapshot.panelId === panelId)) handles.delete(panelId);
      }
    },
  };
}

function prepared(result: ReturnType<PaneLifecycleCoordinator['prepare']>): PreparedPaneLifecycle {
  if (!result.ok) throw new Error(`expected preparation, got ${result.reason}`);
  return result.plan;
}

function dispositions(entries: readonly (readonly [string, PaneDisposition])[]) {
  return new Map<string, PaneDisposition>(entries);
}

describe('PaneLifecycleCoordinator single-pane lifecycle', () => {
  it('does not finalize a destructive close until the guarded ACK is owned', async () => {
    const h = harness([BASE_SNAPSHOT]);
    let resolveDestroy!: (result: DestroySessionGuardResult) => void;
    h.destroySessionGuarded.mockImplementation(() => new Promise((resolve) => {
      resolveDestroy = resolve;
    }));
    const plan = prepared(h.coordinator.prepare({
      kind: 'single-pane',
      target: target('tab-1'),
      activeAgentSessionIds: new Set(),
      confirmRiskyClose: true,
    }));
    expect(plan.requiresConfirmation).toBe(true);

    const result = h.coordinator.commit(plan, {
      dispositions: dispositions([['tab-1', 'terminate']]),
    });
    expect(h.destroySessionGuarded).toHaveBeenCalledWith('session-1', ['run-1']);
    expect(h.handles.get('tab-1')?.markSessionDestroyHandled).not.toHaveBeenCalled();

    resolveDestroy({ ok: true });
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(h.handles.get('tab-1')?.markSessionDestroyHandled).toHaveBeenCalledWith('session-1');
  });

  it('transfers ownership for keep-running without contacting the backend', async () => {
    const h = harness([BASE_SNAPSHOT]);
    const plan = prepared(h.coordinator.prepare({
      kind: 'single-pane',
      target: target('tab-1'),
      activeAgentSessionIds: new Set(),
      confirmRiskyClose: true,
    }));

    const result = await h.coordinator.commit(plan, {
      dispositions: dispositions([['tab-1', 'keep']]),
    });

    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.commit.keptSessionIds).toEqual(['session-1']);
    expect(h.destroySessionGuarded).not.toHaveBeenCalled();
    expect(h.handles.get('tab-1')?.releaseSessionOwnership).toHaveBeenCalledOnce();
  });

  it('handles a still-dead creator locally without contacting the backend', async () => {
    const dead = { ...BASE_SNAPSHOT, isDead: true };
    const h = harness([dead]);
    const plan = prepared(h.coordinator.prepare({
      kind: 'single-pane',
      target: target('tab-1'),
      activeAgentSessionIds: new Set(),
      confirmRiskyClose: true,
    }));

    const result = await h.coordinator.commit(plan, {
      dispositions: dispositions([['tab-1', 'terminate']]),
    });

    expect(result).toMatchObject({ ok: true });
    expect(h.destroySessionGuarded).not.toHaveBeenCalled();
    expect(h.handles.get('tab-1')?.markSessionDestroyHandled).toHaveBeenCalledWith('session-1');
  });

  it('fails closed when a confirmed pane changes before commit', async () => {
    const h = harness([BASE_SNAPSHOT]);
    const plan = prepared(h.coordinator.prepare({
      kind: 'single-pane',
      target: target('tab-1'),
      activeAgentSessionIds: new Set(),
      confirmRiskyClose: true,
    }));
    h.setSnapshots([{ ...BASE_SNAPSHOT, activeRunIds: ['run-2'] }]);

    await expect(h.coordinator.commit(plan, {
      dispositions: dispositions([['tab-1', 'terminate']]),
    })).resolves.toEqual({ ok: false, reason: 'state-changed', stage: 'validation' });
    expect(h.destroySessionGuarded).not.toHaveBeenCalled();
  });

  it('fails closed when pane ownership changes after a guarded ACK', async () => {
    const h = harness([BASE_SNAPSHOT]);
    let resolveDestroy!: (result: DestroySessionGuardResult) => void;
    h.destroySessionGuarded.mockImplementation(() => new Promise((resolve) => {
      resolveDestroy = resolve;
    }));
    const plan = prepared(h.coordinator.prepare({
      kind: 'single-pane',
      target: target('tab-1'),
      activeAgentSessionIds: new Set(),
      confirmRiskyClose: false,
    }));

    const result = h.coordinator.commit(plan, {
      dispositions: dispositions([['tab-1', 'terminate']]),
    });
    h.setSnapshots([{ ...BASE_SNAPSHOT, sessionId: 'replacement-session' }]);
    resolveDestroy({ ok: true });

    await expect(result).resolves.toEqual({
      ok: false,
      reason: 'state-changed',
      stage: 'validation',
    });
    expect(h.handles.get('tab-1')?.markSessionDestroyHandled).not.toHaveBeenCalled();
  });
});

describe('PaneLifecycleCoordinator auxiliary lifecycle', () => {
  it('atomically terminates and keeps a mixed panel set', async () => {
    const second = {
      ...BASE_SNAPSHOT,
      panelId: 'tab-2',
      sessionId: 'session-2',
      activeRunIds: ['run-2'],
    };
    const h = harness([BASE_SNAPSHOT, second]);
    const firstTarget = target('tab-1');
    const secondTarget = target('tab-2');
    const currentTargets = [firstTarget, secondTarget];
    const plan = prepared(h.coordinator.prepare({
      kind: 'auxiliary-window',
      targets: currentTargets,
      activeAgentSessionIds: new Set(),
    }));

    const result = await h.coordinator.commit(plan, {
      dispositions: dispositions([
        ['tab-1', 'terminate'],
        ['tab-2', 'keep'],
      ]),
      resolveCurrentTargets: () => currentTargets,
      activeAgentSessionIds: new Set(),
    });

    expect(h.destroySessionsGuarded).toHaveBeenCalledWith([{
      sessionId: 'session-1',
      expectedActiveRunIds: ['run-1'],
    }]);
    expect(h.handles.get('tab-1')?.markSessionDestroyHandled).toHaveBeenCalledWith('session-1');
    expect(h.handles.get('tab-2')?.releaseSessionOwnership).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.commit.keptSessionIds).toEqual(['session-2']);
      expect(h.coordinator.validateFinalization(result.commit, {
        resolveCurrentTargets: () => currentTargets,
      })).toEqual({ ok: true });
    }
  });

  it('accepts a passive Agent Session but rejects changed window membership', async () => {
    const h = harness([BASE_SNAPSHOT]);
    const terminal = target('tab-1');
    const agent = target('agent-session-1', 'agent-session');
    const plan = prepared(h.coordinator.prepare({
      kind: 'auxiliary-window',
      targets: [terminal, agent],
      activeAgentSessionIds: new Set(),
    }));

    await expect(h.coordinator.commit(plan, {
      dispositions: dispositions([['tab-1', 'terminate']]),
      resolveCurrentTargets: () => [terminal],
      activeAgentSessionIds: new Set(),
    })).resolves.toEqual({ ok: false, reason: 'state-changed', stage: 'validation' });
    expect(h.destroySessionsGuarded).not.toHaveBeenCalled();
  });

  it('fails closed when active-agent risk changes during confirmation', async () => {
    const h = harness([BASE_SNAPSHOT]);
    const terminal = target('tab-1');
    const plan = prepared(h.coordinator.prepare({
      kind: 'auxiliary-window',
      targets: [terminal],
      activeAgentSessionIds: new Set(),
    }));

    await expect(h.coordinator.commit(plan, {
      dispositions: dispositions([['tab-1', 'terminate']]),
      resolveCurrentTargets: () => [terminal],
      activeAgentSessionIds: new Set(['session-1']),
    })).resolves.toEqual({ ok: false, reason: 'state-changed', stage: 'validation' });
  });

  it('requires an explicit disposition for every creator', async () => {
    const h = harness([BASE_SNAPSHOT]);
    const terminal = target('tab-1');
    const plan = prepared(h.coordinator.prepare({
      kind: 'auxiliary-window',
      targets: [terminal],
      activeAgentSessionIds: new Set(),
    }));

    await expect(h.coordinator.commit(plan, {
      dispositions: new Map(),
      resolveCurrentTargets: () => [terminal],
      activeAgentSessionIds: new Set(),
    })).resolves.toEqual({ ok: false, reason: 'state-changed', stage: 'validation' });
    expect(h.destroySessionsGuarded).not.toHaveBeenCalled();
  });
});
