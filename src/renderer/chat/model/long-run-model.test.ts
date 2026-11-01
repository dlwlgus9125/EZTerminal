import { describe, expect, it } from 'vitest';

import { buildChatModel } from './build-chat-model';
import { latestLimit } from './long-run-rows';
import { resumesByItself, USAGE_LIMIT_PHASES } from '../../../shared/long-run';
import { conversationQueue } from '../../conversation-queue';
import { landSteer, LIMIT_STOP, LONG_SESSION, limitStory, steerStory, type LongRunFixture, type SteerVariant } from '../long-run/long-run-fixtures';

const model = ({ items, turns, approvals }: LongRunFixture, line?: LongRunFixture['line']): ReturnType<typeof buildChatModel> => {
  const limit = latestLimit(items);
  return buildChatModel({ items, turns, ...(approvals ? { approvals } : {}), ...(line && limit ? { openLimit: { ...limit, line } } : {}) });
};

const kinds = (fixture: LongRunFixture): readonly string[] => model(fixture).rows.map((row) => row.kind);
const card = (fixture: LongRunFixture, line?: LongRunFixture['line']) => model(fixture, line).rows.find((row) => row.kind === 'usage-limit');

describe('long-run fixtures', () => {
  const STEERS: readonly SteerVariant[] = [
    'long-messages', 'long-behind-approval', 'busy', 'writing', 'on-its-way', 'on-its-way-text', 'landed', 'landed-new-turn', 'landed-rewritten', 'landed-then-limit',
    'caught-stop', 'caught-limit', 'behind-approval', 'review-turn', 'compact-turn', 'turn-ended', 'failed', 'failed-disconnected', 'unconfirmed',
  ];
  const contiguous = ({ items }: LongRunFixture): void => {
    expect(items.map((item) => item.sequence)).toEqual(items.map((_item, index) => index + 1));
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  };

  it.each(STEERS)('steer %s numbers its rows as a host does: the tab refuses a gap', (variant) => {
    contiguous(steerStory('en', variant));
  });

  it.each(USAGE_LIMIT_PHASES)('limit %s numbers its rows as a host does', (phase) => {
    contiguous(limitStory('en', phase));
  });

  it.each(['tool', 'text'] as const)('a message landing behind %s keeps the numbers whole, on either AI', (behind) => {
    const fixture = steerStory('en', behind === 'text' ? 'on-its-way-text' : 'on-its-way');
    for (const provider of ['claude', 'codex'] as const) contiguous(landSteer(fixture, fixture.steered![0]!.id, provider));
  });
});

describe('long-run rows in the chat model', () => {
  it('reads a limit card from its row, and a conversation with no such row stays plain', () => {
    expect(card(limitStory('ko', 'waiting'))).toMatchObject({ id: `usage-limit:${LIMIT_STOP}`, limit: { phase: 'waiting', stopId: LIMIT_STOP } });
    const { items, turns } = limitStory('ko', 'waiting');
    const plain = items.filter((item) => item.payload?.type !== 'usage-limit').map((item) => ({ ...item, payload: undefined }));
    expect(buildChatModel({ items: plain, turns }).rows.some((row) => row.kind === 'usage-limit')).toBe(false);
  });

  it('does not draw the card\'s row as a notice', () => {
    expect(kinds(limitStory('ko', 'waiting'))).not.toContain('notice');
  });

  it('puts the card after the stopped turn\'s last message', () => {
    const list = kinds(limitStory('ko', 'waiting'));
    expect(list.at(-1)).toBe('usage-limit');
    expect(list.at(-2)).toBe('assistant');
  });

  it('keeps one card, after the last refused try, under the same id, from the latest row of its stop', () => {
    const fixture = limitStory('ko', 'gave-up');
    expect(fixture.items.filter((item) => item.payload?.type === 'usage-limit')).toHaveLength(3);
    const rows = model(fixture).rows;
    const cards = rows.filter((row) => row.kind === 'usage-limit');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.id).toBe(card(limitStory('ko', 'waiting'))?.id);
    expect(cards[0]).toMatchObject({ turnId: 'turn-try-2', limit: { phase: 'gave-up' } });
    expect(rows.at(-1)?.kind).toBe('usage-limit');
  });

  it('carries when the line lets it go, which no row says, to the stop it is about', () => {
    const fixture = limitStory('ko', 'waiting');
    const sendsAt = '2026-11-01T06:13:00.000Z';
    const open = { ...latestLimit(fixture.items)!, sendsAt };
    const found = (openLimit: typeof open) => buildChatModel({ items: fixture.items, turns: fixture.turns, openLimit }).rows.find((row) => row.kind === 'usage-limit');
    expect(found(open)).toMatchObject({ limit: { sendsAt } });
    expect(found({ ...open, stopId: 'another-stop' })).not.toMatchObject({ limit: { sendsAt } });
  });

  it('adds the line of sends, which no row says, to the stop it is about', () => {
    const fixture = limitStory('ko', 'waiting');
    const line = { position: 2, total: 3 };
    expect(card(fixture, line)).toMatchObject({ limit: { line } });
    const other = { ...latestLimit(fixture.items)!, stopId: 'another-stop', line };
    expect(buildChatModel({ items: fixture.items, turns: fixture.turns, openLimit: other }).rows.find((row) => row.kind === 'usage-limit')).not.toMatchObject({ limit: { line } });
  });

  it('marks what the app sent, why, and leaves the person\'s own rows alone', () => {
    const rows = model(limitStory('ko', 'resumed')).rows.filter((row) => row.kind === 'user');
    expect(rows.map((row) => (row.kind === 'user' ? row.origin : undefined))).toEqual([undefined, 'app-resume']);
    expect(rows[1]).toMatchObject({ text: 'Continue.', appSent: 'scheduled-time' });
    expect(model(limitStory('ko', 'resumed', { reason: 'try-now' })).rows.filter((row) => row.kind === 'user')[1]).toMatchObject({ appSent: 'try-now' });
  });

  it('dates a resumed card by the row that went out, not by a schedule it may never have had', () => {
    const fixture = limitStory('ko', 'resumed');
    const pressedAt = '2026-11-01T06:30:00.000Z';
    const items = fixture.items.map((item) => (item.payload?.type === 'app-sent' ? { ...item, createdAt: pressedAt } : item));
    expect(card({ ...fixture, items })).toMatchObject({ limit: { phase: 'resumed', resumeAt: pressedAt } });
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
      return model(landSteer(fixture, 'm', provider)).rows.flatMap((row) => (row.kind === 'user' && row.steer ? [row.steer] : []))[0];
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

  it('keeps a landed message that repeats the words of the row before it', () => {
    const fixture = steerStory('ko', 'landed');
    const prompt = fixture.items.find((item) => item.kind === 'user-message' && item.payload?.type !== 'steer')!;
    const items = fixture.items.map((item) => (item.payload?.type === 'steer' ? { ...item, text: prompt.text } : item));
    expect(model({ ...fixture, items }).rows.filter((row) => row.kind === 'user')).toHaveLength(2);
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

  it('reads a refused landing from its turn\'s error, with the card after it', () => {
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
    const skipped = card(limitStory('ko', 'skipped'));
    expect(skipped).toMatchObject({ approvalOpen: true });
    expect(skipped && 'limit' in skipped ? skipped.limit.phase : undefined).toBe('skipped');
  });

  it('does not call a stop at the limit a failure, on the turn that stopped or on one it refused', () => {
    const status = model(limitStory('ko', 'retrying')).rows.filter((row) => row.kind === 'turn-status');
    expect(status.map((row) => (row.kind === 'turn-status' ? row.limited : undefined))).toEqual(['stopped', 'refused']);
  });

  it('leaves a turn that failed some other way as a failure', () => {
    const fixture = limitStory('ko', 'waiting');
    const turns = fixture.turns.map((turn) => ({ ...turn, errorCode: 'provider-start-failed' }));
    const status = model({ ...fixture, turns }).rows.find((row) => row.kind === 'turn-status');
    expect(status && 'limited' in status ? status.limited : undefined).toBeUndefined();
  });

  it('draws each limit the way the 6-hour rule treats it', () => {
    const decided = (fixture: LongRunFixture): boolean => {
      const limit = latestLimit(fixture.items)!;
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

describe('a message that fell back to the queue', () => {
  it('says why from its own row', () => {
    const fixture = steerStory('ko', 'review-turn');
    expect(conversationQueue(LONG_SESSION, fixture.turns, fixture.items)).toMatchObject([{ turnId: 'turn-queued', fellBack: 'review-turn' }]);
  });

  it('says nothing for a message that was queued on purpose', () => {
    const fixture = steerStory('ko', 'review-turn');
    const items = fixture.items.map((item) => (item.payload?.type === 'steer-queued' ? { ...item, payload: undefined } : item));
    expect(conversationQueue(LONG_SESSION, fixture.turns, items)[0]?.fellBack).toBeUndefined();
  });
});
