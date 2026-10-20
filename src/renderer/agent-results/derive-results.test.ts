import { describe, expect, it } from 'vitest';

import type { DaemonApproval, DaemonTranscriptItem } from '../../shared/daemon-protocol';
import { buildChatModel } from '../chat/model/build-chat-model';
import claudeEditCreate from '../chat/fixtures/claude-edit-create.json';
import claudePlanMode from '../chat/fixtures/claude-plan-mode.json';
import codexEditCreate from '../chat/fixtures/codex-edit-create.json';
import codexPlanMode from '../chat/fixtures/codex-plan-mode.json';
import codexTodoEnabled from '../chat/fixtures/codex-todo-enabled.json';
import { changedTurns, deriveResults, isArtifactItem, mergeChanges, summarizeFiles } from './derive-results';

interface Golden { readonly items: unknown[]; readonly approvals: unknown[] }

function derive(golden: Golden) {
  const items = golden.items as DaemonTranscriptItem[];
  const approvals = golden.approvals as DaemonApproval[];
  const model = buildChatModel({ items, approvals });
  return deriveResults({ sessionId: items[0]!.sessionId, items, model });
}

describe('results derived from recorded conversations', () => {
  it('Claude edits and a created file: numbered changes, files most recent first, one changed turn', () => {
    const results = derive(claudeEditCreate);
    expect(results.changes.map((change) => [change.path.replace(/^.*[\\/]/u, ''), change.kind, change.coverage])).toEqual([
      ['app.ts', 'update', 'patch'], ['app.ts', 'update', 'patch'], ['notes.md', 'add', 'patch'],
    ]);
    expect(results.files.map((file) => [file.path.replace(/^.*[\\/]/u, ''), file.kind, file.added, file.removed, file.changeIds.length]))
      .toEqual([['notes.md', 'add', 1, 0, 1], ['app.ts', 'update', 2, 2, 2]]);
    expect(results.turns).toHaveLength(1);
    expect(results.turns[0]!.files).toBe(2);
    expect(results.artifactSequence).toBe(12);
    expect(results.running).toEqual([]);
  });

  it('Codex: the created file is an addition with line numbers', () => {
    const results = derive(codexEditCreate);
    const notes = results.changes.find((change) => change.path.endsWith('notes.md'))!;
    expect(notes).toMatchObject({ kind: 'add', added: 1, removed: 0, patch: '@@ -0,0 +1,1 @@\n+Renamed greet to greetUser.' });
    expect(results.files.map((file) => file.kind).sort()).toEqual(['add', 'update']);
  });

  it('plan mode: the latest plan is the summary plan and counts as an artifact', () => {
    const codex = derive(codexPlanMode);
    expect(codex.plan?.markdown).toBeTruthy();
    expect(codex.artifactSequence).toBe(9);
    const claude = derive(claudePlanMode);
    expect(claude.plan?.markdown).toContain('farewell');
  });

  it('a task list is the summary todo and counts as an artifact', () => {
    const results = derive(codexTodoEnabled);
    expect(results.todo?.length).toBeGreaterThan(0);
    expect(results.artifactSequence).toBe(11);
  });
});

describe('result helpers', () => {
  const base = { coverage: 'patch' as const, patch: '@@ -1,1 +1,1 @@\n-a\n+b', added: 1, removed: 1 };

  it('merges an earlier backfill with the loaded window by record id', () => {
    const merged = mergeChanges(
      [{ ...base, id: 'b:0', path: 'b', sequence: 20, kind: 'update' }],
      [{ ...base, id: 'a:0', path: 'a', sequence: 2, kind: 'update' }, { ...base, id: 'b:0', path: 'stale', sequence: 20, kind: 'update' }],
    );
    expect(merged.map((change) => [change.id, change.path])).toEqual([['a:0', 'a'], ['b:0', 'b']]);
  });

  it('a file created and later removed in one conversation reads as changed; removed alone reads as removed', () => {
    expect(summarizeFiles([
      { ...base, id: '1', path: 'x', sequence: 1, kind: 'add' },
      { ...base, id: '2', path: 'x', sequence: 2, kind: 'delete' },
      { ...base, id: '3', path: 'y', sequence: 3, kind: 'delete' },
    ]).map((file) => [file.path, file.kind])).toEqual([['y', 'delete'], ['x', 'update']]);
  });

  it('lists only turns that changed files, oldest first, counting distinct files', () => {
    expect(changedTurns([
      { ...base, id: '1', path: 'x', sequence: 5, turnId: 't2', kind: 'update' },
      { ...base, id: '2', path: 'x', sequence: 6, turnId: 't2', kind: 'update' },
      { ...base, id: '3', path: 'y', sequence: 1, turnId: 't1', kind: 'update' },
      { ...base, id: '4', path: 'z', sequence: 2, kind: 'update' },
    ]).map((turn) => [turn.turnId, turn.files])).toEqual([['t1', 1], ['t2', 1]]);
  });

  it('never counts streaming items or sensitive change records as artifacts; a sensitive plan still counts', () => {
    const item = (claudeEditCreate.items as DaemonTranscriptItem[]).find((entry) => entry.sequence === 6)!;
    expect(isArtifactItem(item)).toBe(true);
    expect(isArtifactItem({ ...item, isSensitive: true })).toBe(false);
    expect(isArtifactItem({ ...item, isDelta: true })).toBe(false);
    const plan = (codexPlanMode.items as DaemonTranscriptItem[]).find((entry) => entry.sequence === 9)!;
    expect(plan.isSensitive).toBe(true);
    expect(isArtifactItem(plan)).toBe(true);
  });
});
