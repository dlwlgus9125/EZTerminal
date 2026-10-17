import { describe, expect, it } from 'vitest';

import type { DaemonSnapshot, DaemonTranscriptItem, DaemonTurn } from '../shared/daemon-protocol';
import { childProgress, finalAssistantText, latestFinishedTurn, managedChildOriginId, reportBackRequested, type TranscriptReader } from './managed-child-transcript';

const NOW = '2026-10-17T00:00:00.000Z';
const row = (sequence: number, overrides: Partial<DaemonTranscriptItem> = {}): DaemonTranscriptItem => ({
  id: `row-${sequence}`, sessionId: 'child', sequence, kind: 'assistant-message', text: `answer ${sequence}`,
  isDelta: false, isSensitive: true, createdAt: NOW, ...overrides,
}) as DaemonTranscriptItem;
const reader = (items: readonly DaemonTranscriptItem[]): TranscriptReader => (_sessionId, after, limit) => items.filter((item) => item.sequence > after).slice(0, limit);

describe('managed child transcript', () => {
  it('keeps the origin id persisted rows already carry', () => {
    expect(managedChildOriginId('reviewer')).toBe('managed-child-origin-2d70999ae1805e4bcef9b4ab3a4b827f');
  });

  it('reads the last complete answer of a turn across pages, ignoring deltas, blanks and other turns', () => {
    const items = [
      ...Array.from({ length: 2_500 }, (_, index) => row(index + 1, { turnId: 'other' })),
      row(2_501, { turnId: 't1', text: 'First full answer.' }),
      row(2_502, { turnId: 't1', text: 'partial', isDelta: true }),
      row(2_503, { turnId: 't1', text: '   ' }),
      row(2_504, { turnId: 't1', text: 'Final answer.' }),
      row(2_505, { turnId: 't1', kind: 'user-message', text: 'Not an answer.' }),
    ];
    expect(finalAssistantText(reader(items), 'child', 't1')).toBe('Final answer.');
    expect(finalAssistantText(reader(items), 'child', 'missing')).toBeUndefined();
  });

  it('knows a child was asked to report back to this parent only', () => {
    const origin = row(1, { id: managedChildOriginId('child'), kind: 'notice', payload: { v: 1, type: 'subagent', role: 'link', parentSessionId: 'lead', reportBack: true } });
    expect(reportBackRequested(reader([origin]), 'child', 'lead')).toBe(true);
    expect(reportBackRequested(reader([origin]), 'child', 'someone-else')).toBe(false);
    expect(reportBackRequested(reader([{ ...origin, payload: { v: 1, type: 'subagent', role: 'link', parentSessionId: 'lead' } } as DaemonTranscriptItem]), 'child', 'lead')).toBe(false);
  });

  it('finds the most recently finished turn', () => {
    const turn = (id: string, finishedAt?: string): DaemonTurn => ({ id, sessionId: 'child', commandId: id, state: finishedAt ? 'completed' : 'working', revision: 1, createdAt: NOW, updatedAt: NOW, ...(finishedAt ? { finishedAt } : {}) });
    expect(latestFinishedTurn([turn('a', '2026-10-17T00:01:00.000Z'), turn('b', '2026-10-17T00:03:00.000Z'), turn('c')], 'child')?.id).toBe('b');
    expect(latestFinishedTurn([turn('c')], 'child')).toBeUndefined();
  });

  it.each([
    ['idle with nothing left', { state: 'idle' }, [], 'finished'],
    ['done', { state: 'done', queuedTurnCount: 1 }, [], 'finished'],
    ['error', { state: 'error' }, ['working'], 'finished'],
    ['queued right after creation', { state: 'queued', queuedTurnCount: 1 }, ['queued'], 'working'],
    ['starting', { state: 'starting', currentTurnId: 't' }, ['submitting'], 'working'],
    ['working', { state: 'working', currentTurnId: 't' }, ['working'], 'working'],
    ['delivery unconfirmed', { state: 'delivery-uncertain', currentTurnId: 't' }, ['delivery-uncertain'], 'working'],
    ['idle but a turn is still unsettled', { state: 'idle' }, ['delivery-uncertain'], 'working'],
    ['waiting for an approval', { state: 'blocked', currentTurnId: 't' }, ['blocked'], 'needs-attention'],
  ] as const)('reads a child that is %s', (_label, agent, turnStates, expected) => {
    const snapshot = {
      agents: [{ sessionId: 'child', queuedTurnCount: 0, ...agent }],
      turns: turnStates.map((state, index) => ({ id: `t${index}`, sessionId: 'child', state })),
    } as unknown as DaemonSnapshot;
    expect(childProgress(snapshot, 'child')).toBe(expected);
  });
});
