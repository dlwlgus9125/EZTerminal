import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DaemonTranscriptItem, DaemonTurn } from '../../../shared/daemon-protocol';
import { buildChatModel } from './build-chat-model';
import type { ChatModel, ChatTool } from './types';

/**
 * Old hosts and conversations stored before transcript payloads have only
 * text: `fixtures/legacy` holds the same recorded sessions as the adapters
 * emitted them before payloads, streaming coalescing and echo suppression.
 * Both shapes must read the same.
 */
const FIXTURES = path.resolve(process.cwd(), 'src/renderer/chat/fixtures');

function load(file: string): DaemonTranscriptItem[] {
  return (JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8')) as { items: DaemonTranscriptItem[] }).items;
}

function model(items: DaemonTranscriptItem[]): ChatModel {
  const turns = [...new Set(items.flatMap((item) => (item.turnId ? [item.turnId] : [])))].map((id): DaemonTurn => ({
    id, sessionId: items[0]!.sessionId, commandId: `command-${id}`, state: 'completed',
    startedAt: '2026-10-15T00:00:00.000Z', finishedAt: '2026-10-15T00:00:12.000Z',
    revision: 1, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:12.000Z',
  }));
  return buildChatModel({ items, turns });
}

function pair(name: string): { readonly legacy: ChatModel; readonly current: ChatModel } {
  return { legacy: model(load(`legacy/${name}.json`)), current: model(load(`${name}.json`)) };
}

function tools(chat: ChatModel): ChatTool[] {
  return chat.rows.flatMap((row) => (row.kind === 'activity' ? row.entries : []))
    .flatMap((entry) => (entry.kind === 'tool' ? [entry.tool] : []));
}

const words = (text: string): string => text.replace(/\s+/gu, ' ').trim();
const base = (file: string): string => file.replace(/^.*[\\/]/u, '');
const prose = (chat: ChatModel): string[] => chat.rows.flatMap((row) => (row.kind === 'user' || row.kind === 'assistant' ? [`${row.kind}:${words(row.text)}`] : []));

describe('legacy transcripts read like payload transcripts', () => {
  it('codex-markdown: 211 streamed deltas become the same single reply', () => {
    const { legacy, current } = pair('codex-markdown');
    expect(prose(legacy)).toEqual(prose(current));
    expect(legacy.rows.filter((row) => row.kind === 'assistant')).toHaveLength(1);
  });

  it('claude-read-search: the same tools, categories and targets', () => {
    const { legacy, current } = pair('claude-read-search');
    const shape = (chat: ChatModel) => tools(chat).map((tool) => [tool.name, tool.category, tool.status, base(tool.target ?? '')]);
    expect(shape(legacy)).toEqual(shape(current));
    expect(prose(legacy)).toEqual(prose(current));
  });

  it('codex-command-ok-fail: the same commands and outcomes', () => {
    const { legacy, current } = pair('codex-command-ok-fail');
    const shape = (chat: ChatModel) => tools(chat).map((tool) => [tool.category, tool.command, tool.status]);
    expect(shape(legacy)).toEqual(shape(current));
    expect(shape(current).map(([, , status]) => status)).toEqual(['completed', 'failed']);
  });

  it('claude-edit-create: the same edits and change rollup', () => {
    const { legacy, current } = pair('claude-edit-create');
    const shape = (chat: ChatModel) => tools(chat).map((tool) => [tool.name, tool.category, tool.status]);
    expect(shape(legacy)).toEqual(shape(current));
    const files = (chat: ChatModel) => chat.rows.flatMap((row) => (row.kind === 'changes' ? row.files.map((file) => base(file.path)) : [])).sort();
    expect(files(legacy)).toEqual(files(current));
    expect(files(current)).toEqual(['app.ts', 'notes.md']);
  });

  it('claude-todo-enabled: the same final task list from task tools alone', () => {
    const { legacy, current } = pair('claude-todo-enabled');
    expect(legacy.todo).toEqual(current.todo);
    expect(current.todo?.map((item) => item.status)).toEqual(['completed', 'completed', 'completed']);
    for (const chat of [legacy, current]) {
      expect(tools(chat).filter((tool) => tool.category === 'todo')).toEqual([]);
      expect(chat.rows.some((row, index) => row.kind === 'todo' && chat.rows[index + 1]?.kind === 'todo')).toBe(false);
    }
  });
});
