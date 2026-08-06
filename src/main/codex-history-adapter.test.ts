import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { CodexAppServerRequester } from './codex-app-server-client';
import { CodexHistoryAdapter } from './codex-history-adapter';

function requester(
  request: CodexAppServerRequester['request'],
): CodexAppServerRequester {
  return {
    request,
    dispose: vi.fn(async () => undefined),
  };
}

describe('CodexHistoryAdapter', () => {
  it('lists one state-DB-only page without reading rollout workspace roots', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'ez-codex-history-'));
    const primary = path.join(base, 'primary');
    mkdirSync(primary);

    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method !== 'thread/list') throw new Error(`Unexpected method: ${method}`);
      return {
        data: [
          {
            id: 'top-level',
            parentThreadId: null,
            name: 'Workspace task',
            preview: 'Previous work',
            ephemeral: false,
            createdAt: 10,
            updatedAt: 20,
            cwd: primary,
            path: path.join(base, 'must-not-be-read.jsonl'),
            source: { appServer: {} },
          },
          {
            id: 'subagent',
            parentThreadId: 'top-level',
            preview: 'internal',
            ephemeral: false,
            createdAt: 11,
            updatedAt: 21,
            cwd: primary,
            path: path.join(base, 'must-not-be-read.jsonl'),
            source: { subAgent: {} },
          },
          {
            id: 'ephemeral',
            parentThreadId: null,
            preview: 'temporary',
            ephemeral: true,
            createdAt: 12,
            updatedAt: 22,
            cwd: primary,
            path: path.join(base, 'must-not-be-read.jsonl'),
            source: { cli: {} },
          },
        ],
        nextCursor: null,
      };
    });
    const adapter = new CodexHistoryAdapter(requester(request));

    await expect(adapter.listSessions({ roots: [primary], limit: 10 })).resolves.toMatchObject({
      items: [{
        privateId: 'top-level',
        title: 'Workspace task',
        roots: [path.normalize(primary)],
        rolloutPath: null,
      }],
      nextCursor: null,
    });
    expect(request).toHaveBeenCalledWith('thread/list', {
      limit: 10,
      archived: false,
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
      cwd: primary,
      useStateDbOnly: true,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    });
  });

  it('requests full turn items and maps transcript pagination without exposing provider metadata', async () => {
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method !== 'thread/turns/list') throw new Error(`Unexpected method: ${method}`);
      return {
        data: [{
          id: 'turn-1',
          status: 'completed',
          items: [
            { id: 'item-1', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
            { id: 'item-2', type: 'agentMessage', text: 'hi' },
            {
              id: 'item-3',
              type: 'fileChange',
              changes: [{
                path: 'src/app.ts',
                kind: 'update',
                diff: '@@ -1 +1 @@\n-old\n+new',
                text: 'src/app.ts (+1 -1)',
              }],
            },
          ],
        }],
        nextCursor: 'next-page',
      };
    });
    const adapter = new CodexHistoryAdapter(requester(request));

    const page = await adapter.readTranscript('private-thread', 'cursor-1', 20);

    expect(request).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'private-thread',
      limit: 20,
      sortDirection: 'desc',
      itemsView: 'full',
      cursor: 'cursor-1',
    });
    expect(page).toMatchObject({
      historyId: '',
      turns: [{
        status: 'completed',
        entries: [
          { type: 'message', role: 'user', markdown: 'hello' },
          { type: 'message', role: 'assistant', markdown: 'hi' },
          {
            type: 'activity',
            kind: 'file-change',
            summary: 'src/app.ts (+1 -1)',
            changedPaths: ['src/app.ts'],
          },
        ],
      }],
      nextCursor: 'next-page',
    });
    expect(page.turns[0]!.id).toMatch(/^turn_[0-9a-f]{20}$/);
    expect(page.turns[0]!.entries[0]!.id).toMatch(/^item_[0-9a-f]{20}$/);
    expect(JSON.stringify(page)).not.toContain('turn-1');
    expect(JSON.stringify(page)).not.toContain('item-1');
  });

  it('starts a new chat with --cd and one --add-dir per extra root', () => {
    const adapter = new CodexHistoryAdapter(requester(vi.fn()));

    expect(adapter.buildNewCommand(['C:\\Work', 'C:\\Shared', 'C:\\Docs'])).toEqual({
      commandText: "!codex --cd 'C:\\\\Work' --add-dir 'C:\\\\Shared' --add-dir 'C:\\\\Docs'",
      displayCommandText: 'codex',
    });
    expect(adapter.buildNewCommand([])).toBeNull();
  });

  it('attributes only structured fileChange records from the latest completed turn', async () => {
    const request = vi.fn(async (): Promise<unknown> => ({
      data: [
        {
          id: 'running-turn',
          status: 'inProgress',
          items: [{ type: 'fileChange', changes: [{ path: 'ignored.ts', kind: 'update', diff: '+ignored' }] }],
        },
        {
          id: 'complete-turn',
          status: 'completed',
          items: [{
            type: 'fileChange',
            changes: [{ path: 'src/app.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }],
          }],
        },
      ],
    }));
    const adapter = new CodexHistoryAdapter(requester(request));

    await expect(adapter.readFileChanges('private-thread')).resolves.toMatchObject({
      provider: 'codex',
      changes: [{ path: 'src/app.ts', kind: 'modified', diff: '@@ -1 +1 @@\n-old\n+new' }],
    });
    expect(request).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'private-thread',
      limit: 10,
      sortDirection: 'desc',
      itemsView: 'full',
    });
  });

  it('reads the exact opaque transcript turn and normalizes structured Codex kinds', async () => {
    const request = vi.fn(async (): Promise<unknown> => ({
      data: [
        {
          id: 'newer-turn',
          status: 'completed',
          items: [{
            id: 'newer-change',
            type: 'fileChange',
            changes: [{ path: 'src/newer.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new' }],
          }],
        },
        {
          id: 'selected-turn',
          status: 'completed',
          items: [{
            id: 'selected-change',
            type: 'fileChange',
            changes: [{ path: 'src/added.ts', kind: { type: 'add' }, diff: 'export const added = true;\n' }],
          }],
        },
      ],
      nextCursor: null,
    }));
    const adapter = new CodexHistoryAdapter(requester(request));
    const transcript = await adapter.readTranscript('private-thread', undefined, 20);
    const selectedTurn = transcript.turns.find((turn) => turn.entries.some((entry) =>
      entry.type === 'activity' && entry.changedPaths?.includes('src/added.ts')));
    if (!selectedTurn) throw new Error('selected transcript turn missing');

    await expect(adapter.readFileChanges('private-thread', selectedTurn.id)).resolves.toMatchObject({
      provider: 'codex',
      turnId: selectedTurn.id,
      changes: [{
        path: 'src/added.ts',
        kind: 'added',
        diff: 'export const added = true;\n',
      }],
    });
    expect(request).toHaveBeenLastCalledWith('thread/turns/list', {
      threadId: 'private-thread',
      limit: 100,
      sortDirection: 'desc',
      itemsView: 'full',
    });
  });

  it('falls back to the full thread when the selected turn is absent from bounded pages', async () => {
    const selected = {
      id: 'selected-full-thread-turn',
      status: 'completed',
      items: [{
        id: 'selected-full-thread-change',
        type: 'fileChange',
        changes: [{ path: 'src/from-full.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' }],
      }],
    };
    const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
      if (method === 'thread/read') return { thread: { turns: [selected] } };
      if (method !== 'thread/turns/list') throw new Error(`Unexpected method: ${method}`);
      const limit = (params as { limit?: number }).limit;
      return limit === 100 ? { data: [], nextCursor: null } : { data: [selected], nextCursor: null };
    });
    const adapter = new CodexHistoryAdapter(requester(request));
    const transcript = await adapter.readTranscript('private-thread', undefined, 20);
    const selectedTurnId = transcript.turns[0]?.id;
    if (!selectedTurnId) throw new Error('selected transcript turn missing');

    await expect(adapter.readFileChanges('private-thread', selectedTurnId)).resolves.toMatchObject({
      turnId: selectedTurnId,
      changes: [{ path: 'src/from-full.ts' }],
    });
    expect(request).toHaveBeenCalledWith('thread/read', {
      threadId: 'private-thread',
      includeTurns: true,
    });
  });

  it('selects the newest completed turn when the full-thread fallback is chronological', async () => {
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'thread/turns/list') throw new Error('older app-server fallback');
      if (method !== 'thread/read') throw new Error(`Unexpected method: ${method}`);
      return {
        thread: {
          turns: [
            {
              id: 'older-turn',
              status: 'completed',
              items: [{ type: 'fileChange', changes: [{ path: 'older.ts', kind: 'update', diff: '+old' }] }],
            },
            {
              id: 'newer-turn',
              status: 'completed',
              items: [{ type: 'fileChange', changes: [{ path: 'newer.ts', kind: 'update', diff: '+new' }] }],
            },
          ],
        },
      };
    });
    const adapter = new CodexHistoryAdapter(requester(request));

    await expect(adapter.readFileChanges('private-thread')).resolves.toMatchObject({
      provider: 'codex',
      changes: [{ path: 'newer.ts' }],
    });
  });
});
