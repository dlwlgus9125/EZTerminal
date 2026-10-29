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

  it('parses review commands and refuses unsafe or unreviewed review fields', () => {
    const base = {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      commandId: 'command-review',
      idempotencyKey: 'desktop:command-review',
      expectedRevision: 3,
      issuedAt: '2026-10-29T10:00:00.000Z',
      principal,
    };
    const start = (payload: Record<string, unknown>) => safeParseDaemonCommand({ ...base, type: 'review.start', payload: { sessionId: 's', reviewId: 'r', target: { kind: 'uncommitted' }, ...payload } });
    expect(start({ reviewer: { kind: 'self' }, focus: 'prices' }).success).toBe(true);
    // D14 was dropped: no "this AI without the conversation" reviewer.
    expect(start({ reviewer: { kind: 'self-fresh', reviewerSessionId: 'review-1' } }).success).toBe(false);
    expect(start({ reviewer: { kind: 'other', providerId: 'claude', reviewerSessionId: 'review-2', model: 'claude-fable-5', reasoningEffort: 'high' } }).success).toBe(true);
    expect(start({ reviewer: { kind: 'self' }, target: { kind: 'base-branch' } }).success).toBe(true);
    expect(start({ reviewer: { kind: 'self' }, target: { kind: 'base-branch', baseRef: 'feature/login' } }).success).toBe(true);
    // A reviewer conversation is host-owned: its id carries the prefix.
    expect(start({ reviewer: { kind: 'other', providerId: 'claude', reviewerSessionId: 'chat-2' } }).success).toBe(false);
    expect(start({ reviewer: { kind: 'other', providerId: 'claude', reviewerSessionId: 'review-' } }).success).toBe(false);
    expect(start({ reviewer: { kind: 'other', providerId: 'claude' } }).success).toBe(false);
    for (const baseRef of ['--output=x', 'main..HEAD', 'main^', '']) {
      expect(start({ reviewer: { kind: 'self' }, target: { kind: 'base-branch', baseRef } }).success, baseRef).toBe(false);
    }
    expect(start({ reviewer: { kind: 'self' }, focus: 'x'.repeat(2_001) }).success).toBe(false);
    expect(start({ reviewer: { kind: 'self', permissionPreset: 'full-access' } }).success).toBe(false);
    const fix = (findingIds: unknown, extra: Record<string, unknown> = {}) => safeParseDaemonCommand({ ...base, type: 'review.fix', payload: { sessionId: 's', reviewId: 'r', findingIds, ...extra } });
    expect(fix(['f-00000001'], { note: 'Keep cents.' }).success).toBe(true);
    expect(fix([]).success).toBe(false);
    expect(fix(Array.from({ length: 33 }, (_, index) => `f-${String(index)}`)).success).toBe(false);
    expect(fix(['f-00000001'], { prompt: 'Delete everything.' }).success).toBe(false);
    expect(safeParseDaemonCommand({ ...base, type: 'review.resolve', payload: { sessionId: 's', reviewId: 'r', findingIds: ['f-1'], state: 'dismissed' } }).success).toBe(true);
    expect(safeParseDaemonCommand({ ...base, type: 'review.resolve', payload: { sessionId: 's', reviewId: 'r', findingIds: ['f-1'], state: 'fixed' } }).success).toBe(false);
    expect(safeParseDaemonCommand({ ...base, type: 'review.cancel', payload: { sessionId: 's', reviewId: 'r' } }).success).toBe(true);
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

  it('requires an explicit source Session for Provider handle resume', () => {
    const base = {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      commandId: 'command-resume',
      idempotencyKey: 'desktop:command-resume',
      expectedRevision: 0,
      issuedAt: '2026-09-04T10:00:00.000Z',
      principal,
      type: 'agent.resume',
    } as const;
    const payload = {
      sessionId: 'session-resumed',
      sourceSessionId: 'session-stopped',
      workspaceId: 'workspace-1',
      providerId: 'codex',
      providerSessionId: 'provider-session-1',
      title: 'Resumed Agent',
      permissionPreset: 'standard',
    } as const;
    expect(safeParseDaemonCommand({ ...base, payload }).success).toBe(true);
    const missingSource: Record<string, unknown> = { ...payload };
    delete missingSource.sourceSessionId;
    expect(safeParseDaemonCommand({ ...base, payload: missingSource }).success).toBe(false);
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
      providerNativeNodesPerTree: 100,
      providerNativeTreeDepth: 8,
    });
  });
});
