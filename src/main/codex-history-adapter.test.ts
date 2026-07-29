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
});
