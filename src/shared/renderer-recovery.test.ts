import { describe, expect, it } from 'vitest';

import { LAYOUT_SCHEMA_VERSION } from './layout-schema';
import {
  RENDERER_RECOVERY_VERSION,
  validateRendererRecoveryCheckpoint,
} from './renderer-recovery';

export function recoveryCheckpoint(savedAt = 1_000): Record<string, unknown> {
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
          'tab-1': {
            id: 'tab-1',
            contentComponent: 'terminal',
            renderer: 'always',
          },
        },
      },
    },
    panes: [{
      panelId: 'tab-1',
      sessionId: 'session-1',
      sessionSurfaceId: 'surface-1',
      cwd: '/repo',
      history: ['pwd'],
      draft: 'git status',
      activeRunIds: ['run-1'],
      scrollTop: 42,
    }],
    activePanelId: 'tab-1',
  };
}

describe('renderer recovery checkpoint validation', () => {
  it('accepts a bounded volatile pane snapshot', () => {
    expect(validateRendererRecoveryCheckpoint(recoveryCheckpoint())).toMatchObject({
      version: 1,
      panes: [{ panelId: 'tab-1', sessionId: 'session-1' }],
    });
  });

  it('rejects a surface without its matching session identity', () => {
    const checkpoint = recoveryCheckpoint();
    (checkpoint.panes as Array<Record<string, unknown>>)[0].sessionId = null;
    expect(validateRendererRecoveryCheckpoint(checkpoint)).toBeNull();
  });

  it('rejects pane identities absent from the validated layout', () => {
    const checkpoint = recoveryCheckpoint();
    (checkpoint.panes as Array<Record<string, unknown>>)[0].panelId = 'tab-2';
    expect(validateRendererRecoveryCheckpoint(checkpoint)).toBeNull();
  });
});
