import { describe, expect, it } from 'vitest';

import { LAYOUT_SCHEMA_VERSION } from '../shared/layout-schema';
import { RENDERER_RECOVERY_VERSION } from '../shared/renderer-recovery';
import { RendererRecoveryCheckpointStore } from './renderer-recovery-checkpoint-store';

function recoveryCheckpoint(savedAt: number): Record<string, unknown> {
  return {
    version: RENDERER_RECOVERY_VERSION,
    savedAt,
    layout: {
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      savedAt: new Date(savedAt).toISOString(),
      layout: {
        grid: {
          root: { type: 'branch', data: [] },
          width: 800,
          height: 600,
          orientation: 'HORIZONTAL',
        },
        panels: {
          'tab-1': { id: 'tab-1', contentComponent: 'terminal', renderer: 'always' },
        },
      },
    },
    panes: [{
      panelId: 'tab-1',
      sessionId: 'session-1',
      sessionSurfaceId: 'surface-1',
      cwd: '/repo',
      history: ['pwd'],
      draft: '',
      activeRunIds: [],
      scrollTop: 0,
    }],
    activePanelId: 'tab-1',
  };
}

describe('RendererRecoveryCheckpointStore', () => {
  it('exposes a checkpoint exactly once and only after a crash is marked', () => {
    let now = 1_000;
    const store = new RendererRecoveryCheckpointStore(5_000, () => now);
    expect(store.save(7, recoveryCheckpoint(now))).toBe(true);
    expect(store.consume(7)).toBeNull();
    store.markRecoverable(7);
    expect(store.consume(7)).toMatchObject({ version: 1, activePanelId: 'tab-1' });
    expect(store.consume(7)).toBeNull();
    now += 1;
  });

  it('rejects malformed input and expires stale checkpoints', () => {
    let now = 1_000;
    const store = new RendererRecoveryCheckpointStore(100, () => now);
    expect(store.save(7, { nope: true })).toBe(false);
    expect(store.save(7, recoveryCheckpoint(now))).toBe(true);
    store.markRecoverable(7);
    now += 101;
    expect(store.consume(7)).toBeNull();
  });

  it('does not revive an old checkpoint when recovery is marked late', () => {
    let now = 1_000;
    const store = new RendererRecoveryCheckpointStore(100, () => now);
    expect(store.save(7, recoveryCheckpoint(now))).toBe(true);
    now += 101;
    store.markRecoverable(7);
    expect(store.consume(7)).toBeNull();
  });
});
