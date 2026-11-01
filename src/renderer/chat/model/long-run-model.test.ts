import { describe, expect, it } from 'vitest';

import { buildChatModel } from './build-chat-model';
import { resumesByItself } from '../../../shared/long-run';
import { landSteer, LONG_SESSION, limitStory, steerStory, type LongRunFixture } from '../long-run/long-run-fixtures';

const model = ({ items, turns, approvals, rows }: LongRunFixture): ReturnType<typeof buildChatModel> => buildChatModel({ items, turns, ...(approvals ? { approvals } : {}), longRun: rows });

const kinds = (fixture: LongRunFixture): readonly string[] => model(fixture).rows.map((row) => row.kind);

describe('long-run rows in the chat model', () => {
  it('shows nothing of them without the draft input: the same items are a plain conversation', () => {
    const { items, turns } = limitStory('ko', 'resumed');
    const rows = buildChatModel({ items, turns }).rows;
    expect(rows.some((row) => row.kind === 'usage-limit')).toBe(false);
    const sent = rows.find((row) => row.kind === 'user' && row.text === 'Continue.');
    expect(sent && 'origin' in sent ? sent.origin : undefined).toBeUndefined();
  });

  it('puts the card after the stopped turn\'s last message', () => {
    const list = kinds(limitStory('ko', 'waiting'));
    expect(list.at(-1)).toBe('usage-limit');
    expect(list.at(-2)).toBe('assistant');
  });

  it('keeps one card, after the last refused try, under the same id', () => {
    const waiting = model(limitStory('ko', 'waiting')).rows.find((row) => row.kind === 'usage-limit');
    const rows = model(limitStory('ko', 'gave-up')).rows;
    const cards = rows.filter((row) => row.kind === 'usage-limit');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.id).toBe(waiting?.id);
    expect(rows.at(-1)?.kind).toBe('usage-limit');
  });

  it('marks what the app sent, why, and leaves the person\'s own rows alone', () => {
    const rows = model(limitStory('ko', 'resumed')).rows.filter((row) => row.kind === 'user');
    expect(rows.map((row) => (row.kind === 'user' ? row.origin : undefined))).toEqual([undefined, 'app-resume']);
    expect(rows[1]).toMatchObject({ text: 'Continue.', appSent: 'scheduled-time' });
  });

  it('marks a landed message at its real place, between the tool before it and the work after', () => {
    const rows = model(steerStory('ko', 'landed')).rows;
    const index = rows.findIndex((row) => row.kind === 'user' && row.steer !== undefined);
    expect(index).toBeGreaterThan(0);
    expect(rows[index - 1]?.kind).toBe('activity');
    expect(rows[index + 1]?.kind).toBe('assistant');
  });

  it('says a landed message dropped text only when text was being written', () => {
    const steer = (variant: 'landed' | 'landed-rewritten'): unknown => model(steerStory('ko', variant)).rows.flatMap((row) => (row.kind === 'user' && row.steer ? [row.steer] : []))[0];
    expect(steer('landed')).toEqual({});
    expect(steer('landed-rewritten')).toEqual({ rewritten: true });
  });

  it('keeps the promise of what was holding a message when it lands', () => {
    const held = (behind: 'tool' | 'text', provider: 'claude' | 'codex'): unknown => {
      const fixture: LongRunFixture = { ...steerStory('ko', 'busy'), steered: [{ id: 'm', text: '그 파일만', state: 'on-its-way', sentAt: '2026-11-01T05:50:00.000Z', behind }] };
      return [...(landSteer(fixture, 'm', provider).rows.landed?.values() ?? [])][0];
    };
    expect(held('text', 'codex')).toEqual({ rewritten: true });
    expect(held('tool', 'codex')).toEqual({});
    expect(held('text', 'claude')).toEqual({ newTurn: true });
    expect(held('tool', 'claude')).toEqual({});
  });

  it('draws a message sent during Claude\'s text as its own turn, after that text ended its turn', () => {
    const fixture = steerStory('ko', 'landed-new-turn');
    const rows = model(fixture).rows;
    const landed = rows.find((row) => row.kind === 'user' && row.steer !== undefined);
    expect(landed).toMatchObject({ steer: { newTurn: true } });
    const first = rows.find((row) => row.kind === 'user');
    expect(landed?.turnId).not.toBe(first?.turnId);
    expect(fixture.turns.find((turn) => turn.id === first?.turnId)?.state).toBe('completed');
  });

  it('drops text Codex threw away when an empty final row replaces it', () => {
    const row = { sessionId: 's', turnId: 't', messageId: 'm', kind: 'assistant-message' as const, isSensitive: true, createdAt: '2026-11-01T00:00:00.000Z' };
    const { rows } = buildChatModel({ items: [
      { ...row, id: 'delta', sequence: 1, text: 'Half an answ', isDelta: true },
      { ...row, id: 'dropped', sequence: 2, text: '', isDelta: false },
    ], turns: [] });
    expect(rows.filter((entry) => entry.kind === 'assistant')).toEqual([]);
  });

  it('holds a message that has not landed out of the transcript', () => {
    const fixture = steerStory('ko', 'on-its-way');
    const text = fixture.steered?.[0]?.text;
    expect(text).toBeTruthy();
    expect(model(fixture).rows.some((row) => row.kind === 'user' && row.text === text)).toBe(false);
  });

  it('keeps a message the limit caught after it landed, marked, with the card after it', () => {
    const rows = model(steerStory('ko', 'landed-then-limit')).rows;
    const landed = rows.find((row) => row.kind === 'user' && row.steer !== undefined);
    expect(landed).toMatchObject({ steer: { refused: true } });
    expect(rows.at(-1)?.kind).toBe('usage-limit');
  });

  it('shows a refused message of the person\'s as a row, then the one card', () => {
    const rows = model(limitStory('ko', 'person-refused')).rows;
    const users = rows.filter((row) => row.kind === 'user');
    expect(users).toHaveLength(2);
    expect(rows.filter((row) => row.kind === 'usage-limit')).toHaveLength(1);
    expect(rows.at(-1)?.kind).toBe('usage-limit');
    expect(rows.filter((row) => row.kind === 'turn-status').map((row) => (row.kind === 'turn-status' ? row.limited : undefined))).toEqual(['stopped', 'refused']);
  });

  it('tells the card an approval waits', () => {
    const card = model(limitStory('ko', 'skipped')).rows.find((row) => row.kind === 'usage-limit');
    expect(card).toMatchObject({ approvalOpen: true });
    expect(card && 'limit' in card ? card.limit.phase : undefined).toBe('skipped');
  });

  it('does not call a stop at the limit a failure', () => {
    const status = model(limitStory('ko', 'retrying')).rows.filter((row) => row.kind === 'turn-status');
    expect(status.map((row) => (row.kind === 'turn-status' ? row.limited : undefined))).toEqual(['stopped', 'refused']);
  });

  it('draws each limit the way the 6-hour rule treats it', () => {
    const limitIn = (fixture: LongRunFixture): ReturnType<typeof limitStory>['rows']['limits'] extends ReadonlyMap<string, infer L> | undefined ? L : never => [...fixture.rows.limits!.values()][0]!;
    const decided = (fixture: LongRunFixture): boolean => {
      const limit = limitIn(fixture);
      return resumesByItself(limit, Date.parse(limit.stoppedAt));
    };
    expect(decided(limitStory('ko', 'waiting'))).toBe(true);
    expect(decided(limitStory('ko', 'ask-reset', { window: 'weekly' }))).toBe(false);
    expect(decided(limitStory('ko', 'ask-reset', { window: 'unknown', later: true }))).toBe(false);
  });

  it('keeps fixtures in one session', () => {
    expect(limitStory('ko', 'waiting').items.every((item) => item.sessionId === LONG_SESSION)).toBe(true);
  });
});
