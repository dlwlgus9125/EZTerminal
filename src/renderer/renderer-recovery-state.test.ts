import { afterEach, describe, expect, it, vi } from 'vitest';

import { LAYOUT_SCHEMA_VERSION } from '../shared/layout-schema';
import {
  RENDERER_RECOVERY_VERSION,
  type RendererRecoveryCheckpoint,
} from '../shared/renderer-recovery';
import {
  clearRendererRecoveryState,
  peekRendererRecoveryCheckpoint,
  peekRendererRecoveryPane,
  scheduleRendererRecoveryStateClear,
  seedRendererRecoveryState,
} from './renderer-recovery-state';

const checkpoint: RendererRecoveryCheckpoint = {
  version: RENDERER_RECOVERY_VERSION,
  savedAt: 1,
  layout: {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    savedAt: new Date(1).toISOString(),
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
    history: [],
    draft: 'keep me',
    activeRunIds: [],
    scrollTop: 0,
  }],
  activePanelId: 'tab-1',
};

afterEach(() => {
  clearRendererRecoveryState();
  vi.useRealTimers();
});

describe('renderer recovery startup cache', () => {
  it('serves the same checkpoint across attachment generations, then clears it', () => {
    vi.useFakeTimers();
    seedRendererRecoveryState(checkpoint);
    scheduleRendererRecoveryStateClear(100);

    expect(peekRendererRecoveryCheckpoint()).toBe(checkpoint);
    expect(peekRendererRecoveryPane('tab-1')?.draft).toBe('keep me');
    vi.advanceTimersByTime(99);
    expect(peekRendererRecoveryCheckpoint()).toBe(checkpoint);
    vi.advanceTimersByTime(1);
    expect(peekRendererRecoveryCheckpoint()).toBeNull();
    expect(peekRendererRecoveryPane('tab-1')).toBeUndefined();
  });

  it('reseeding cancels a stale clear timer', () => {
    vi.useFakeTimers();
    seedRendererRecoveryState(checkpoint);
    scheduleRendererRecoveryStateClear(100);
    vi.advanceTimersByTime(50);
    seedRendererRecoveryState(checkpoint);
    vi.advanceTimersByTime(50);

    expect(peekRendererRecoveryCheckpoint()).toBe(checkpoint);
  });
});
