import { describe, expect, it } from 'vitest';

import { CONVERSATION_VIEWS_KEY, MAX_CONVERSATION_VIEWS, noteConversationViewed, readConversationViews } from './conversation-views';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('conversation views', () => {
  it('starts from the inbox marks the first time and then keeps its own record', () => {
    const storage = memoryStorage({
      'ezterminal:app-chat-inbox:v1': JSON.stringify({ epoch: '2026-10-01T00:00:00.000Z', sessions: { a: '2026-10-02T00:00:00.000Z', bad: 'x' } }),
    });
    expect(readConversationViews(storage)).toEqual({ a: '2026-10-02T00:00:00.000Z' });
    storage.setItem('ezterminal:app-chat-inbox:v1', JSON.stringify({ sessions: { b: '2026-10-03T00:00:00.000Z' } }));
    expect(readConversationViews(storage)).toEqual({ a: '2026-10-02T00:00:00.000Z' });
  });

  it('records a view and skips repeats within a few seconds', () => {
    const storage = memoryStorage();
    const first = new Date('2026-10-27T10:00:00.000Z');
    expect(noteConversationViewed('s', first, storage)).toEqual({ s: first.toISOString() });
    expect(noteConversationViewed('s', new Date(first.getTime() + 1_000), storage).s).toBe(first.toISOString());
    const later = new Date(first.getTime() + 6_000);
    expect(noteConversationViewed('s', later, storage).s).toBe(later.toISOString());
  });

  it('always records a switch to another conversation, so the latest one wins', () => {
    const storage = memoryStorage();
    const start = new Date('2026-10-27T10:00:00.000Z').getTime();
    noteConversationViewed('a', new Date(start), storage);
    noteConversationViewed('b', new Date(start + 1_000), storage);
    const views = noteConversationViewed('a', new Date(start + 2_000), storage);
    expect(views.a).toBe(new Date(start + 2_000).toISOString());
    expect(Object.entries(views).sort((l, r) => r[1].localeCompare(l[1]))[0]![0]).toBe('a');
  });

  it('keeps the newest views only and survives a broken record', () => {
    const sessions = Object.fromEntries(Array.from({ length: MAX_CONVERSATION_VIEWS + 5 }, (_, index) => [
      `s${index}`, new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    ]));
    const storage = memoryStorage({ [CONVERSATION_VIEWS_KEY]: JSON.stringify({ sessions }) });
    const views = noteConversationViewed('new', new Date('2027-01-01T00:00:00.000Z'), storage);
    expect(Object.keys(views)).toHaveLength(MAX_CONVERSATION_VIEWS);
    expect(views.new).toBeDefined();
    expect(views.s0).toBeUndefined();

    const broken = memoryStorage({ [CONVERSATION_VIEWS_KEY]: '{oops' });
    expect(readConversationViews(broken)).toEqual({});
  });
});
