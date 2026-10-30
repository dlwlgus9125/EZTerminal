import { describe, expect, it } from 'vitest';

import type { DaemonTranscriptItem } from '../../../shared/daemon-protocol';
import { suggestedTaskChildSessionId } from '../../../shared/turn-wrap-up';
import { applyWrapUpAction, cartStory, formatStory, WAITING_DECISION_ID, waitingStory, WRAP_SESSION } from '../wrap-up/wrap-up-fixtures';
import { buildChatModel } from './build-chat-model';
import type { ChatRow } from './types';

function kinds(rows: readonly ChatRow[]): string[] {
  return rows.map((row) => row.kind);
}

function toolNames(rows: readonly ChatRow[]): string[] {
  return rows.flatMap((row) => (row.kind === 'activity' ? row.entries.flatMap((entry) => (entry.kind === 'tool' ? [entry.tool.name] : [])) : []));
}

function taskCard(rows: readonly ChatRow[]): Extract<ChatRow, { kind: 'task-suggestions' }> {
  const card = rows.find((row) => row.kind === 'task-suggestions');
  if (card?.kind !== 'task-suggestions') throw new Error('No task card.');
  return card;
}

function recapRow(rows: readonly ChatRow[]): Extract<ChatRow, { kind: 'recap' }> {
  const row = rows.find((entry) => entry.kind === 'recap');
  if (row?.kind !== 'recap') throw new Error('No recap.');
  return row;
}

const outcome = (rows: readonly ChatRow[], index: number) => taskCard(rows).suggestions.tasks[index]!.outcome;

describe('turn wrap-up rows', () => {
  it('builds the cards from the host’s rows: tasks, then the recap, after the turn’s last message and its change card', () => {
    const fixture = cartStory('ko', 'claude');
    const recap: DaemonTranscriptItem = {
      id: 'recap-row', sessionId: WRAP_SESSION, sequence: 900, kind: 'notice', text: 'Fixed the cart loop.', isDelta: false, isSensitive: true, turnId: 'turn-cart', createdAt: fixture.turns[0]!.finishedAt!,
      payload: { v: 1, type: 'recap', turnId: 'turn-cart', providerId: 'claude', trigger: 'unattended', state: 'complete', text: 'Fixed the cart loop.' },
    };
    const model = buildChatModel({ items: [...fixture.items, recap], turns: fixture.turns });
    expect(kinds(model.rows).slice(-4)).toEqual(['assistant', 'changes', 'task-suggestions', 'recap']);
    expect(taskCard(model.rows).suggestions.tasks.map((task) => task.title)).toEqual([
      'Fix the always-true role check in src/auth.ts', 'Fix cents-to-dollars conversion in src/format.ts', 'Fix percentage math in applyDiscount (src/discount.ts)',
    ]);
    expect(taskCard(model.rows).suggestions.providerId).toBe('claude');
    expect(recapRow(model.rows).recap).toMatchObject({ turnId: 'turn-cart', trigger: 'unattended', state: 'complete', text: 'Fixed the cart loop.' });
  });

  it('never shows a wrap-up row as a notice', () => {
    for (const fixture of [cartStory('en', 'claude', 'states'), cartStory('en', 'claude', 'cap'), formatStory('en', 'claude'), formatStory('en', 'claude', { recap: 'failed', failure: 'no-response' })]) {
      expect(kinds(buildChatModel({ items: fixture.items, turns: fixture.turns }).rows)).not.toContain('notice');
    }
  });

  it('folds the AI’s suggest_task calls into the card, for both AIs’ tool names', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const fixture = cartStory('en', provider);
      expect(toolNames(buildChatModel({ items: fixture.items, turns: fixture.turns }).rows)).toEqual(['Read', 'Read', 'Read', 'Read', 'Edit']);
      // Without a card (a client of an older host, every call refused) the calls stay ordinary tool rows: nothing the AI did is hidden.
      const withoutCards = fixture.items.filter((item) => item.payload?.type !== 'task-suggestion');
      expect(toolNames(buildChatModel({ items: withoutCards, turns: fixture.turns }).rows).filter((name) => name.endsWith('suggest_task'))).toHaveLength(3);
    }
  });

  it('folds a call that came before its row, and keeps the tool run in one piece', () => {
    const fixture = cartStory('en', 'claude');
    const model = buildChatModel({ items: fixture.items, turns: fixture.turns });
    expect(kinds(model.rows).filter((kind) => kind === 'activity')).toHaveLength(1);
    expect(model.rows.some((row) => row.kind === 'activity' && row.entries.some((entry) => entry.kind === 'tool' && entry.tool.name.endsWith('suggest_task')))).toBe(false);
  });

  it('shows nothing for a card whose turn is not among the loaded rows', () => {
    const fixture = formatStory('ko', 'claude');
    const moved = fixture.items.map((item) => (item.payload?.type === 'recap' ? { ...item, turnId: 'turn-elsewhere', payload: { ...item.payload, turnId: 'turn-elsewhere' } } : item));
    expect(kinds(buildChatModel({ items: moved, turns: fixture.turns }).rows)).not.toContain('recap');
  });

  it('pins the cards to the turn’s final run: a row without a turn does not split them off mid-turn', () => {
    const fixture = cartStory('en', 'claude');
    const index = fixture.items.findIndex((item) => item.kind === 'assistant-message');
    const before = fixture.items[index]!;
    const split: DaemonTranscriptItem = {
      id: 'split', sessionId: before.sessionId, sequence: before.sequence - 1, kind: 'child-summary', text: 'A child reported.', isDelta: false, isSensitive: false, createdAt: before.createdAt,
    };
    const model = buildChatModel({ items: [...fixture.items, split], turns: fixture.turns });
    const names = kinds(model.rows);
    expect(names.indexOf('child')).toBeLessThan(names.indexOf('task-suggestions'));
    expect(names.filter((kind) => kind === 'task-suggestions')).toHaveLength(1);
    expect(names.indexOf('assistant')).toBeLessThan(names.indexOf('task-suggestions'));
  });

  it('takes the latest row of a recap: generating, then the card', () => {
    const fixture = formatStory('en', 'claude', { recap: 'failed', failure: 'no-response', suggestion: false });
    const retrying = applyWrapUpAction(fixture, { kind: 'recap-retry', turnId: 'turn-fix' }, false);
    expect(recapRow(buildChatModel({ items: retrying.items, turns: retrying.turns }).rows).recap.state).toBe('generating');
    const done = applyWrapUpAction(retrying, { kind: 'recap-retry', turnId: 'turn-fix' }, true);
    expect(recapRow(buildChatModel({ items: done.items, turns: done.turns }).rows).recap).toMatchObject({ state: 'complete', trigger: 'unattended' });
    expect(kinds(buildChatModel({ items: done.items, turns: done.turns }).rows).filter((kind) => kind === 'recap')).toHaveLength(1);
  });

  it('says the AI waits only while the decision it stopped for is pending, and keeps the card before the live turn status', () => {
    const fixture = waitingStory('en');
    const waiting = buildChatModel({ items: fixture.items, turns: fixture.turns, approvals: fixture.approvals! });
    expect(recapRow(waiting.rows).waitingNow).toBe(true);
    expect(kinds(waiting.rows).slice(-2)).toEqual(['recap', 'turn-status']);
    const answered = buildChatModel({ items: fixture.items, turns: fixture.turns, approvals: fixture.approvals!.map((approval) => ({ ...approval, state: 'allowed' as const })) });
    expect(recapRow(answered.rows).waitingNow).toBeFalsy();
  });

  it('ties the wait to the decision the recap stopped for, not to any approval', () => {
    const fixture = waitingStory('en');
    const [question] = fixture.approvals!;
    // Its question was answered; a later turn asks something else. The old recap must not read as waiting again.
    const approvals = [{ ...question!, state: 'allowed' as const }, { ...question!, id: 'approval-later', turnId: 'turn-later' }];
    const model = buildChatModel({ items: fixture.items, turns: fixture.turns, approvals });
    expect(recapRow(model.rows).recap.decisionId).toBe(WAITING_DECISION_ID);
    expect(recapRow(model.rows).waitingNow).toBeFalsy();
  });

  it('reads each task’s outcome from its latest row', () => {
    const fixture = cartStory('ko', 'claude', 'states');
    const { rows } = buildChatModel({ items: fixture.items, turns: fixture.turns });
    expect(outcome(rows, 0)).toEqual({ kind: 'started', sessionId: 'wrap-up-child-auth' });
    expect(outcome(rows, 2)).toEqual({ kind: 'dismissed' });
    expect(outcome(rows, 3)).toMatchObject({ kind: 'start-failed', reason: '같은 이름의 브랜치가 이미 있습니다.', branchTaken: true, start: { where: { kind: 'new-worktree' } } });
    const reopened = applyWrapUpAction(fixture, { kind: 'task-reopen', turnId: 'turn-cart', taskId: 'task-claude-3' }, false);
    expect(outcome(buildChatModel({ items: reopened.items, turns: reopened.turns }).rows, 2)).toEqual({ kind: 'open' });
  });

  it('keeps the branch of a task started in a new worktree', () => {
    const fixture = cartStory('en', 'claude');
    const started = applyWrapUpAction(fixture, { kind: 'task-start-all', turnId: 'turn-cart', starts: [{ taskId: 'task-claude-1', where: { kind: 'new-worktree', branch: 'suggest/auth' } }] }, true);
    expect(outcome(buildChatModel({ items: started.items, turns: started.turns }).rows, 0)).toEqual({ kind: 'started', sessionId: suggestedTaskChildSessionId('task-claude-1'), branch: 'suggest/auth' });
  });

  it('counts the tasks left out past the cap', () => {
    const fixture = cartStory('en', 'claude', 'cap');
    expect(taskCard(buildChatModel({ items: fixture.items, turns: fixture.turns }).rows).suggestions).toMatchObject({ dropped: 3 });
  });

  describe('여기서 하기', () => {
    const sent = (state: 'working' | 'queued' | 'completed' | 'failed' | 'interrupted') => {
      const fixture = cartStory('en', 'claude');
      const here = applyWrapUpAction(fixture, { kind: 'task-here', turnId: 'turn-cart', taskId: 'task-claude-2' }, false);
      return { items: here.items, turns: here.turns.map((turn) => (turn.id.startsWith('turn-here') ? { ...turn, state } : turn)) };
    };

    it('reads as sent while its turn runs and once it ended', () => {
      expect(outcome(buildChatModel(sent('working')).rows, 1)).toEqual({ kind: 'sent' });
      expect(outcome(buildChatModel(sent('completed')).rows, 1)).toEqual({ kind: 'sent' });
    });

    it('reads as queued with its place among the queued turns', () => {
      const fixture = cartStory('ko', 'claude', 'states');
      expect(outcome(buildChatModel({ items: fixture.items, turns: fixture.turns }).rows, 1)).toEqual({ kind: 'queued', position: 2 });
      expect(outcome(buildChatModel(sent('queued')).rows, 1)).toEqual({ kind: 'queued', position: 1 });
    });

    it('stops counting once it failed or was taken back: the task can be sent again', () => {
      expect(outcome(buildChatModel(sent('failed')).rows, 1)).toEqual({ kind: 'open' });
      expect(outcome(buildChatModel(sent('interrupted')).rows, 1)).toEqual({ kind: 'open' });
    });

    it('falls back to the failed start behind it, with its reason', () => {
      const fixture = cartStory('en', 'claude', 'retry');
      const here = applyWrapUpAction(fixture, { kind: 'task-here', turnId: 'turn-cart', taskId: 'task-claude-2' }, false);
      const taken = here.turns.map((turn) => (turn.id.startsWith('turn-here') ? { ...turn, state: 'interrupted' as const } : turn));
      expect(outcome(buildChatModel({ items: here.items, turns: taken }).rows, 1)).toMatchObject({ kind: 'start-failed' });
    });

    it('leaves the send row an ordinary message of the person’s', () => {
      const { rows } = buildChatModel(sent('working'));
      const row = rows.find((entry) => entry.kind === 'user' && entry.turnId?.startsWith('turn-here'));
      expect(row?.kind === 'user' && row.origin).toBeFalsy();
    });
  });
});
