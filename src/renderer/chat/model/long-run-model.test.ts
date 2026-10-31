import { describe, expect, it } from 'vitest';

import { buildChatModel } from './build-chat-model';
import { LONG_SESSION, limitStory, steerStory, type LongRunFixture } from '../long-run/long-run-fixtures';

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
    expect(rows[1]).toMatchObject({ text: 'Continue.', appSent: 'limit-lifted' });
  });

  it('marks a landed message at its real place, between the tool before it and the work after', () => {
    const rows = model(steerStory('ko', 'landed')).rows;
    const index = rows.findIndex((row) => row.kind === 'user' && row.steer !== undefined);
    expect(index).toBeGreaterThan(0);
    expect(rows[index - 1]?.kind).toBe('activity');
    expect(rows[index + 1]?.kind).toBe('assistant');
  });

  it('says on a landed Codex message that its text was dropped, and only there', () => {
    const steer = (provider: 'claude' | 'codex'): unknown => model(steerStory('ko', 'landed', provider)).rows.flatMap((row) => (row.kind === 'user' && row.steer ? [row.steer] : []))[0];
    expect(steer('codex')).toEqual({ rewritten: true });
    expect(steer('claude')).toEqual({});
  });

  it('holds a message that has not landed out of the transcript', () => {
    const fixture = steerStory('ko', 'on-its-way');
    const text = fixture.steered?.[0]?.text;
    expect(text).toBeTruthy();
    expect(model(fixture).rows.some((row) => row.kind === 'user' && row.text === text)).toBe(false);
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

  it('keeps fixtures in one session', () => {
    expect(limitStory('ko', 'waiting').items.every((item) => item.sessionId === LONG_SESSION)).toBe(true);
  });
});
