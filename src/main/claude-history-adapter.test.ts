import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ClaudeHistoryAdapter,
  encodeClaudeProjectDirName,
} from './claude-history-adapter';

/** Envelope fields every conversation record carries in a real transcript. */
function envelope(cwd: string, sessionId: string, index: number): Record<string, unknown> {
  return {
    parentUuid: index === 0 ? null : `uuid-${String(index - 1)}`,
    isSidechain: false,
    uuid: `uuid-${String(index)}`,
    timestamp: new Date(Date.UTC(2026, 6, 27, 0, 0, index)).toISOString(),
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId,
    version: '2.1.220',
    gitBranch: 'main',
  };
}

function jsonl(records: readonly Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

interface Fixture {
  readonly home: string;
  readonly root: string;
  readonly projectDirectory: string;
}

function makeFixture(name: string): Fixture {
  const home = mkdtempSync(path.join(os.tmpdir(), `ez-claude-history-${name}-`));
  const root = path.join(home, 'workspace');
  mkdirSync(root);
  const projectDirectory = path.join(
    home,
    '.claude',
    'projects',
    encodeClaudeProjectDirName(root),
  );
  mkdirSync(projectDirectory, { recursive: true });
  return { home, root, projectDirectory };
}

function sessionId(index: number): string {
  return `9f2c1b74-1111-4222-8333-${String(index).padStart(12, '0')}`;
}

function writeSession(
  fixture: Fixture,
  index: number,
  records: readonly Record<string, unknown>[],
  mtimeSeconds?: number,
): string {
  const id = sessionId(index);
  const filePath = path.join(fixture.projectDirectory, `${id}.jsonl`);
  writeFileSync(filePath, jsonl(records));
  if (mtimeSeconds !== undefined) utimesSync(filePath, mtimeSeconds, mtimeSeconds);
  return filePath;
}

/** The preamble a real session opens with before the first typed prompt. */
function preamble(cwd: string, id: string): Record<string, unknown>[] {
  return [
    { type: 'mode', mode: 'normal', sessionId: id },
    { type: 'file-history-snapshot', messageId: 'snapshot-1', snapshot: {}, isSnapshotUpdate: false },
    {
      ...envelope(cwd, id, 0),
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: '<local-command-caveat>Caveat: …</local-command-caveat>' },
    },
    {
      ...envelope(cwd, id, 1),
      type: 'user',
      message: { role: 'user', content: '<command-name>/clear</command-name>' },
    },
    {
      ...envelope(cwd, id, 2),
      type: 'system',
      subtype: 'local_command',
      level: 'info',
      isMeta: false,
      content: '<local-command-stdout></local-command-stdout>',
    },
    {
      ...envelope(cwd, id, 3),
      type: 'attachment',
      attachment: { type: 'skill_listing', text: 'x'.repeat(4_000) },
    },
  ];
}

function humanPrompt(cwd: string, id: string, index: number, text: string): Record<string, unknown> {
  return {
    ...envelope(cwd, id, index),
    type: 'user',
    promptId: `prompt-${String(index)}`,
    message: { role: 'user', content: text },
    origin: { kind: 'human' },
    promptSource: 'typed',
    permissionMode: 'default',
  };
}

/** One rendered turn: a typed prompt, a reply, a tool call, its result, and a
 * subagent record that belongs to a separate file and must never be shown. */
function turn(cwd: string, id: string, index: number, text: string): Record<string, unknown>[] {
  return [
    humanPrompt(cwd, id, index, text),
    {
      ...envelope(cwd, id, index + 1),
      type: 'assistant',
      requestId: `req-${String(index)}`,
      message: {
        model: 'claude-opus-5',
        id: `msg-${String(index)}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: `reply to ${text}` }],
        stop_reason: 'tool_use',
      },
    },
    {
      ...envelope(cwd, id, index + 2),
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: `toolu_${String(index)}`,
          name: 'Bash',
          input: { command: 'pnpm test', description: 'Run tests' },
        }],
      },
    },
    {
      ...envelope(cwd, id, index + 3),
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: `toolu_${String(index)}`,
          content: 'all tests passed',
        }],
      },
      toolUseResult: { type: 'text' },
    },
    {
      ...envelope(cwd, id, index + 4),
      isSidechain: true,
      agentId: 'a98deea37acd1523d',
      type: 'user',
      message: { role: 'user', content: `subagent brief for ${text}` },
      origin: { kind: 'human' },
    },
  ];
}

describe('encodeClaudeProjectDirName', () => {
  it('replaces every non-alphanumeric character one for one and keeps case', () => {
    expect(encodeClaudeProjectDirName('C:\\Working\\EZTerminal')).toBe('C--Working-EZTerminal');
    expect(encodeClaudeProjectDirName('C:\\Program Files\\EZTerminal'))
      .toBe('C--Program-Files-EZTerminal');
    // `\.claude` keeps both separators: the backslash AND the dot each become a dash.
    expect(encodeClaudeProjectDirName('C:\\Users\\dlwlg\\.claude\\jobs'))
      .toBe('C--Users-dlwlg--claude-jobs');
    expect(encodeClaudeProjectDirName('C:\\Users\\me\\AppData\\Local\\ezterminal\\app-0.5.0'))
      .toBe('C--Users-me-AppData-Local-ezterminal-app-0-5-0');
    // Claude encodes the cwd as the process saw it, so case is not normalized.
    expect(encodeClaudeProjectDirName('c:\\Working\\EasyEvolve')).toBe('c--Working-EasyEvolve');
  });

  it('truncates past 200 characters and appends a base-36 rolling hash', () => {
    const encoded = encodeClaudeProjectDirName(`C:\\${'a'.repeat(300)}`);
    expect(encoded.slice(0, 200)).toBe(`C--${'a'.repeat(197)}`);
    expect(encoded.slice(200, 201)).toBe('-');
    expect(encoded.slice(201)).toMatch(/^[0-9a-z]+$/u);
    // Different originals sharing a 200-character prefix must not collide.
    expect(encodeClaudeProjectDirName(`C:\\${'a'.repeat(301)}`)).not.toBe(encoded);
  });
});

describe('ClaudeHistoryAdapter.listSessions', () => {
  it('pages the ten most recent sessions per project without opening the rest', async () => {
    const fixture = makeFixture('paging');
    for (let index = 1; index <= 12; index += 1) {
      const id = sessionId(index);
      const records = index <= 2
        // Deliberately unreadable: these sit outside the first page, so the page
        // must come back from directory metadata alone.
        ? [{ type: 'mode', mode: 'normal', sessionId: id }]
        : [...preamble(fixture.root, id), ...turn(fixture.root, id, 10, `prompt ${String(index)}`)];
      const filePath = writeSession(fixture, index, records, 1_800_000_000 + index * 60);
      if (index <= 2) writeFileSync(filePath, 'this is not json at all\n{ broken\n');
    }
    // Neither of these is a session: a zero-byte transcript is "no such session"
    // to Claude itself, and the sibling directory holds subagents/tool results.
    writeFileSync(path.join(fixture.projectDirectory, `${sessionId(99)}.jsonl`), '');
    mkdirSync(path.join(fixture.projectDirectory, sessionId(3)), { recursive: true });

    const adapter = new ClaudeHistoryAdapter({ homeDir: fixture.home });
    const first = await adapter.listSessions({ roots: [fixture.root], limit: 10 });

    expect(first.items).toHaveLength(10);
    expect(first.items.map((item) => item.title)).toEqual([
      'prompt 12', 'prompt 11', 'prompt 10', 'prompt 9', 'prompt 8',
      'prompt 7', 'prompt 6', 'prompt 5', 'prompt 4', 'prompt 3',
    ]);
    expect(first.items[0]).toMatchObject({
      cwd: fixture.root,
      roots: [fixture.root],
      source: 'cli',
      parentPrivateId: null,
      rolloutPath: null,
    });
    expect(first.nextCursor).not.toBeNull();

    const second = await adapter.listSessions({
      roots: [fixture.root],
      cursor: first.nextCursor!,
      limit: 10,
    });
    expect(second.items).toHaveLength(2);
    expect(second.items.map((item) => item.title)).toEqual([
      'Untitled session', 'Untitled session',
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('finds the typed prompt past a large preamble and ignores an unrelated project', async () => {
    const fixture = makeFixture('title');
    const id = sessionId(1);
    writeSession(fixture, 1, [
      ...preamble(fixture.root, id),
      {
        ...envelope(fixture.root, id, 4),
        type: 'user',
        message: { role: 'user', content: '<local-command-stdout>Set effort level</local-command-stdout>' },
      },
      humanPrompt(fixture.root, id, 5, 'first typed prompt\nsecond line of the same prompt'),
      humanPrompt(fixture.root, id, 6, 'a later prompt that must not win'),
    ]);
    // Another app's project directory, which no root points at.
    const other = path.join(fixture.home, '.claude', 'projects', 'C--Somewhere-Else');
    mkdirSync(other, { recursive: true });
    writeFileSync(
      path.join(other, `${sessionId(50)}.jsonl`),
      jsonl([humanPrompt('C:\\Somewhere\\Else', sessionId(50), 0, 'foreign project work')]),
    );

    const adapter = new ClaudeHistoryAdapter({ homeDir: fixture.home });
    const page = await adapter.listSessions({ roots: [fixture.root], limit: 10 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      title: 'first typed prompt',
      preview: 'first typed prompt\nsecond line of the same prompt',
    });
  });

  it('titles a session from the prompt log when the typed prompt is deep in the transcript', async () => {
    const fixture = makeFixture('deep-prompt');
    const deepId = sessionId(1);
    const shallowId = sessionId(2);
    const filler: Record<string, unknown>[] = [];
    for (let index = 0; index < 120; index += 1) {
      filler.push({
        ...envelope(fixture.root, deepId, index + 10),
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1_000) }] },
      });
    }
    writeSession(fixture, 1, [
      ...preamble(fixture.root, deepId),
      ...filler,
      humanPrompt(fixture.root, deepId, 500, 'the prompt buried behind a session of tool traffic'),
    ], 1_800_000_200);
    // Not in the prompt log at all: the bounded head scan still has to work.
    writeSession(fixture, 2, [
      ...preamble(fixture.root, shallowId),
      humanPrompt(fixture.root, shallowId, 5, 'an early prompt'),
    ], 1_800_000_100);
    writeFileSync(
      path.join(fixture.home, '.claude', 'history.jsonl'),
      jsonl([
        // A slash command is a real typed prompt, but prose outranks it.
        { display: '/effort', pastedContents: {}, timestamp: 1_700_000_000_000, project: fixture.root, sessionId: deepId },
        { display: 'the prompt buried behind a session of tool traffic', pastedContents: {}, timestamp: 1_700_000_001_000, project: fixture.root, sessionId: deepId },
        { display: 'a later follow-up that must not win', pastedContents: {}, timestamp: 1_700_000_002_000, project: fixture.root, sessionId: deepId },
      ]),
    );

    const adapter = new ClaudeHistoryAdapter({ homeDir: fixture.home });
    const page = await adapter.listSessions({ roots: [fixture.root], limit: 10 });

    expect(page.items.map((item) => item.title)).toEqual([
      'the prompt buried behind a session of tool traffic',
      'an early prompt',
    ]);
    expect(page.items[0]!.cwd).toBe(fixture.root);
  });

  it('falls back to a slash command rather than leaving a used session untitled', async () => {
    const fixture = makeFixture('slash-only');
    const id = sessionId(1);
    writeSession(fixture, 1, preamble(fixture.root, id));
    writeFileSync(
      path.join(fixture.home, '.claude', 'history.jsonl'),
      jsonl([
        { display: '/effort', pastedContents: {}, timestamp: 1_700_000_000_000, project: fixture.root, sessionId: id },
      ]),
    );

    const adapter = new ClaudeHistoryAdapter({ homeDir: fixture.home });
    const page = await adapter.listSessions({ roots: [fixture.root], limit: 10 });

    expect(page.items[0]).toMatchObject({ title: '/effort' });
  });

  it('returns nothing when the provider has never been used', async () => {
    const fixture = makeFixture('empty');
    const adapter = new ClaudeHistoryAdapter({ homeDir: path.join(fixture.home, 'absent') });
    await expect(adapter.listSessions({ roots: [fixture.root], limit: 10 }))
      .resolves.toEqual({ items: [], nextCursor: null });
  });
});

describe('ClaudeHistoryAdapter.readTranscript', () => {
  it('loads the last twenty turns first and the earlier ones on demand', async () => {
    const fixture = makeFixture('transcript');
    const id = sessionId(1);
    const records = [...preamble(fixture.root, id)];
    for (let index = 1; index <= 25; index += 1) {
      records.push(...turn(fixture.root, id, index * 10, `prompt ${String(index)}`));
    }
    const filePath = writeSession(fixture, 1, records);
    const adapter = new ClaudeHistoryAdapter({ homeDir: fixture.home });

    const first = await adapter.readTranscript(filePath, undefined, 20);
    expect(first.provider).toBe('claude');
    expect(first.turns).toHaveLength(20);
    // Oldest-first inside the page, newest page first — the panel prepends.
    expect(first.turns[0]!.entries[0]).toMatchObject({ markdown: 'prompt 6' });
    expect(first.turns[19]!.entries[0]).toMatchObject({ markdown: 'prompt 25' });
    expect(first.nextCursor).not.toBeNull();

    const earlier = await adapter.readTranscript(filePath, first.nextCursor!, 20);
    expect(earlier.turns).toHaveLength(5);
    expect(earlier.turns[0]!.entries[0]).toMatchObject({ markdown: 'prompt 1' });
    expect(earlier.turns[4]!.entries[0]).toMatchObject({ markdown: 'prompt 5' });
    expect(earlier.nextCursor).toBeNull();
  });

  it('maps a turn onto the neutral entry shape and drops subagent records', async () => {
    const fixture = makeFixture('entries');
    const id = sessionId(1);
    const filePath = writeSession(fixture, 1, [
      ...preamble(fixture.root, id),
      ...turn(fixture.root, id, 10, 'do the thing'),
    ]);
    const adapter = new ClaudeHistoryAdapter({ homeDir: fixture.home });

    const page = await adapter.readTranscript(filePath, undefined, 20);

    expect(page.turns).toHaveLength(1);
    const entries = page.turns[0]!.entries;
    expect(entries.map((entry) =>
      entry.type === 'message' ? `message:${entry.role}` : `activity:${entry.kind}`)).toEqual([
      'message:user',
      'message:assistant',
      'activity:command',
      'activity:tool',
    ]);
    expect(entries[2]).toMatchObject({ summary: 'Bash: pnpm test' });
    expect(entries[3]).toMatchObject({ summary: 'all tests passed', status: 'completed' });
    // The subagent brief lives in a sidechain record and belongs to its own file.
    expect(JSON.stringify(page)).not.toContain('subagent brief');
    // Ids are opaque: no provider uuid and no transcript path reach the page.
    expect(JSON.stringify(page)).not.toContain(id);
    expect(JSON.stringify(page)).not.toContain('toolu_');
    expect(page.turns[0]!.id).toMatch(/^turn_[0-9a-f]{20}$/u);
    for (const entry of entries) expect(entry.id).toMatch(/^item_[0-9a-f]{20}$/u);
  });

  it('renders a session that never got a typed prompt as a single turn', async () => {
    const fixture = makeFixture('no-prompt');
    const id = sessionId(1);
    const filePath = writeSession(fixture, 1, [
      ...preamble(fixture.root, id),
      {
        ...envelope(fixture.root, id, 4),
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'slash command output' }] },
      },
    ]);
    const adapter = new ClaudeHistoryAdapter({ homeDir: fixture.home });

    const page = await adapter.readTranscript(filePath, undefined, 20);

    expect(page.turns).toHaveLength(1);
    expect(page.turns[0]!.entries).toEqual([
      expect.objectContaining({ type: 'message', role: 'assistant', markdown: 'slash command output' }),
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('reports an empty page for a transcript that is gone', async () => {
    const fixture = makeFixture('missing');
    const adapter = new ClaudeHistoryAdapter({ homeDir: fixture.home });
    await expect(adapter.readTranscript(path.join(fixture.projectDirectory, 'nope.jsonl')))
      .resolves.toEqual({ historyId: '', provider: 'claude', turns: [], nextCursor: null });
  });

  it('attributes only successful Edit/Write tool pairs in the latest complete turn', async () => {
    const fixture = makeFixture('latest-changes');
    const id = sessionId(1);
    const filePath = writeSession(fixture, 1, [
      ...preamble(fixture.root, id),
      humanPrompt(fixture.root, id, 10, 'change the files'),
      {
        ...envelope(fixture.root, id, 11),
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'edit-ok', name: 'Edit', input: { file_path: 'src/app.ts', old_string: 'old', new_string: 'new', replace_all: true } },
            { type: 'tool_use', id: 'write-ok', name: 'Write', input: { file_path: 'src/generated.ts', content: 'generated' } },
            { type: 'tool_use', id: 'write-failed', name: 'Write', input: { file_path: 'failed.ts', content: 'nope' } },
          ],
          stop_reason: 'tool_use',
        },
      },
      {
        ...envelope(fixture.root, id, 12),
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'edit-ok', content: 'updated' },
            { type: 'tool_result', tool_use_id: 'write-ok', content: 'written' },
            { type: 'tool_result', tool_use_id: 'write-failed', content: 'denied', is_error: true },
          ],
        },
      },
      {
        ...envelope(fixture.root, id, 13),
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
      },
    ]);
    const adapter = new ClaudeHistoryAdapter({ homeDir: fixture.home });

    const transcript = await adapter.readTranscript(filePath);
    const fileChanges = transcript.turns.flatMap((turnEntry) => turnEntry.entries)
      .filter((entry) => entry.type === 'activity' && entry.kind === 'file-change');
    expect(fileChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ changedPaths: ['src/app.ts'] }),
      expect.objectContaining({ changedPaths: ['src/generated.ts'] }),
    ]));

    await expect(adapter.readFileChanges(filePath)).resolves.toMatchObject({
      provider: 'claude',
      changes: [
        { path: 'src/app.ts', kind: 'modified', operation: 'edit', replaceAll: true, original: 'old', modified: 'new' },
        { path: 'src/generated.ts', kind: 'modified', operation: 'write', original: '', modified: 'generated' },
      ],
    });
  });

  it('reads file changes from the exact opaque transcript turn', async () => {
    const fixture = makeFixture('selected-changes');
    const id = sessionId(1);
    const editTurn = (index: number, toolId: string, filePath: string): Record<string, unknown>[] => [
      humanPrompt(fixture.root, id, index, `change ${filePath}`),
      {
        ...envelope(fixture.root, id, index + 1),
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: toolId,
            name: 'Edit',
            input: { file_path: filePath, old_string: 'old', new_string: 'new' },
          }],
          stop_reason: 'tool_use',
        },
      },
      {
        ...envelope(fixture.root, id, index + 2),
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolId, content: 'updated' }],
        },
      },
      {
        ...envelope(fixture.root, id, index + 3),
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
      },
    ];
    const filePath = writeSession(fixture, 1, [
      ...preamble(fixture.root, id),
      ...editTurn(10, 'older-edit', 'src/older.ts'),
      ...editTurn(20, 'newer-edit', 'src/newer.ts'),
    ]);
    const adapter = new ClaudeHistoryAdapter({ homeDir: fixture.home });
    const transcript = await adapter.readTranscript(filePath);
    const selectedTurn = transcript.turns.find((turnEntry) => turnEntry.entries.some((entry) =>
      entry.type === 'activity' && entry.changedPaths?.includes('src/older.ts')));
    if (!selectedTurn) throw new Error('selected Claude turn missing');

    await expect(adapter.readFileChanges(filePath, selectedTurn.id)).resolves.toMatchObject({
      provider: 'claude',
      turnId: selectedTurn.id,
      changes: [{ path: 'src/older.ts', operation: 'edit', original: 'old', modified: 'new' }],
    });
  });
});

describe('ClaudeHistoryAdapter.buildResumeCommand', () => {
  const adapter = new ClaudeHistoryAdapter({ homeDir: os.tmpdir() });

  it('resumes by session id and passes the extra roots to the variadic flag', () => {
    const transcript = path.join('C:\\home\\.claude\\projects\\C--Work', `${sessionId(1)}.jsonl`);

    expect(adapter.buildResumeCommand(transcript, ['C:\\Work', 'C:\\Shared', 'C:\\Docs'])).toEqual({
      commandText: `!claude --resume '${sessionId(1)}' --add-dir 'C:\\\\Shared' 'C:\\\\Docs'`,
      displayCommandText: 'claude resume',
    });
    // The primary root is the shell session's cwd, not a flag: Claude has no
    // equivalent of `codex --cd`.
    expect(adapter.buildResumeCommand(transcript, ['C:\\Work'])).toEqual({
      commandText: `!claude --resume '${sessionId(1)}'`,
      displayCommandText: 'claude resume',
    });
  });

  it('refuses a resume it cannot express', () => {
    const transcript = path.join('C:\\home', `${sessionId(1)}.jsonl`);
    expect(adapter.buildResumeCommand(transcript, [])).toBeNull();
    expect(adapter.buildResumeCommand('C:\\home\\not-a-session.jsonl', ['C:\\Work'])).toBeNull();
  });

  it('starts a new chat at the shell cwd and passes all extras to one variadic flag', () => {
    expect(adapter.buildNewCommand(['C:\\Work', 'C:\\Shared', 'C:\\Docs'])).toEqual({
      commandText: "!claude --add-dir 'C:\\\\Shared' 'C:\\\\Docs'",
      displayCommandText: 'claude',
    });
    expect(adapter.buildNewCommand(['C:\\Work'])).toEqual({
      commandText: '!claude',
      displayCommandText: 'claude',
    });
    expect(adapter.buildNewCommand([])).toBeNull();
  });
});
