import { describe, expect, it } from 'vitest';

import { createDaemonCommand } from '../shared/daemon-protocol';
import { LAYOUT_SCHEMA_VERSION } from '../shared/layout-schema';
import { RENDERER_RECOVERY_VERSION } from '../shared/renderer-recovery';
import {
  RENDERER_RECOVERY_CHECKPOINT_TTL_MS,
  RendererRecoveryCheckpointStore,
} from './renderer-recovery-checkpoint-store';

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

function pendingAgentCreateCheckpoint(savedAt: number): Record<string, unknown> {
  const checkpoint = recoveryCheckpoint(savedAt);
  const layout = checkpoint.layout as { layout: { panels: Record<string, unknown> } };
  layout.layout.panels['agent-session-structured-draft-1'] = {
    id: 'agent-session-structured-draft-1',
    contentComponent: 'agent-session',
    renderer: 'always',
    params: { historyId: 'structured-draft-1' },
  };
  checkpoint.structuredAgentCreates = [{
    panelId: 'agent-session-structured-draft-1',
    historyId: 'structured-draft-1',
    sessionId: 'agent-1',
    phase: 'sending',
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
  }];
  return checkpoint;
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

  it('keeps a pending Agent create recoverable beyond the ordinary TTL exactly once', () => {
    let now = 1_000;
    const store = new RendererRecoveryCheckpointStore(
      RENDERER_RECOVERY_CHECKPOINT_TTL_MS,
      () => now,
    );
    expect(store.save(7, pendingAgentCreateCheckpoint(now))).toBe(true);
    store.markRecoverable(7);
    now += RENDERER_RECOVERY_CHECKPOINT_TTL_MS + 1;

    expect(store.consume(7)).toMatchObject({
      structuredAgentCreates: [{
        panelId: 'agent-session-structured-draft-1',
        sessionId: 'agent-1',
        command: { commandId: 'command-1', idempotencyKey: 'command-1' },
      }],
    });
    expect(store.consume(7)).toBeNull();
  });

  it('honors an explicit clear for a pending Agent create after the ordinary TTL', () => {
    let now = 1_000;
    const store = new RendererRecoveryCheckpointStore(
      RENDERER_RECOVERY_CHECKPOINT_TTL_MS,
      () => now,
    );
    expect(store.save(7, pendingAgentCreateCheckpoint(now))).toBe(true);
    store.markRecoverable(7);
    now += RENDERER_RECOVERY_CHECKPOINT_TTL_MS + 1;
    store.clear(7);

    expect(store.hasPendingStructuredAgentCreate(7)).toBe(false);
    expect(store.consume(7)).toBeNull();
  });

  it('clears an escrowed checkpoint before it can be recovered', () => {
    const store = new RendererRecoveryCheckpointStore(5_000, () => 1_000);
    expect(store.save(7, pendingAgentCreateCheckpoint(1_000))).toBe(true);
    expect(store.hasPendingStructuredAgentCreate(7)).toBe(true);
    expect(store.blocksMainWindowClose(7, false)).toBe(true);
    expect(store.blocksMainWindowClose(7, true)).toBe(false);
    store.markRecoverable(7);
    store.clear(7);

    expect(store.hasPendingStructuredAgentCreate(7)).toBe(false);
    expect(store.consume(7)).toBeNull();
  });
});
