import { describe, expect, it } from 'vitest';

import type { DaemonSession } from '../shared/daemon-protocol';
import { AgentUsageTracker } from './agent-usage-tracker';

function session(id: string, extra: Partial<DaemonSession> = {}): DaemonSession {
  return {
    id,
    projectId: 'project',
    workspaceId: 'workspace',
    kind: 'agent',
    title: id,
    state: 'idle',
    source: 'structured',
    revision: 1,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    ...extra,
  } as DaemonSession;
}

const weekly = { usedPercent: 26, resetsAt: 5_000 };

describe('AgentUsageTracker', () => {
  it('shows nothing until a conversation finishes a reply', () => {
    const tracker = new AgentUsageTracker(() => 100);
    tracker.observe('codex', { limits: { weekly } });
    expect(tracker.snapshot([session('a')])).toBeUndefined();

    tracker.observe('codex', { sessionId: 'a', contextPercent: 3 });
    expect(tracker.snapshot([session('a')])).toEqual({ a: { weekly, contextPercent: 3, observedAt: 100 } });
  });

  it('moves account limits to every conversation of the same provider only', () => {
    const tracker = new AgentUsageTracker(() => 1);
    tracker.observe('codex', { sessionId: 'a', contextPercent: 3 });
    tracker.observe('claude', { sessionId: 'b', contextPercent: 9 });
    tracker.observe('codex', { limits: { weekly, fiveHour: null } });

    const usage = tracker.snapshot([session('a'), session('b')]);
    expect(usage?.a).toEqual({ weekly, contextPercent: 3, observedAt: 1 });
    expect(usage?.b).toEqual({ contextPercent: 9, observedAt: 1 });
  });

  it('drops a window the provider reports as absent and keeps one it did not mention', () => {
    const tracker = new AgentUsageTracker(() => 1);
    const fiveHour = { usedPercent: 12 };
    tracker.observe('claude', { limits: { fiveHour, weekly } });
    tracker.observe('claude', { sessionId: 'a' });
    tracker.observe('claude', { limits: { fiveHour: null } });
    expect(tracker.snapshot([session('a')])?.a).toEqual({ weekly, observedAt: 1 });
  });

  it('keeps the last context when a reply reports none', () => {
    const tracker = new AgentUsageTracker(() => 1);
    tracker.observe('claude', { sessionId: 'a', contextPercent: 40 });
    tracker.observe('claude', { sessionId: 'a' });
    expect(tracker.snapshot([session('a')])?.a.contextPercent).toBe(40);
  });

  it('forgets archived and removed conversations', () => {
    const tracker = new AgentUsageTracker(() => 1);
    tracker.observe('claude', { sessionId: 'a', contextPercent: 1 });
    tracker.observe('claude', { sessionId: 'b', contextPercent: 2 });
    tracker.observe('claude', { sessionId: 'c', contextPercent: 3 });

    const usage = tracker.snapshot([session('a'), session('b', { state: 'archived', archivedAt: '2026-10-19T01:00:00.000Z' })]);
    expect(Object.keys(usage ?? {})).toEqual(['a']);
    expect(tracker.snapshot([session('a'), session('b'), session('c')])).toEqual({ a: { contextPercent: 1, observedAt: 1 } });
    expect(tracker.snapshot([])).toBeUndefined();
  });
});
