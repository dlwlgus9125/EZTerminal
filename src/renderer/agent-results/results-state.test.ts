// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeFileChanges } from '../../shared/conversation-changes';
import type { DaemonTranscriptItem } from '../../shared/daemon-protocol';
import { backfillConversationChanges } from './history-backfill';
import { markResultsDismissed, readResultsTabPrefs, resetResultsTabPrefsForTests } from './results-prefs';
import {
  publishResultsDock,
  publishResultsSession,
  readResultsNavigation,
  readResultsSource,
  requestResultsNavigation,
  resetResultsSourcesForTests,
  retractResultsSource,
  subscribeResultsSource,
  type ResultsDockPart,
} from './results-source-store';

describe('results tab preferences', () => {
  beforeEach(() => { localStorage.clear(); resetResultsTabPrefsForTests(); });

  it('remembers that the person closed it, per conversation, across a reload', () => {
    expect(readResultsTabPrefs('s1')).toEqual({ dismissed: false });
    markResultsDismissed('s1');
    resetResultsTabPrefsForTests();
    expect(readResultsTabPrefs('s1')).toEqual({ dismissed: true });
    expect(readResultsTabPrefs('s2')).toEqual({ dismissed: false });
  });

  it('ignores a corrupt store and keeps working when storage fails', () => {
    localStorage.setItem('ezterminal.agent.results-tab.v1', '{nope');
    expect(readResultsTabPrefs('s1').dismissed).toBe(false);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    markResultsDismissed('s1');
    expect(readResultsTabPrefs('s1').dismissed).toBe(true);
    setItem.mockRestore();
  });

  it('keeps only the newest 500 conversations', () => {
    for (let index = 0; index < 505; index += 1) markResultsDismissed(`s${String(index)}`);
    resetResultsTabPrefsForTests();
    expect(readResultsTabPrefs('s0').dismissed).toBe(false);
    expect(readResultsTabPrefs('s504').dismissed).toBe(true);
  });
});

describe('results source store', () => {
  afterEach(() => resetResultsSourcesForTests());
  const dock = (sessionId: string): ResultsDockPart => ({
    sessionId, title: 'T', providerLabel: 'Codex', items: [], children: [], transcriptFloor: 0, loaded: true,
    baselineSequence: 0, historyOnly: false, turnActive: false,
  });

  it('merges what the dock panel and the conversation panel publish, and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeResultsSource('agent-session-1', listener);
    const insert = vi.fn();
    publishResultsDock('agent-session-1', dock('a'));
    publishResultsSession('agent-session-1', { insertIntoDraft: insert });
    expect(readResultsSource('agent-session-1')).toMatchObject({ ownerPanelId: 'agent-session-1', sessionId: 'a', insertIntoDraft: insert });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    publishResultsDock('agent-session-1', dock('a'));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('drops the previous conversation panel part when the tab starts a new conversation', () => {
    publishResultsDock('p', dock('a'));
    publishResultsSession('p', { insertIntoDraft: vi.fn() });
    publishResultsDock('p', dock('b'));
    expect(readResultsSource('p')?.insertIntoDraft).toBeUndefined();
    expect(readResultsSource('p')?.sessionId).toBe('b');
  });

  it('retracts on close and carries navigation requests with an increasing sequence', () => {
    publishResultsDock('p', dock('a'));
    requestResultsNavigation('p', { section: 'changes', turnId: 't' });
    const first = readResultsNavigation('p')!;
    requestResultsNavigation('p', { section: 'files', path: 'a.ts' });
    expect(readResultsNavigation('p')!.sequence).toBeGreaterThan(first.sequence);
    retractResultsSource('p');
    expect(readResultsSource('p')).toBeUndefined();
  });
});

describe('history backfill', () => {
  const change = (sequence: number): DaemonTranscriptItem => ({
    id: `i${String(sequence)}`, sessionId: 's', turnId: 't', sequence, kind: 'tool-result', isDelta: false, isSensitive: false,
    createdAt: '2026-10-20T00:00:00Z', text: encodeFileChanges([{ path: `f${String(sequence)}.ts`, patch: '@@ -1,1 +1,1 @@\n-a\n+b', coverage: 'patch' }])!,
  });
  const note = (sequence: number): DaemonTranscriptItem => ({ ...change(sequence), kind: 'assistant-message', text: 'hi' });

  it('reads every earlier page up to the floor and keeps only change records', async () => {
    const all = Array.from({ length: 1200 }, (_, index) => (index % 400 === 0 ? change(index + 1) : note(index + 1)));
    const readPage = vi.fn(async (after: number, limit: number) => all.filter((item) => item.sequence > after).slice(0, limit));
    const progress = vi.fn();
    const changes = await backfillConversationChanges({ sessionId: 's', floor: 1100, readPage, onProgress: progress });
    expect(changes.map((entry) => entry.path)).toEqual(['f1.ts', 'f401.ts', 'f801.ts']);
    expect(readPage.mock.calls).toEqual([[0, 500], [500, 500], [1000, 100]]);
    expect(progress).toHaveBeenLastCalledWith({ loaded: 1100, total: 1100 });
  });

  it('fails on a sequence gap and stops when cancelled', async () => {
    await expect(backfillConversationChanges({ sessionId: 's', floor: 3, readPage: async () => [change(1), change(3)] }))
      .rejects.toThrow(/gap/u);
    const controller = new AbortController();
    controller.abort();
    await expect(backfillConversationChanges({ sessionId: 's', floor: 3, readPage: async () => [], signal: controller.signal }))
      .rejects.toThrow(/cancelled/u);
  });
});
