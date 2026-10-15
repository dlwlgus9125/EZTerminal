import { describe, expect, it } from 'vitest';

import type { AgentTranscriptPage } from '../../../shared/agent-history';
import { buildChatModel } from './build-chat-model';
import { historyTranscriptItems } from './history-items';
import type { ChatModel, ChatTool } from './types';

function tools(model: ChatModel): ChatTool[] {
  return model.rows.flatMap((row) => (row.kind === 'activity' ? row.entries : []))
    .flatMap((entry) => (entry.kind === 'tool' ? [entry.tool] : []));
}

describe('historyTranscriptItems', () => {
  it('names Claude CLI tools and pairs their results', () => {
    const page: AgentTranscriptPage = {
      historyId: 'h', provider: 'claude', nextCursor: null,
      turns: [{ id: 't1', status: 'completed', entries: [
        { type: 'message', id: 'm1', role: 'user', markdown: 'Fix it' },
        { type: 'activity', id: 'c1', kind: 'tool', summary: 'Read: C:\\repo\\src\\app.ts' },
        { type: 'activity', id: 'c2', kind: 'command', summary: 'Bash: npm test' },
        { type: 'activity', id: 'r1', kind: 'tool', summary: 'export function greet', status: 'completed' },
        { type: 'activity', id: 'r2', kind: 'tool', summary: 'Tests failed', status: 'error' },
        { type: 'activity', id: 'c3', kind: 'file-change', summary: 'Write: C:\\repo\\notes.md', changedPaths: ['C:\\repo\\notes.md'] },
        { type: 'activity', id: 'r3', kind: 'tool', summary: 'File created successfully', status: 'completed' },
        { type: 'message', id: 'm2', role: 'assistant', markdown: 'Done.' },
      ] }],
    };
    const model = buildChatModel({ items: historyTranscriptItems(page, 'session', '2026-10-15T00:00:00.000Z') });
    expect(tools(model).map((tool) => [tool.name, tool.category, tool.status, tool.target])).toEqual([
      ['Read', 'read', 'completed', 'C:\\repo\\src\\app.ts'],
      ['Bash', 'command', 'failed', 'npm test'],
      ['Write', 'write', 'completed', 'C:\\repo\\notes.md'],
    ]);
    expect(tools(model).some((tool) => tool.name === 'tool')).toBe(false);
  });

  it('turns each finished Codex item into a named, settled tool', () => {
    const page: AgentTranscriptPage = {
      historyId: 'h', provider: 'codex', nextCursor: null,
      turns: [{ id: 't1', status: 'completed', entries: [
        { type: 'message', id: 'm1', role: 'user', markdown: 'Run it' },
        { type: 'activity', id: 'x1', kind: 'command', summary: 'node --version', status: 'completed' },
        { type: 'activity', id: 'x2', kind: 'command', summary: 'node -e "process.exit(3)"', status: 'failed' },
        { type: 'activity', id: 'x3', kind: 'web-search', summary: 'typescript unions' },
      ] }],
    };
    const model = buildChatModel({ items: historyTranscriptItems(page, 'session', '2026-10-15T00:00:00.000Z') });
    expect(tools(model).map((tool) => [tool.category, tool.status, tool.command ?? tool.target])).toEqual([
      ['command', 'completed', 'node --version'],
      ['command', 'failed', 'node -e "process.exit(3)"'],
      ['web', 'completed', 'typescript unions'],
    ]);
  });
});
