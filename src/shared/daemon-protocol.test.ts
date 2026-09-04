import { describe, expect, it } from 'vitest';

import {
  DAEMON_HARD_LIMITS,
  DAEMON_PROTOCOL_VERSION,
  classifyDaemonEvent,
  createDaemonCommand,
  parseDaemonCommand,
  safeParseDaemonCommand,
  type DaemonEvent,
} from './daemon-protocol';

const principal = { kind: 'desktop' as const, id: 'main-window' };

describe('daemon protocol', () => {
  it('constructs and parses a revision-guarded command', () => {
    const command = createDaemonCommand({
      commandId: 'command-1',
      idempotencyKey: 'desktop:command-1',
      expectedRevision: 7,
      issuedAt: '2026-09-04T10:00:00.000Z',
      principal,
      type: 'agent.submit',
      payload: { sessionId: 'session-1', prompt: 'Continue the implementation.' },
    });

    expect(parseDaemonCommand(command)).toEqual(command);
    expect(command.protocolVersion).toBe(DAEMON_PROTOCOL_VERSION);
  });

  it('rejects unknown commands and unreviewed payload fields', () => {
    const base = {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      commandId: 'command-2',
      idempotencyKey: 'desktop:command-2',
      expectedRevision: 0,
      issuedAt: '2026-09-04T10:00:00.000Z',
      principal,
    };

    expect(safeParseDaemonCommand({ ...base, type: 'agent.erase-everything', payload: {} }).success).toBe(false);
    expect(safeParseDaemonCommand({
      ...base,
      type: 'provider.enable',
      payload: {
        providerId: 'codex',
        displayName: 'Codex',
        protocol: 'codex-app-server',
        executablePath: 'C:\\Tools\\codex.exe',
        executableVersion: '0.152.1',
        argv: ['app-server'],
        environmentVariableNames: [],
        capabilities: ['approval'],
        reviewDigest: 'sha256:reviewed',
        accessToken: 'must-never-cross-this-boundary',
      },
    }).success).toBe(false);
  });

  it('requires session scope for MCP principals', () => {
    expect(safeParseDaemonCommand({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      commandId: 'command-3',
      idempotencyKey: 'mcp:command-3',
      expectedRevision: 0,
      issuedAt: '2026-09-04T10:00:00.000Z',
      principal: { kind: 'mcp', id: 'capability-1' },
      type: 'agent.submit',
      payload: { sessionId: 'session-1', prompt: 'Inspect this.' },
    }).success).toBe(false);
  });

  it('classifies monotonic event delivery without guessing across gaps', () => {
    const event = {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      eventId: 'event-8',
      sequence: 8,
      revision: 5,
      occurredAt: '2026-09-04T10:00:01.000Z',
      kind: 'entity.upserted',
      payload: { entityType: 'session', entityId: 'session-1' },
    } satisfies DaemonEvent;

    expect(classifyDaemonEvent({ revision: 4, eventSequence: 7 }, event)).toBe('next');
    expect(classifyDaemonEvent({ revision: 4, eventSequence: 5 }, event)).toBe('gap');
    expect(classifyDaemonEvent({ revision: 5, eventSequence: 8 }, event)).toBe('duplicate');
    expect(classifyDaemonEvent({ revision: 6, eventSequence: 7 }, event)).toBe('revision-regression');
  });

  it('publishes the non-configurable orchestration limits', () => {
    expect(DAEMON_HARD_LIMITS).toEqual({
      concurrentManagedTurns: 4,
      nodesPerTree: 16,
      treeDepth: 4,
      childCreationsPerWindow: 12,
      childCreationWindowMs: 600_000,
      backgroundTurnMs: 7_200_000,
    });
  });
});
