import { describe, expect, it } from 'vitest';

import type { DaemonAgent, DaemonSession, DaemonSnapshot } from '../shared/daemon-protocol';
import { AgentUsageTracker, parsePersistedAgentUsage } from './agent-usage-tracker';

const TIMESTAMP = '2026-10-20T00:00:00.000Z';

function session(id: string, extra: Partial<DaemonSession> = {}): DaemonSession {
  return {
    id, projectId: 'project', workspaceId: 'workspace', kind: 'agent', title: id, state: 'idle', source: 'structured',
    revision: 1, createdAt: TIMESTAMP, updatedAt: TIMESTAMP, ...extra,
  } as DaemonSession;
}

function agent(sessionId: string, providerId: string): DaemonAgent {
  return {
    sessionId, providerId, permissionPreset: 'standard', state: 'idle', queuedTurnCount: 0, orchestrationEnabled: true,
    revision: 1, createdAt: TIMESTAMP, updatedAt: TIMESTAMP,
  } as DaemonAgent;
}

function snapshotOf(...entries: readonly (readonly [string, string, Partial<DaemonSession>?])[]): Pick<DaemonSnapshot, 'sessions' | 'agents'> {
  return {
    sessions: entries.map(([id, , extra]) => session(id, extra)),
    agents: entries.map(([id, providerId]) => agent(id, providerId)),
  };
}

const weekly = { usedPercent: 26, resetsAt: 5_000 };

describe('AgentUsageTracker', () => {
  it('shows an AI\'s limits in every conversation of that AI before any reply, and per AI for a new conversation', () => {
    let now = 100;
    const tracker = new AgentUsageTracker(() => now);
    expect(tracker.observe('codex', { limits: { weekly, fiveHour: null } })).toBe(true);

    expect(tracker.snapshot(snapshotOf(['a', 'codex'], ['b', 'claude']))).toEqual({
      agentUsage: { a: { weekly, limitsObservedAt: 100 } },
      providerUsage: { codex: { weekly, limitsObservedAt: 100 } },
    });

    now = 200;
    expect(tracker.observe('codex', { sessionId: 'a', contextPercent: 3 })).toBe(true);
    expect(tracker.snapshot(snapshotOf(['a', 'codex'])).agentUsage).toEqual({
      a: { weekly, limitsObservedAt: 100, contextPercent: 3, contextObservedAt: 200 },
    });
  });

  it('reports a change only when the shown numbers move or the reading is a minute newer', () => {
    let now = 0;
    const tracker = new AgentUsageTracker(() => now);
    expect(tracker.observe('claude', { limits: { weekly } })).toBe(true);
    now = 30_000;
    expect(tracker.observe('claude', { limits: { weekly } })).toBe(false);
    expect(tracker.observe('claude', { limits: { weekly: { ...weekly, usedPercent: 27 } } })).toBe(true);
    now = 100_000;
    expect(tracker.observe('claude', { limits: { weekly: { ...weekly, usedPercent: 27 } } })).toBe(true);
    expect(tracker.observe('claude', { sessionId: 'a', contextPercent: 5 })).toBe(true);
    expect(tracker.observe('claude', { sessionId: 'a', contextPercent: 5 })).toBe(false);
    expect(tracker.observe('claude', { sessionId: 'a' })).toBe(false);
  });

  it('drops a window the provider reports as absent and keeps one it did not mention', () => {
    const tracker = new AgentUsageTracker(() => 1);
    tracker.observe('claude', { limits: { fiveHour: { usedPercent: 12 }, weekly } });
    tracker.observe('claude', { limits: { fiveHour: null } });
    expect(tracker.snapshot(snapshotOf(['a', 'claude'])).agentUsage?.a).toEqual({ weekly, limitsObservedAt: 1 });
  });

  it('forgets archived and removed conversations and survives a restart', () => {
    const tracker = new AgentUsageTracker(() => 7);
    tracker.observe('claude', { limits: { weekly } });
    tracker.observe('claude', { sessionId: 'a', contextPercent: 1 });
    tracker.observe('claude', { sessionId: 'b', contextPercent: 2 });
    tracker.observe('claude', { sessionId: 'c', contextPercent: 3 });

    const usage = tracker.snapshot(snapshotOf(['a', 'claude'], ['b', 'claude', { state: 'archived', archivedAt: TIMESTAMP }])).agentUsage;
    expect(Object.keys(usage ?? {})).toEqual(['a']);
    const saved = JSON.parse(JSON.stringify(tracker.serialize()));
    expect(Object.keys(saved.contexts)).toEqual(['a']);

    const restarted = new AgentUsageTracker();
    restarted.restore(saved);
    expect(restarted.snapshot(snapshotOf(['a', 'claude'])).agentUsage).toEqual({
      a: { weekly, limitsObservedAt: 7, contextPercent: 1, contextObservedAt: 7 },
    });
  });

  it('ignores a persisted file it did not write', () => {
    expect(parsePersistedAgentUsage({ version: 2, providers: {}, contexts: {} })).toBeUndefined();
    expect(parsePersistedAgentUsage({
      version: 1,
      providers: { codex: { weekly: { usedPercent: 400 }, observedAt: 1 }, claude: 'x' },
      contexts: { a: { percent: Number.NaN, observedAt: 1 }, b: { percent: 4, observedAt: 2 } },
    })).toEqual({ version: 1, providers: { codex: { observedAt: 1 } }, contexts: { b: { percent: 4, observedAt: 2 } } });
    const tracker = new AgentUsageTracker();
    tracker.restore('not usage');
    expect(tracker.snapshot(snapshotOf(['a', 'codex']))).toEqual({});
  });
});
