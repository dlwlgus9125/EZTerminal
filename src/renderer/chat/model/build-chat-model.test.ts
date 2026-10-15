import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DaemonApproval, DaemonTranscriptItem, DaemonTurn } from '../../../shared/daemon-protocol';
import { buildChatModel } from './build-chat-model';
import { unwrapShellCommand } from './legacy-decode';
import { summarizeActivity } from './summary';
import type { ChatRow } from './types';

const FIXTURES = path.resolve(process.cwd(), 'src/renderer/chat/fixtures');

interface Golden {
  readonly items: DaemonTranscriptItem[];
  readonly approvals: DaemonApproval[];
}

function golden(name: string): Golden {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as Golden;
}

/** The goldens carry no turn records; a finished single-turn session is what they describe. */
function finishedTurns(items: readonly DaemonTranscriptItem[], state: DaemonTurn['state'] = 'completed'): DaemonTurn[] {
  const ids = [...new Set(items.flatMap((item) => (item.turnId ? [item.turnId] : [])))];
  return ids.map((id) => ({
    id, sessionId: items[0]!.sessionId, commandId: `command-${id}`, state,
    startedAt: '2026-10-15T00:00:00.000Z', finishedAt: '2026-10-15T00:00:12.000Z',
    revision: 1, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:12.000Z',
  }));
}

function kinds(rows: readonly ChatRow[]): string[] {
  return rows.map((row) => row.kind);
}

function activity(rows: readonly ChatRow[], index = 0): Extract<ChatRow, { kind: 'activity' }> {
  const found = rows.filter((row): row is Extract<ChatRow, { kind: 'activity' }> => row.kind === 'activity')[index];
  if (!found) throw new Error(`no activity row ${index}`);
  return found;
}

describe('buildChatModel over recorded provider sessions', () => {
  for (const name of readdirSync(FIXTURES).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5))) {
    it(`${name}: shows each prompt once and hides lifecycle notices`, () => {
      const { items, approvals } = golden(name);
      const model = buildChatModel({ items, approvals, turns: finishedTurns(items) });
      const users = model.rows.filter((row) => row.kind === 'user');
      expect(users.length).toBe(1);
      expect(model.rows.some((row) => row.kind === 'notice' && /completed the turn/u.test(row.text))).toBe(false);
      for (const row of model.rows) {
        if (row.kind !== 'activity') continue;
        expect(row.live).toBe(false);
        for (const entry of row.entries) {
          if (entry.kind === 'tool') expect(entry.tool.status, `${name} ${entry.tool.name}`).not.toBe('running');
        }
      }
    });
  }

  it('puts a live turn status after the turn rows and a finished one before them', () => {
    const { items } = golden('claude-read-search');
    const live = buildChatModel({ items, turns: finishedTurns(items, 'working') });
    expect(kinds(live.rows)).toEqual(['user', 'activity', 'assistant', 'turn-status']);
    const done = buildChatModel({ items, turns: finishedTurns(items) });
    expect(kinds(done.rows)).toEqual(['user', 'turn-status', 'activity', 'assistant']);
  });

  it('pairs Claude reads and searches into one run with targets', () => {
    const { items } = golden('claude-read-search');
    const model = buildChatModel({ items, turns: finishedTurns(items) });
    expect(kinds(model.rows)).toEqual(['user', 'turn-status', 'activity', 'assistant']);
    const run = activity(model.rows);
    const tools = run.entries.flatMap((entry) => (entry.kind === 'tool' ? [entry.tool] : []));
    expect(tools.map((tool) => [tool.name, tool.category, tool.status])).toEqual([
      ['Read', 'read', 'completed'],
      ['Grep', 'search', 'completed'],
    ]);
    expect(tools[0]!.target).toMatch(/README\.md$/u);
    expect(summarizeActivity(run.entries, false, 'en').text).toBe('Read 1 file and searched 1 time');
    expect(summarizeActivity(run.entries, false, 'ko').text).toBe('파일 1개 읽음, 1번 검색함');
  });

  it('unwraps Codex PowerShell commands and keeps the failure', () => {
    const { items } = golden('codex-command-ok-fail');
    const model = buildChatModel({ items, turns: finishedTurns(items) });
    const tools = activity(model.rows).entries.flatMap((entry) => (entry.kind === 'tool' ? [entry.tool] : []));
    expect(tools.map((tool) => [tool.command, tool.status])).toEqual([
      ['node --version', 'completed'],
      ['node -e "process.exit(3)"', 'failed'],
    ]);
    // The turn summary notice repeats the final answer; it is not shown twice.
    expect(model.rows.filter((row) => row.kind === 'notice')).toEqual([]);
  });

  it('marks a denied Claude command and keeps the decision off the transcript', () => {
    const { items, approvals } = golden('claude-approval-deny');
    const model = buildChatModel({ items, approvals, turns: finishedTurns(items) });
    const tool = activity(model.rows).entries.find((entry) => entry.kind === 'tool');
    expect(tool?.kind === 'tool' && [tool.tool.category, tool.tool.status]).toEqual(['command', 'denied']);
    expect(model.pending).toBeUndefined();
  });

  it('rolls up a turn\u2019s file changes once per path', () => {
    const { items } = golden('claude-edit-create');
    const model = buildChatModel({ items, turns: finishedTurns(items) });
    const changes = model.rows.find((row): row is Extract<ChatRow, { kind: 'changes' }> => row.kind === 'changes');
    expect(changes?.files.map((file) => file.path.replace(/^.*[\\/]/u, ''))).toEqual(['app.ts', 'notes.md']);
    expect(changes?.files[0]).toMatchObject({ added: 2, removed: 2 });
  });

  it('turns AskUserQuestion into a question row with the answer', () => {
    const { items } = golden('claude-ask-question');
    const model = buildChatModel({ items, turns: finishedTurns(items) });
    const question = model.rows.find((row): row is Extract<ChatRow, { kind: 'question' }> => row.kind === 'question');
    expect(question?.questions[0]?.question).toMatch(/formal or casual/u);
    expect(question?.questions[0]?.options.length).toBeGreaterThanOrEqual(2);
    expect(question?.answer).toMatch(/Casual/u);
  });

  it('shows an ExitPlanMode plan as a plan row', () => {
    const { items } = golden('claude-plan-mode');
    const model = buildChatModel({ items, turns: finishedTurns(items) });
    const plan = model.rows.find((row): row is Extract<ChatRow, { kind: 'plan' }> => row.kind === 'plan');
    expect(plan?.markdown).toMatch(/^# Plan/u);
    expect(plan?.status).toBe('completed');
  });

  it('reads Codex file changes stored as back-to-back objects', () => {
    const { items } = golden('codex-edit-create');
    const model = buildChatModel({ items, turns: finishedTurns(items) });
    const tools = model.rows.flatMap((row) => (row.kind === 'activity' ? row.entries : []))
      .flatMap((entry) => (entry.kind === 'tool' ? [entry.tool] : []));
    const edit = tools.find((tool) => tool.category === 'edit' || tool.category === 'write');
    expect(edit?.files?.map((file) => file.path.replace(/^.*[\\/]/u, '')).sort()).toEqual(['app.ts', 'notes.md']);
  });

  it('builds the task list from Claude task tools and hides tool discovery', () => {
    const { items } = golden('claude-todo-enabled');
    const model = buildChatModel({ items, turns: finishedTurns(items) });
    expect(model.todo?.length).toBe(3);
    expect(model.todo?.every((item) => item.status === 'completed')).toBe(true);
    const names = model.rows.flatMap((row) => (row.kind === 'activity' ? row.entries : []))
      .flatMap((entry) => (entry.kind === 'tool' ? [entry.tool.name] : []));
    expect(names).not.toContain('ToolSearch');
    expect(model.rows.filter((row) => row.kind === 'todo').length).toBeGreaterThan(1);
  });

  it('shows the Codex web search query instead of the item type', () => {
    const { items } = golden('codex-web');
    const model = buildChatModel({ items, turns: finishedTurns(items) });
    const web = model.rows.flatMap((row) => (row.kind === 'activity' ? row.entries : []))
      .flatMap((entry) => (entry.kind === 'tool' ? [entry.tool] : [])).find((tool) => tool.category === 'web');
    expect(web?.target).toMatch(/node/iu);
    expect(web?.output).not.toMatch(/^\{/u);
  });

  it('marks an interrupted Codex message as finished, not streaming', () => {
    const { items } = golden('codex-interrupt');
    const model = buildChatModel({ items, turns: finishedTurns(items, 'interrupted') });
    expect(model.rows.filter((row) => row.kind === 'assistant' && row.streaming)).toEqual([]);
  });

  it('streams the newest assistant text while its turn is active', () => {
    const { items } = golden('codex-markdown');
    const model = buildChatModel({ items: items.filter((item) => item.kind !== 'notice' && !(item.kind === 'assistant-message' && !item.isDelta)), turns: finishedTurns(items, 'working') });
    expect(model.rows.some((row) => row.kind === 'assistant' && row.streaming)).toBe(true);
  });
});

describe('unwrapShellCommand', () => {
  it('handles PowerShell, cmd and sh wrappers', () => {
    expect(unwrapShellCommand(String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -LiteralPath src/app.ts'`))
      .toBe('Get-Content -LiteralPath src/app.ts');
    expect(unwrapShellCommand(String.raw`C:\Windows\system32\cmd.exe /c dir`)).toBe('dir');
    expect(unwrapShellCommand(`/bin/bash -lc 'ls -la'`)).toBe('ls -la');
    expect(unwrapShellCommand('node --version')).toBe('node --version');
  });
});
