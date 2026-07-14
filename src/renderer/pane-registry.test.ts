import { describe, expect, it, vi } from 'vitest';

import {
  closePaneAfterGuardedSessionDestroy,
  getPaneCwd,
  hasExactCreatorPaneSet,
  hasNoUnexpectedCreatorPanes,
  hasPendingSessionBinding,
  insertIntoPaneInput,
  listCreatorPaneSnapshots,
  registerPaneInput,
  removePaneCwd,
  setPaneCwd,
  unregisterPaneInput,
} from './pane-registry';
import type { PaneSnapshot } from './pane-registry';

const SNAPSHOT: PaneSnapshot = {
  panelId: 'p-destroy',
  sessionId: 'session-1',
  cwd: '/tmp',
  history: [],
  draft: '',
  isBusy: true,
  isDead: false,
  sessionBindingPending: false,
  destroysSessionOnClose: true,
  activeRunIds: ['run-b', 'run-a'],
  executionKind: 'local',
  hasSshPrompt: false,
  activePty: false,
  activeCommand: null,
};

describe('pane-registry', () => {
  it('set/get/remove cwd semantics', () => {
    expect(getPaneCwd('p1')).toBeUndefined();
    setPaneCwd('p1', 'C:\\Users\\a');
    expect(getPaneCwd('p1')).toBe('C:\\Users\\a');
    setPaneCwd('p1', 'C:\\Users\\b');
    expect(getPaneCwd('p1')).toBe('C:\\Users\\b');
    removePaneCwd('p1');
    expect(getPaneCwd('p1')).toBeUndefined();
  });

  it('insertIntoPaneInput returns false when no pane is registered', () => {
    expect(insertIntoPaneInput('missing', 'text')).toBe(false);
  });

  it('insertIntoPaneInput returns true and delivers text when registered', () => {
    const received: string[] = [];
    registerPaneInput('p2', (text) => received.push(text));
    expect(insertIntoPaneInput('p2', 'hello')).toBe(true);
    expect(received).toEqual(['hello']);
    unregisterPaneInput('p2');
    expect(insertIntoPaneInput('p2', 'again')).toBe(false);
  });

  it('reports an unresolved pane binding even before it has a session id', () => {
    expect(hasPendingSessionBinding([SNAPSHOT])).toBe(false);
    expect(hasPendingSessionBinding([{
      ...SNAPSHOT,
      sessionId: null,
      destroysSessionOnClose: false,
      sessionBindingPending: true,
    }])).toBe(true);
  });

  it('does not close a creator pane until guarded destruction is acknowledged', async () => {
    let resolveGuard!: (result: { ok: true }) => void;
    const guard = vi.fn(() => new Promise<{ ok: true }>((resolve) => {
      resolveGuard = resolve;
    }));
    const close = vi.fn();
    const markHandled = vi.fn(() => true);

    const result = closePaneAfterGuardedSessionDestroy(
      SNAPSHOT,
      guard,
      () => SNAPSHOT,
      markHandled,
      close,
    );
    expect(close).not.toHaveBeenCalled();
    expect(markHandled).not.toHaveBeenCalled();

    resolveGuard({ ok: true });
    await expect(result).resolves.toBe('closed');
    expect(markHandled).toHaveBeenCalledWith('session-1');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes a still-dead creator locally without asking an unavailable backend', async () => {
    const dead = { ...SNAPSHOT, isDead: true };
    const guard = vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const }));
    const close = vi.fn();

    await expect(closePaneAfterGuardedSessionDestroy(
      dead,
      guard,
      () => dead,
      () => true,
      close,
    )).resolves.toBe('closed');
    expect(guard).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps the pane open when guarded destruction fails or the pane identity changes', async () => {
    const close = vi.fn();
    await expect(closePaneAfterGuardedSessionDestroy(
      SNAPSHOT,
      async () => ({ ok: false, reason: 'state-changed' }),
      () => SNAPSHOT,
      () => true,
      close,
    )).resolves.toBe('state-changed');
    expect(close).not.toHaveBeenCalled();

    await expect(closePaneAfterGuardedSessionDestroy(
      SNAPSHOT,
      async () => ({ ok: true }),
      () => ({ ...SNAPSHOT, sessionId: 'replacement-session' }),
      () => true,
      close,
    )).resolves.toBe('pane-changed');
    expect(close).not.toHaveBeenCalled();

    await expect(closePaneAfterGuardedSessionDestroy(
      SNAPSHOT,
      async () => ({ ok: true }),
      () => SNAPSHOT,
      () => false,
      close,
    )).resolves.toBe('pane-changed');
    expect(close).not.toHaveBeenCalled();
  });

  it('freezes and revalidates creator identities across preset awaits', () => {
    const expected = listCreatorPaneSnapshots([
      SNAPSHOT,
      { ...SNAPSHOT, panelId: 'adopted', sessionId: 'session-adopted', destroysSessionOnClose: false },
    ]);
    expect(expected).toHaveLength(1);
    expect(Object.isFrozen(expected)).toBe(true);
    expect(Object.isFrozen(expected[0].activeRunIds)).toBe(true);
    expect(hasExactCreatorPaneSet(expected, listCreatorPaneSnapshots([SNAPSHOT]))).toBe(true);
    expect(hasExactCreatorPaneSet(expected, listCreatorPaneSnapshots([
      SNAPSHOT,
      { ...SNAPSHOT, panelId: 'new', sessionId: 'session-new' },
    ]))).toBe(false);
    expect(hasExactCreatorPaneSet(expected, listCreatorPaneSnapshots([
      { ...SNAPSHOT, activeRunIds: [...SNAPSHOT.activeRunIds, 'run-new'] },
    ]))).toBe(false);
  });

  it('allows only missing creators or a subset of expected runs after destroy ACK', () => {
    const expected = listCreatorPaneSnapshots([SNAPSHOT]);
    expect(hasNoUnexpectedCreatorPanes(expected, [])).toBe(true);
    expect(hasNoUnexpectedCreatorPanes(expected, listCreatorPaneSnapshots([
      { ...SNAPSHOT, activeRunIds: ['run-a'] },
    ]))).toBe(true);
    expect(hasNoUnexpectedCreatorPanes(expected, listCreatorPaneSnapshots([
      { ...SNAPSHOT, activeRunIds: [...SNAPSHOT.activeRunIds, 'run-new'] },
    ]))).toBe(false);
    expect(hasNoUnexpectedCreatorPanes(expected, listCreatorPaneSnapshots([
      { ...SNAPSHOT, sessionId: 'replacement-session' },
    ]))).toBe(false);
  });
});
