import { describe, expect, it } from 'vitest';

import type { DaemonTranscriptItem } from '../../../shared/daemon-protocol';
import { SUGGEST_TASK_CLAUDE_TOOL, SUGGEST_TASK_SERVER, SUGGEST_TASK_TOOL, suggestedTaskChildSessionId } from '../../../shared/turn-wrap-up';
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

/** One more tool call in the cart turn, as an adapter records it. `server`: the Codex shape, beside the name. */
function call(sequence: number, name: string, options: { readonly server?: string; readonly input?: unknown; readonly status?: 'completed' | 'failed' | 'denied' | 'interrupted' } = {}): DaemonTranscriptItem[] {
  const { server, input = { title: 'Fix the tax rounding', rationale: 'Why', prompt: 'Do it.' }, status = 'completed' } = options;
  const body = JSON.stringify(input, null, 2);
  const row = (offset: number, kind: 'tool-call' | 'tool-result', text: string, phase: 'call' | 'result', state: 'running' | typeof status): DaemonTranscriptItem => ({
    id: `extra-${String(sequence + offset)}`, sessionId: WRAP_SESSION, sequence: sequence + offset, turnId: 'turn-cart', kind, text, isDelta: false, isSensitive: false, createdAt: '2026-10-30T05:53:00.000Z',
    payload: { v: 1, type: 'tool', callId: `extra-call-${String(sequence)}`, name, category: 'mcp', phase, status: state, ...(server ? { server } : {}) },
  });
  const head = server ? `${server}/${name}: inProgress` : name;
  return [row(0, 'tool-call', `${head}\n${body}`, 'call', 'running'), row(1, 'tool-result', '{"ok":true}', 'result', status)];
}

const suggestTasksShown = (items: readonly DaemonTranscriptItem[], fixture: ReturnType<typeof cartStory>): string[] => (
  toolNames(buildChatModel({ items, turns: fixture.turns }).rows).filter((name) => name.endsWith('suggest_task'))
);

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

  it('leaves another server’s suggest_task a tool row beside the card, in both AIs’ shapes', () => {
    const fixture = cartStory('en', 'claude');
    const accepted = taskCard(buildChatModel({ items: fixture.items, turns: fixture.turns }).rows).suggestions.tasks[0]!;
    const sameWords = { input: { title: accepted.title, rationale: accepted.rationale, prompt: accepted.prompt } };
    for (const [name, options] of [
      ['mcp__other__suggest_task', {}],
      ['mcp__other__suggest_task', sameWords],
      ['suggest_task', { server: 'other' }],
      ['suggest_task', { server: 'other', ...sameWords }],
      // A bare name with no server cannot be told for the host's own.
      ['suggest_task', {}],
      ['suggest_task', sameWords],
    ] as const) {
      expect(suggestTasksShown([...fixture.items, ...call(500, name, options)], fixture), `${name} ${JSON.stringify(options)}`).toEqual([name]);
    }
  });

  it('folds the host’s own calls and nothing else of the turn', () => {
    const fixture = cartStory('en', 'codex');
    const items = [...fixture.items, ...call(500, 'mcp__other__suggest_task')];
    expect(suggestTasksShown(items, fixture)).toEqual(['mcp__other__suggest_task']);
    expect(toolNames(buildChatModel({ items, turns: fixture.turns }).rows).filter((name) => name === SUGGEST_TASK_TOOL)).toEqual([]);
  });

  it('keeps a call the host refused visible: it left no task on the card', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const fixture = cartStory('en', provider);
      const refused = provider === 'claude' ? call(500, SUGGEST_TASK_CLAUDE_TOOL, { status: 'failed' }) : call(500, SUGGEST_TASK_TOOL, { server: SUGGEST_TASK_SERVER, status: 'failed' });
      expect(suggestTasksShown([...fixture.items, ...refused], fixture)).toHaveLength(1);
      // Refused and still marked completed (an adapter that cannot tell): no task row is what counts.
      const quiet = provider === 'claude' ? call(500, SUGGEST_TASK_CLAUDE_TOOL) : call(500, SUGGEST_TASK_TOOL, { server: SUGGEST_TASK_SERVER });
      expect(suggestTasksShown([...fixture.items, ...quiet], fixture)).toHaveLength(1);
    }
  });

  it('keeps a call with a card’s words visible when it did not finish', () => {
    const fixture = cartStory('en', 'claude');
    const accepted = taskCard(buildChatModel({ items: fixture.items, turns: fixture.turns }).rows).suggestions.tasks[0]!;
    const input = { title: accepted.title, rationale: accepted.rationale, prompt: accepted.prompt };
    for (const status of ['failed', 'denied', 'interrupted'] as const) {
      expect(suggestTasksShown([...fixture.items, ...call(500, SUGGEST_TASK_CLAUDE_TOOL, { input, status })], fixture)).toHaveLength(1);
    }
    // A repeat the host answered with the same task adds nothing: it folds.
    expect(suggestTasksShown([...fixture.items, ...call(500, SUGGEST_TASK_CLAUDE_TOOL, { input })], fixture)).toEqual([]);
  });

  it('keeps a call whose input cannot be read visible', () => {
    const fixture = cartStory('en', 'claude');
    const unreadable = call(500, SUGGEST_TASK_CLAUDE_TOOL).map((row) => (row.kind === 'tool-call' ? { ...row, text: `${SUGGEST_TASK_CLAUDE_TOOL}\n{"title": "cut o` } : row));
    expect(suggestTasksShown([...fixture.items, ...unreadable], fixture)).toHaveLength(1);
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

  describe('a recap written while the AI waited', () => {
    /** A row of the stopped turn, after everything in the fixture. */
    const later = (fixture: ReturnType<typeof waitingStory>, offset: number, kind: DaemonTranscriptItem['kind'], text: string, payload?: DaemonTranscriptItem['payload']): DaemonTranscriptItem => {
      const last = fixture.items[fixture.items.length - 1]!;
      return {
        id: `later-${String(offset)}`, sessionId: WRAP_SESSION, sequence: last.sequence + offset, turnId: last.turnId!, kind, text, isDelta: false, isSensitive: false, createdAt: last.createdAt,
        ...(payload ? { payload } : {}),
      };
    };
    const tool = (callId: string, name: string, phase: 'call' | 'result', status: 'running' | 'completed'): NonNullable<DaemonTranscriptItem['payload']> => ({
      v: 1, type: 'tool', callId, name, category: name === 'AskUserQuestion' ? 'question' : 'read', phase, status,
    });
    /** The person answered and the turn ran on: one more tool line, then its last message. */
    const ranOn = (fixture: ReturnType<typeof waitingStory>) => ({
      items: [
        ...fixture.items,
        later(fixture, 1, 'tool-result', 'Parentheses', tool('call-question', 'AskUserQuestion', 'result', 'completed')),
        later(fixture, 2, 'tool-call', 'Read', tool('call-after', 'Read', 'call', 'running')),
        later(fixture, 3, 'tool-result', '1 line', tool('call-after', 'Read', 'result', 'completed')),
        later(fixture, 4, 'assistant-message', 'Finished after the answer.'),
      ],
      turns: fixture.turns.map((turn) => (turn.state === 'blocked' ? { ...turn, state: 'completed' as const, finishedAt: fixture.items[fixture.items.length - 1]!.createdAt } : turn)),
      approvals: fixture.approvals!.map((approval) => ({ ...approval, state: 'allowed' as const })),
    });

    it('stays where the AI stopped when the turn runs on below it', () => {
      const model = buildChatModel(ranOn(waitingStory('en')));
      expect(kinds(model.rows).slice(-4)).toEqual(['recap', 'activity', 'assistant', 'changes']);
      expect(recapRow(model.rows).waitingNow).toBeFalsy();
    });

    it('keeps the tool lines after the stop below it, in their own run', () => {
      const fixture = waitingStory('en');
      const recap = fixture.items[fixture.items.length - 1]!;
      const before = later(fixture, -1, 'tool-call', 'Read', tool('call-before', 'Read', 'call', 'running'));
      const model = buildChatModel(ranOn({ ...fixture, items: [...fixture.items.slice(0, -1), before, { ...recap, sequence: recap.sequence }] }));
      const names = kinds(model.rows);
      expect(names.indexOf('activity')).toBeLessThan(names.indexOf('recap'));
      expect(names.lastIndexOf('activity')).toBeGreaterThan(names.indexOf('recap'));
    });

    it('holds its place through a later attempt: its first row is where the AI stopped', () => {
      const fixture = waitingStory('en');
      const run = ranOn(fixture);
      const recap = fixture.items[fixture.items.length - 1]!;
      const again: DaemonTranscriptItem = {
        ...recap, id: 'recap-again', sequence: run.items[run.items.length - 1]!.sequence + 1,
        payload: { v: 1, type: 'recap', turnId: recap.turnId!, providerId: 'claude', trigger: 'waiting', state: 'complete', text: 'Written again.' },
      };
      const model = buildChatModel({ ...run, items: [...run.items, again] });
      expect(kinds(model.rows).slice(-4)).toEqual(['recap', 'activity', 'assistant', 'changes']);
      expect(kinds(model.rows).filter((kind) => kind === 'recap')).toHaveLength(1);
      expect(recapRow(model.rows).recap.text).toBe('Written again.');
    });

    it('closes its turn as any recap does when nothing came after it: after the changes and the tasks', () => {
      const fixture = cartStory('en', 'codex');
      const last = fixture.items[fixture.items.length - 1]!;
      const recap: DaemonTranscriptItem = {
        id: 'recap-plan', sessionId: WRAP_SESSION, sequence: last.sequence + 1, kind: 'notice', text: 'A plan waits.', isDelta: false, isSensitive: true, turnId: 'turn-cart', createdAt: last.createdAt,
        payload: { v: 1, type: 'recap', turnId: 'turn-cart', providerId: 'codex', trigger: 'waiting', waiting: 'plan', decisionId: 'plan-1', state: 'complete', text: 'A plan waits.' },
      };
      expect(kinds(buildChatModel({ items: [...fixture.items, recap], turns: fixture.turns }).rows).slice(-4)).toEqual(['assistant', 'changes', 'task-suggestions', 'recap']);
    });

    it('leaves a turn-end recap after the final message', () => {
      const run = ranOn(waitingStory('en'));
      const items = run.items.map((item): DaemonTranscriptItem => (item.payload?.type === 'recap'
        ? { ...item, payload: { v: 1, type: 'recap', turnId: item.turnId!, providerId: 'claude', trigger: 'unattended', state: 'complete', text: 'Away.' } } : item));
      expect(kinds(buildChatModel({ ...run, items }).rows).slice(-4)).toEqual(['activity', 'assistant', 'changes', 'recap']);
    });
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
