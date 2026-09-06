import { describe, expect, it } from 'vitest';

import { createDaemonCommand } from './daemon-protocol';
import { LAYOUT_SCHEMA_VERSION } from './layout-schema';
import {
  RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_PROMPT_CHARS,
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

function structuredAgentRecoveryCheckpoint(): Record<string, unknown> {
  const checkpoint = recoveryCheckpoint();
  const layout = checkpoint.layout as {
    layout: { panels: Record<string, unknown> };
  };
  layout.layout.panels['agent-session-structured-draft-1'] = {
    id: 'agent-session-structured-draft-1',
    contentComponent: 'agent-session',
    renderer: 'always',
    params: { historyId: 'structured-draft-1' },
  };
  const command = createDaemonCommand({
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
  });
  checkpoint.structuredAgentCreates = [{
    panelId: 'agent-session-structured-draft-1',
    historyId: 'structured-draft-1',
    sessionId: 'agent-1',
    phase: 'delivery-uncertain',
    command,
  }];
  return checkpoint;
}

describe('renderer recovery checkpoint validation', () => {
  it('accepts a bounded volatile pane snapshot', () => {
    expect(validateRendererRecoveryCheckpoint(recoveryCheckpoint())).toMatchObject({
      version: 1,
      panes: [{ panelId: 'tab-1', sessionId: 'session-1' }],
      structuredAgentCreates: [],
    });
  });

  it('accepts a legacy missing recovery list but rejects an explicit invalid value', () => {
    expect(validateRendererRecoveryCheckpoint(recoveryCheckpoint())?.structuredAgentCreates).toEqual([]);
    const checkpoint = recoveryCheckpoint();
    checkpoint.structuredAgentCreates = null;
    expect(validateRendererRecoveryCheckpoint(checkpoint)).toBeNull();
  });

  it('accepts and freezes an exact structured Agent create bound to its draft panel', () => {
    const validated = validateRendererRecoveryCheckpoint(structuredAgentRecoveryCheckpoint());

    expect(validated?.structuredAgentCreates).toMatchObject([{
      panelId: 'agent-session-structured-draft-1',
      historyId: 'structured-draft-1',
      sessionId: 'agent-1',
      phase: 'delivery-uncertain',
      command: {
        commandId: 'command-1',
        idempotencyKey: 'command-1',
        type: 'agent.create',
        payload: { sessionId: 'agent-1', initialPrompt: 'Create an Agent' },
      },
    }]);
    expect(Object.isFrozen(validated?.structuredAgentCreates)).toBe(true);
    expect(Object.isFrozen(validated?.structuredAgentCreates[0]?.command.payload)).toBe(true);
  });

  it.each([
    ['missing panel', (checkpoint: Record<string, unknown>) => {
      const records = checkpoint.structuredAgentCreates as Array<Record<string, unknown>>;
      records[0]!.panelId = 'missing-panel';
    }],
    ['wrong panel type', (checkpoint: Record<string, unknown>) => {
      const records = checkpoint.structuredAgentCreates as Array<Record<string, unknown>>;
      records[0]!.panelId = 'tab-1';
    }],
    ['mismatched history', (checkpoint: Record<string, unknown>) => {
      const records = checkpoint.structuredAgentCreates as Array<Record<string, unknown>>;
      records[0]!.historyId = 'structured-draft-other';
    }],
    ['non-canonical panel identity', (checkpoint: Record<string, unknown>) => {
      const records = checkpoint.structuredAgentCreates as Array<Record<string, unknown>>;
      records[0]!.panelId = 'agent-session-noncanonical';
      const layout = checkpoint.layout as { layout: { panels: Record<string, unknown> } };
      layout.layout.panels['agent-session-noncanonical'] = {
        id: 'agent-session-noncanonical',
        contentComponent: 'agent-session',
        renderer: 'always',
        params: { historyId: 'structured-draft-1' },
      };
    }],
    ['unknown recovery record field', (checkpoint: Record<string, unknown>) => {
      const records = checkpoint.structuredAgentCreates as Array<Record<string, unknown>>;
      records[0]!.prompt = 'duplicate plaintext';
    }],
    ['mismatched session', (checkpoint: Record<string, unknown>) => {
      const records = checkpoint.structuredAgentCreates as Array<Record<string, unknown>>;
      records[0]!.sessionId = 'agent-other';
    }],
    ['non-desktop principal', (checkpoint: Record<string, unknown>) => {
      const records = checkpoint.structuredAgentCreates as Array<Record<string, unknown>>;
      const command = records[0]!.command as Record<string, unknown>;
      command.principal = { kind: 'android', id: 'mobile-agent-ui' };
    }],
    ['wrong Desktop principal', (checkpoint: Record<string, unknown>) => {
      const records = checkpoint.structuredAgentCreates as Array<Record<string, unknown>>;
      const command = records[0]!.command as Record<string, unknown>;
      command.principal = { kind: 'desktop', id: 'another-renderer' };
    }],
    ['session-scoped Desktop principal', (checkpoint: Record<string, unknown>) => {
      const records = checkpoint.structuredAgentCreates as Array<Record<string, unknown>>;
      const command = records[0]!.command as Record<string, unknown>;
      command.principal = {
        kind: 'desktop',
        id: 'renderer-agent-ui',
        sessionId: 'agent-parent',
      };
    }],
    ['non-canonical trimmed command identity', (checkpoint: Record<string, unknown>) => {
      const records = checkpoint.structuredAgentCreates as Array<Record<string, unknown>>;
      const command = records[0]!.command as Record<string, unknown>;
      command.commandId = ' command-1 ';
      command.idempotencyKey = ' command-1 ';
    }],
    ['parent Agent create', (checkpoint: Record<string, unknown>) => {
      const records = checkpoint.structuredAgentCreates as Array<Record<string, unknown>>;
      const command = records[0]!.command as { payload: Record<string, unknown> };
      command.payload.parentSessionId = 'agent-parent';
    }],
  ])('rejects a structured Agent checkpoint with %s', (_label, mutate) => {
    const checkpoint = structuredAgentRecoveryCheckpoint();
    mutate(checkpoint);
    expect(validateRendererRecoveryCheckpoint(checkpoint)).toBeNull();
  });

  it('rejects oversized prompts and duplicate logical sessions', () => {
    const oversized = structuredAgentRecoveryCheckpoint();
    const oversizedRecord = (oversized.structuredAgentCreates as Array<{
      command: { payload: { initialPrompt: string } };
    }>)[0]!;
    oversizedRecord.command.payload.initialPrompt = 'x'.repeat(
      RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_PROMPT_CHARS + 1,
    );
    expect(validateRendererRecoveryCheckpoint(oversized)).toBeNull();

    const duplicate = structuredAgentRecoveryCheckpoint();
    const records = duplicate.structuredAgentCreates as Array<Record<string, unknown>>;
    records.push({
      ...records[0],
      panelId: 'agent-session-structured-draft-2',
      historyId: 'structured-draft-2',
    });
    const layout = duplicate.layout as { layout: { panels: Record<string, unknown> } };
    layout.layout.panels['agent-session-structured-draft-2'] = {
      id: 'agent-session-structured-draft-2',
      contentComponent: 'agent-session',
      renderer: 'always',
      params: { historyId: 'structured-draft-2' },
    };
    expect(validateRendererRecoveryCheckpoint(duplicate)).toBeNull();
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
