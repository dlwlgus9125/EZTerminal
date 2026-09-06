import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDaemonCommand } from '../shared/daemon-protocol';
import { LAYOUT_SCHEMA_VERSION } from '../shared/layout-schema';
import {
  RENDERER_RECOVERY_VERSION,
  type RendererRecoveryCheckpoint,
} from '../shared/renderer-recovery';
import {
  clearRendererRecoveryState,
  consumeRendererRecoveryStructuredAgentCreate,
  peekRendererRecoveryCheckpoint,
  peekRendererRecoveryPane,
  peekRendererRecoveryStructuredAgentCreate,
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
  structuredAgentCreates: [],
  activePanelId: 'tab-1',
};

const structuredAgentCheckpoint: RendererRecoveryCheckpoint = {
  ...checkpoint,
  layout: {
    ...checkpoint.layout,
    layout: {
      ...checkpoint.layout.layout,
      panels: {
        ...checkpoint.layout.layout.panels,
        'agent-session-structured-draft-1': {
          id: 'agent-session-structured-draft-1',
          contentComponent: 'agent-session',
          renderer: 'always',
          params: { historyId: 'structured-draft-1' },
        },
      },
    },
  },
  structuredAgentCreates: [{
    panelId: 'agent-session-structured-draft-1',
    historyId: 'structured-draft-1',
    sessionId: 'agent-1',
    phase: 'delivery-uncertain',
    command: createDaemonCommand({
      commandId: 'command-1',
      idempotencyKey: 'command-1',
      expectedRevision: 4,
      issuedAt: '2026-09-06T00:00:00.000Z',
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type: 'agent.create',
      payload: {
        sessionId: 'agent-1',
        workspaceId: 'workspace-1',
        title: 'Create an Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Create an Agent',
      },
    }),
  }],
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

  it('transfers a structured Agent recovery envelope exactly once and clears unconsumed entries', () => {
    seedRendererRecoveryState(structuredAgentCheckpoint);

    expect(peekRendererRecoveryStructuredAgentCreate('agent-session-structured-draft-1')?.command.commandId)
      .toBe('command-1');
    expect(consumeRendererRecoveryStructuredAgentCreate(
      'agent-session-structured-draft-1',
      'stale-command',
    )).toBeUndefined();
    const consumed = consumeRendererRecoveryStructuredAgentCreate('agent-session-structured-draft-1');
    expect(consumed?.command.commandId).toBe('command-1');
    expect(consumeRendererRecoveryStructuredAgentCreate('agent-session-structured-draft-1')).toBeUndefined();

    seedRendererRecoveryState(structuredAgentCheckpoint);
    clearRendererRecoveryState();
    expect(consumeRendererRecoveryStructuredAgentCreate('agent-session-structured-draft-1')).toBeUndefined();
  });
});
