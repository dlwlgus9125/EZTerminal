import { describe, expect, it, vi } from 'vitest';

import type { SessionSurfacePrepareCloseResult } from '../shared/session-surface';
import {
  PaneLifecycleCoordinator,
  type PaneLifecycleCoordinatorOptions,
  type PaneLifecycleTarget,
  type PreparedPaneLifecycle,
} from './pane-lifecycle-coordinator';
import type { PaneHandle, PaneSnapshot } from './pane-registry';

const OWNER: PaneSnapshot = {
  panelId: 'tab-1',
  sessionId: 'session-1',
  cwd: '/repo',
  history: [],
  draft: '',
  isBusy: true,
  isDead: false,
  sessionBindingPending: false,
  sessionSurfaceBindingId: 'binding-1',
  sessionSurfaceId: 'surface-1',
  sessionSurfaceRole: 'owner',
  destroysSessionOnClose: true,
  activeRunIds: ['run-1'],
  executionKind: 'local',
  hasSshPrompt: false,
  activePty: true,
  activeCommand: 'pnpm test',
  scrollTop: 0,
};

function target(panelId = 'tab-1', instanceToken: object = {}): PaneLifecycleTarget {
  return { panelId, title: panelId, component: 'terminal', instanceToken };
}

function handle(snapshot: PaneSnapshot): PaneHandle {
  return {
    getSnapshot: () => snapshot,
    insertText: () => ({ ok: true }),
    runText: () => ({ ok: true }),
    pasteToPty: () => ({ ok: true }),
    focus: () => true,
  };
}

function harness(initial: readonly PaneSnapshot[] = [OWNER]) {
  const snapshots = new Map(initial.map((snapshot) => [snapshot.panelId, snapshot]));
  const handles = new Map([...snapshots].map(([panelId, snapshot]) => [panelId, handle(snapshot)]));
  let tokenCounter = 0;
  const prepareSessionSurfaceClose = vi.fn<
    PaneLifecycleCoordinatorOptions['prepareSessionSurfaceClose']
  >(async (entries): Promise<SessionSurfacePrepareCloseResult> => ({
    ok: true,
    prepared: {
      closeToken: `close-${++tokenCounter}`,
      items: entries.map((entry) => {
        const snapshot = [...snapshots.values()].find(
          (candidate) => candidate.sessionSurfaceBindingId === entry.bindingId,
        );
        if (!snapshot?.sessionId || !snapshot.sessionSurfaceRole) {
          throw new Error('missing surface snapshot');
        }
        return {
          bindingId: entry.bindingId,
          surfaceId: `surface-${snapshot.panelId}`,
          sessionId: snapshot.sessionId,
          role: snapshot.sessionSurfaceRole,
        };
      }),
    },
  }));
  const commitSessionSurfaceClose = vi.fn<
    PaneLifecycleCoordinatorOptions['commitSessionSurfaceClose']
  >(async () => ({ ok: true, keptSessionIds: [] }));
  const coordinator = new PaneLifecycleCoordinator({
    getPaneHandle: (panelId) => handles.get(panelId),
    prepareSessionSurfaceClose,
    commitSessionSurfaceClose,
  });
  return {
    coordinator,
    snapshots,
    handles,
    prepareSessionSurfaceClose,
    commitSessionSurfaceClose,
  };
}

function prepared(result: ReturnType<PaneLifecycleCoordinator['prepare']>): PreparedPaneLifecycle {
  if (!result.ok) throw new Error(`expected preparation, got ${result.reason}`);
  return result.plan;
}

describe('PaneLifecycleCoordinator single-pane lifecycle', () => {
  it('prepares risk locally and terminates through one host surface transaction', async () => {
    const h = harness();
    const plan = prepared(h.coordinator.prepare({
      kind: 'single-pane',
      target: target(),
      activeAgentSessionIds: new Set(),
      confirmRiskyClose: true,
    }));

    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.items).toEqual([
      expect.objectContaining({ creator: true, risk: 'running-command' }),
    ]);
    await expect(h.coordinator.commit(plan, {
      dispositions: new Map([['tab-1', 'terminate']]),
      activeAgentSessionIds: new Set(),
    })).resolves.toMatchObject({ ok: true });
    expect(h.prepareSessionSurfaceClose).toHaveBeenCalledWith([{
      bindingId: 'binding-1',
      expectedActiveRunIds: ['run-1'],
    }]);
    expect(h.commitSessionSurfaceClose).toHaveBeenCalledWith('close-1', [{
      bindingId: 'binding-1',
      disposition: 'terminate',
    }]);
  });

  it('keeps an owner only after the host returns the kept session id', async () => {
    const h = harness([{ ...OWNER, isBusy: false, activeRunIds: [], activePty: false }]);
    h.commitSessionSurfaceClose.mockResolvedValueOnce({
      ok: true,
      keptSessionIds: ['session-1'],
    });
    const plan = prepared(h.coordinator.prepare({
      kind: 'single-pane',
      target: target(),
      activeAgentSessionIds: new Set(),
      confirmRiskyClose: true,
    }));

    const result = await h.coordinator.commit(plan, {
      dispositions: new Map([['tab-1', 'keep']]),
      activeAgentSessionIds: new Set(),
    });
    expect(result).toMatchObject({
      ok: true,
      commit: { keptSessionIds: ['session-1'] },
    });
    expect(h.commitSessionSurfaceClose).toHaveBeenCalledWith('close-1', [{
      bindingId: 'binding-1',
      disposition: 'keep',
    }]);
  });

  it('detaches an adopted view without inventing an owner decision', async () => {
    const adopted = {
      ...OWNER,
      isBusy: false,
      activeRunIds: [],
      sessionSurfaceRole: 'adopted' as const,
      destroysSessionOnClose: false,
    };
    const h = harness([adopted]);
    const plan = prepared(h.coordinator.prepare({
      kind: 'single-pane',
      target: target(),
      activeAgentSessionIds: new Set(),
      confirmRiskyClose: true,
    }));

    expect(plan.requiresConfirmation).toBe(false);
    await expect(h.coordinator.commit(plan, {
      dispositions: new Map(),
      activeAgentSessionIds: new Set(),
    })).resolves.toMatchObject({ ok: true });
    expect(h.commitSessionSurfaceClose).toHaveBeenCalledWith('close-1', []);
  });

  it('fails closed if renderer risk state changes before host preparation', async () => {
    const h = harness();
    const plan = prepared(h.coordinator.prepare({
      kind: 'single-pane',
      target: target(),
      activeAgentSessionIds: new Set(),
      confirmRiskyClose: true,
    }));
    h.handles.set('tab-1', handle({ ...OWNER, activeRunIds: ['run-2'] }));

    await expect(h.coordinator.commit(plan, {
      dispositions: new Map([['tab-1', 'terminate']]),
      activeAgentSessionIds: new Set(),
    })).resolves.toEqual({ ok: false, reason: 'state-changed', stage: 'validation' });
    expect(h.prepareSessionSurfaceClose).not.toHaveBeenCalled();
  });

  it('fails closed if an agent becomes active after confirmation', async () => {
    const h = harness();
    const plan = prepared(h.coordinator.prepare({
      kind: 'single-pane',
      target: target(),
      activeAgentSessionIds: new Set(),
      confirmRiskyClose: true,
    }));

    await expect(h.coordinator.commit(plan, {
      dispositions: new Map([['tab-1', 'terminate']]),
      activeAgentSessionIds: new Set(['session-1']),
    })).resolves.toEqual({ ok: false, reason: 'state-changed', stage: 'validation' });
    expect(h.prepareSessionSurfaceClose).not.toHaveBeenCalled();
  });

  it('propagates a host run-set conflict without committing UI close', async () => {
    const h = harness();
    h.commitSessionSurfaceClose.mockResolvedValueOnce({ ok: false, reason: 'state-changed' });
    const plan = prepared(h.coordinator.prepare({
      kind: 'single-pane',
      target: target(),
      activeAgentSessionIds: new Set(),
      confirmRiskyClose: true,
    }));

    await expect(h.coordinator.commit(plan, {
      dispositions: new Map([['tab-1', 'terminate']]),
      activeAgentSessionIds: new Set(),
    })).resolves.toEqual({ ok: false, reason: 'state-changed', stage: 'destroy' });
  });

  it('rejects pending or unbound terminal panes', () => {
    for (const snapshot of [
      { ...OWNER, sessionBindingPending: true },
      { ...OWNER, sessionSurfaceBindingId: null, sessionSurfaceRole: null },
    ]) {
      const h = harness([snapshot]);
      expect(h.coordinator.prepare({
        kind: 'single-pane',
        target: target(),
        activeAgentSessionIds: new Set(),
        confirmRiskyClose: true,
      })).toEqual({ ok: false, reason: 'unavailable', stage: 'validation' });
    }
  });
});

describe('PaneLifecycleCoordinator auxiliary lifecycle', () => {
  it('atomically includes owner and adopted bindings while deciding only the owner', async () => {
    const firstToken = {};
    const secondToken = {};
    const adopted: PaneSnapshot = {
      ...OWNER,
      panelId: 'tab-2',
      sessionId: 'session-2',
      sessionSurfaceBindingId: 'binding-2',
      sessionSurfaceRole: 'adopted',
      destroysSessionOnClose: false,
      isBusy: false,
      activeRunIds: [],
      activePty: false,
    };
    const h = harness([OWNER, adopted]);
    const targets = [target('tab-1', firstToken), target('tab-2', secondToken)];
    const plan = prepared(h.coordinator.prepare({
      kind: 'auxiliary-window',
      targets,
      activeAgentSessionIds: new Set(),
    }));
    const resolveCurrentTargets = () => targets;

    const result = await h.coordinator.commit(plan, {
      dispositions: new Map([['tab-1', 'terminate']]),
      resolveCurrentTargets,
      activeAgentSessionIds: new Set(),
    });
    expect(result).toMatchObject({ ok: true });
    expect(h.prepareSessionSurfaceClose).toHaveBeenCalledWith([
      { bindingId: 'binding-1', expectedActiveRunIds: ['run-1'] },
      { bindingId: 'binding-2', expectedActiveRunIds: [] },
    ]);
    expect(h.commitSessionSurfaceClose).toHaveBeenCalledWith('close-1', [{
      bindingId: 'binding-1',
      disposition: 'terminate',
    }]);
    if (!result.ok) throw new Error('expected commit');
    expect(h.coordinator.validateFinalization(result.commit, { resolveCurrentTargets }))
      .toEqual({ ok: true });
  });

  it('allows passive dock panels but detects target identity replacement', async () => {
    const ownerToken = {};
    const passiveToken = {};
    const h = harness();
    const targets = [
      target('tab-1', ownerToken),
      { ...target('history', passiveToken), component: 'agent-session' },
    ];
    const plan = prepared(h.coordinator.prepare({
      kind: 'auxiliary-window',
      targets,
      activeAgentSessionIds: new Set(),
    }));

    await expect(h.coordinator.commit(plan, {
      dispositions: new Map([['tab-1', 'terminate']]),
      resolveCurrentTargets: () => [target('tab-1', {}), targets[1]!],
      activeAgentSessionIds: new Set(),
    })).resolves.toEqual({ ok: false, reason: 'state-changed', stage: 'validation' });
    expect(h.prepareSessionSurfaceClose).not.toHaveBeenCalled();

    for (const component of ['project-editor', 'openclaw-chat'] as const) {
      const passive = { ...target(component, {}), component };
      expect(h.coordinator.prepare({
        kind: 'auxiliary-window',
        targets: [passive],
        activeAgentSessionIds: new Set(),
      })).toMatchObject({ ok: true });
    }
  });
});
