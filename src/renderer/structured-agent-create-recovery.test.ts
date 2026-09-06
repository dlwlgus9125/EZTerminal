import { describe, expect, it, vi } from 'vitest';

import { createDaemonCommand } from '../shared/daemon-protocol';
import {
  RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_CREATES,
  type RendererRecoveryStructuredAgentCreate,
} from '../shared/renderer-recovery';
import {
  structuredAgentCreateCheckpointRecords,
  StructuredAgentCreateRecoveryRegistry,
} from './structured-agent-create-recovery';

function recovery(
  panelId = 'agent-session-structured-draft-1',
  commandId = 'command-1',
  sessionId = 'agent-1',
): RendererRecoveryStructuredAgentCreate {
  return Object.freeze({
    panelId,
    historyId: 'structured-draft-1',
    sessionId,
    phase: 'sending',
    command: createDaemonCommand({
      commandId,
      idempotencyKey: commandId,
      expectedRevision: 4,
      issuedAt: '2026-09-06T00:00:00.000Z',
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type: 'agent.create',
      payload: {
        sessionId,
        workspaceId: 'workspace-1',
        title: 'Create an Agent',
        providerId: 'codex',
        permissionPreset: 'standard',
        initialPrompt: 'Create an Agent',
      },
    }),
  });
}

describe('StructuredAgentCreateRecoveryRegistry', () => {
  it('fail-closes tab, auxiliary-window, and preset replacement paths', () => {
    const registry = new StructuredAgentCreateRecoveryRegistry();
    registry.register(recovery());

    expect(registry.blocksPanelClose('agent-session-structured-draft-1')).toBe(true);
    expect(registry.blocksPanelClose('unrelated-panel')).toBe(false);
    expect(registry.blocksAuxiliaryClose(['unrelated-panel', 'agent-session-structured-draft-1'])).toBe(true);
    expect(registry.blocksAuxiliaryClose(['unrelated-panel'])).toBe(false);
    expect(registry.blocksWorkspaceReplacement()).toBe(true);
  });

  it('keeps a newer retry when a stale completion clears the old command', () => {
    const registry = new StructuredAgentCreateRecoveryRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    registry.register(recovery());
    registry.register(recovery('agent-session-structured-draft-1', 'command-2', 'agent-1'));

    expect(registry.clear('agent-session-structured-draft-1', 'command-1')).toBe(false);
    expect(registry.get('agent-session-structured-draft-1')?.command.commandId).toBe('command-2');
    expect(registry.clear('agent-session-structured-draft-1', 'command-2')).toBe(true);
    expect(registry.blocksWorkspaceReplacement()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
  });

  it('marks only the matching command delivery-uncertain', () => {
    const registry = new StructuredAgentCreateRecoveryRegistry();
    registry.register(recovery());

    registry.markDeliveryUncertain('agent-session-structured-draft-1', 'stale-command');
    expect(registry.get('agent-session-structured-draft-1')?.phase).toBe('sending');

    registry.markDeliveryUncertain('agent-session-structured-draft-1', 'command-1');
    expect(registry.get('agent-session-structured-draft-1')?.phase).toBe('delivery-uncertain');
  });

  it('rejects a new panel record when the checkpoint capacity is already full', () => {
    const registry = new StructuredAgentCreateRecoveryRegistry();
    for (let index = 0; index < RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_CREATES; index += 1) {
      registry.register(recovery(
        `agent-session-structured-draft-${index}`,
        `command-${index}`,
        `agent-${index}`,
      ));
    }

    expect(registry.register(recovery(
      'agent-session-structured-draft-overflow',
      'command-overflow',
      'agent-overflow',
    ))).toBe(false);
    expect(registry.list()).toHaveLength(RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_CREATES);
    expect(registry.get('agent-session-structured-draft-overflow')).toBeUndefined();
    expect(registry.get('agent-session-structured-draft-0')?.command.commandId).toBe('command-0');

    expect(registry.register(recovery(
      'agent-session-structured-draft-0',
      'command-retry',
      'agent-0',
    ))).toBe(true);
    expect(registry.list()).toHaveLength(RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_CREATES);
    expect(registry.get('agent-session-structured-draft-0')?.command.commandId).toBe('command-retry');
  });

  it('never truncates live panel-bound records to make an overflowing checkpoint look valid', () => {
    const records = Array.from(
      { length: RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_CREATES + 1 },
      (_, index) => recovery(
        `agent-session-structured-draft-${index}`,
        `command-${index}`,
        `agent-${index}`,
      ),
    );
    const allPanelIds = new Set(records.map((record) => record.panelId));

    expect(structuredAgentCreateCheckpointRecords(records, allPanelIds)).toBeNull();

    const fittingRecords = records.slice(0, RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_CREATES);
    const fittingPanelIds = new Set(fittingRecords.map((record) => record.panelId));
    expect(structuredAgentCreateCheckpointRecords(records, fittingPanelIds)).toEqual(fittingRecords);
  });
});
