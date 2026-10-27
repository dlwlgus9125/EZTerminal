import { describe, expect, it } from 'vitest';

import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonEvent,
  type DaemonEventPayloads,
} from '../shared/daemon-protocol';
import { daemonEventAffectsAgentSessionProjection } from './daemon-session-events';

const base = {
  protocolVersion: DAEMON_PROTOCOL_VERSION,
  eventId: 'event',
  revision: 1,
  sequence: 2,
  occurredAt: '2026-10-28T00:00:00.000Z',
};

function upserted(entityType: DaemonEventPayloads['entity.upserted']['entityType']): DaemonEvent {
  return { ...base, kind: 'entity.upserted', payload: { entityType, entityId: 'id' } };
}

describe('daemonEventAffectsAgentSessionProjection', () => {
  it('ignores streamed transcript events', () => {
    expect(daemonEventAffectsAgentSessionProjection({
      ...base,
      kind: 'transcript.appended',
      payload: { sessionId: 'chat', fromSequence: 2, toSequence: 2 },
    })).toBe(false);
  });

  it('refreshes for changes to the project, workspace, session, agent, relation or provider rows', () => {
    for (const entityType of ['project', 'workspace', 'session', 'agent', 'relation', 'provider'] as const) {
      expect(daemonEventAffectsAgentSessionProjection(upserted(entityType))).toBe(true);
    }
  });

  it('ignores upserts of other entity types', () => {
    expect(daemonEventAffectsAgentSessionProjection(upserted('turn'))).toBe(false);
  });

  it('refreshes for archives and runtime recovery', () => {
    expect(daemonEventAffectsAgentSessionProjection({
      ...base,
      kind: 'entity.archived',
      payload: { entityType: 'session', entityId: 'chat' },
    })).toBe(true);
    expect(daemonEventAffectsAgentSessionProjection({
      ...base,
      kind: 'runtime.recovery',
      payload: { mode: 'normal' },
    })).toBe(true);
  });
});
