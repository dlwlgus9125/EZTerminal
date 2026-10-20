import { describe, expect, it } from 'vitest';
import { addedFileChange, claudeFileChange, conversationFileChanges, decodeFileChanges, deletedFileChange, diffCounts, encodeFileChanges, gitDiffFileChanges, normalizeRecordedChange, patchKind, replacementLines, reviewLines, structuredPatchChange } from './conversation-changes';
import type { DaemonTranscriptItem } from './daemon-protocol';



describe('gitDiffFileChanges', () => {
  const diff = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,3 +1,3 @@',
    ' keep',
    '--- removed line that starts with dashes',
    '+added',
    'diff --git a/old.md b/old.md',
    'deleted file mode 100644',
    'index 3333333..0000000',
    '--- a/old.md',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
    '',
  ].join('\n');

  it('splits a multi-file git diff into one numbered change per file without its header lines', () => {
    const changes = gitDiffFileChanges(diff);
    expect(changes.map((change) => change.path)).toEqual(['src/app.ts', 'old.md']);
    expect(changes[0]).toEqual({ path: 'src/app.ts', coverage: 'patch', patch: '@@ -1,3 +1,3 @@\n keep\n--- removed line that starts with dashes\n+added' });
    expect(reviewLines(changes[0]!).find((line) => line.kind === 'remove')).toMatchObject({ before: 2 });
    expect(changes[1]!.patch).toBe('@@ -1 +0,0 @@\n-gone');
  });

  it('returns nothing for text that is not a git diff', () => {
    expect(gitDiffFileChanges('No file changes from the base commit.')).toEqual([]);
  });
});

describe('replacementLines', () => {
  it('keeps unchanged lines as context and shows only what an edit adds', () => {
    expect(replacementLines('  return a;\n}', '  return a;\n}\n\nexport function b() {}\n')).toEqual([
      '   return a;', ' }', '+', '+export function b() {}',
    ]);
  });

  it('shows a changed middle line as one removal and one addition', () => {
    expect(replacementLines('a\nb\nc', 'a\nB\nc')).toEqual([' a', '-b', '+B', ' c']);
  });

  it('groups each changed run as removals, then additions', () => {
    expect(replacementLines('a\nb\nc\nd', 'a\nx\ny\nd')).toEqual([' a', '-b', '-c', '+x', '+y', ' d']);
  });

  it('falls back to remove-all/add-all for very large replacements', () => {
    const before = Array.from({ length: 900 }, (_, index) => `old ${index}`).join('\n');
    const after = Array.from({ length: 900 }, (_, index) => `new ${index}`).join('\n');
    const lines = replacementLines(before, after);
    expect(lines.filter((line) => line.startsWith('-'))).toHaveLength(900);
    expect(lines.filter((line) => line.startsWith('+'))).toHaveLength(900);
  });

  it('feeds Claude Edit records, so the change view shows context instead of a full rewrite', () => {
    expect(claudeFileChange('Edit', { file_path: 'src/app.ts', old_string: 'a\nb', new_string: 'a\nb\nc' })?.patch)
      .toBe(' a\n b\n+c');
  });
});

describe('recorded conversation changes', () => {
  it('keeps patch identity and filters other sessions, sensitive data, calls and incomplete deltas', () => {
    const text = encodeFileChanges([{ path: 'src/a.ts', patch: '@@ -8,2 +8,2 @@\n-old\n+new\n context', coverage: 'patch' }])!;
    const record: DaemonTranscriptItem = { id: 'result', sessionId: 'a', turnId: 'turn', sequence: 3, kind: 'tool-result', text, isDelta: false, isSensitive: false, createdAt: '2026-10-14T00:00:00Z' };
    const changes = conversationFileChanges([record, { ...record, sessionId: 'b' }, { ...record, isSensitive: true }, { ...record, isDelta: true }, { ...record, kind: 'tool-call' }], 'a');
    expect(changes).toHaveLength(1); expect(changes[0].id).toBe('result:0');
    expect(reviewLines(changes[0])).toEqual([
      { text: '@@ -8,2 +8,2 @@', kind: 'header' }, { text: '-old', kind: 'remove', before: 8 },
      { text: '+new', kind: 'add', after: 8 }, { text: ' context', kind: 'context', before: 9, after: 9 },
    ]);
  });
  it('treats a final newline as the end of the last line, not an extra added line', () => {
    expect(claudeFileChange('Write', { file_path: 'notes.md', content: 'One line.\n' })!.patch).toBe('+One line.');
    expect(claudeFileChange('Edit', { file_path: 'a.ts', old_string: 'a\r\n', new_string: 'b\n' })!.patch).toBe('-a\n+b');
    expect(claudeFileChange('Write', { file_path: 'blank.md', content: 'x\n\n' })!.patch).toBe('+x\n+');
  });
  it('records every replacement of a MultiEdit', () => {
    const change = claudeFileChange('MultiEdit', { file_path: 'a.ts', edits: [
      { old_string: 'one', new_string: 'uno' }, { old_string: 'two\n', new_string: 'dos\n' }, { old_string: 1 },
    ] })!;
    expect(change).toEqual({ path: 'a.ts', coverage: 'fragment', patch: '-one\n+uno\n-two\n+dos' });
    expect(claudeFileChange('MultiEdit', { file_path: 'a.ts', edits: [] })).toBeUndefined();
  });
  it('does not invent file line numbers for a partial Edit or Write operation', () => {
    const edit = claudeFileChange('Edit', { file_path: 'a.ts', old_string: 'old', new_string: 'new' })!;
    expect(edit.coverage).toBe('fragment');
    expect(reviewLines(edit).every(line => line.before === undefined && line.after === undefined)).toBe(true);
    expect(claudeFileChange('Bash', { file_path: 'a.ts', content: 'pretend' })).toBeUndefined();
    expect(decodeFileChanges('arbitrary tool output')).toEqual([]);
    expect(decodeFileChanges('{"type":"ezterminal.file-changes.v1","changes":[{"path":"a"}]}')).toEqual([]);
    expect(encodeFileChanges([{ path: 'a', patch: 'x'.repeat(900_001), coverage: 'patch' }])).toBeUndefined();
  });
});

describe('numbered change records', () => {
  it('builds a numbered patch from the hunks Claude reports for an edit', () => {
    const change = structuredPatchChange('src/app.ts', [
      { oldStart: 3, oldLines: 3, newStart: 3, newLines: 3, lines: [' }', '-  console.log(greet());', '+  console.log(greetUser());'] },
      { oldStart: 20, oldLines: 1, newStart: 20, newLines: 2, lines: [' end', '+tail'] },
    ])!;
    expect(change).toEqual({
      path: 'src/app.ts',
      coverage: 'patch',
      patch: '@@ -3,3 +3,3 @@\n }\n-  console.log(greet());\n+  console.log(greetUser());\n@@ -20,1 +20,2 @@\n end\n+tail',
    });
    expect(reviewLines(change).filter((line) => line.kind === 'add').map((line) => line.after)).toEqual([4, 21]);
    expect(diffCounts(change)).toEqual({ added: 2, removed: 1 });
  });

  it('a patch ending in a newline has no extra empty context line', () => {
    const lines = reviewLines({ path: 'a.ts', coverage: 'patch', patch: '@@ -1,1 +1,1 @@\n-a\n+b\n' });
    expect(lines.map((line) => line.kind)).toEqual(['header', 'remove', 'add']);
  });

  it('keeps the fragment when the reported hunks are missing or malformed', () => {
    expect(structuredPatchChange('a.ts', [])).toBeUndefined();
    expect(structuredPatchChange('a.ts', [{ oldStart: 1, lines: ['+x'] }])).toBeUndefined();
    expect(structuredPatchChange('a.ts', 'not hunks')).toBeUndefined();
  });

  it('numbers a created or removed file from its content', () => {
    expect(addedFileChange('notes.md', 'one\ntwo\n')).toEqual({ path: 'notes.md', coverage: 'patch', patch: '@@ -0,0 +1,2 @@\n+one\n+two' });
    expect(deletedFileChange('old.md', 'gone\n')).toEqual({ path: 'old.md', coverage: 'patch', patch: '@@ -1,1 +0,0 @@\n-gone' });
    expect(addedFileChange('empty.md', '')).toEqual({ path: 'empty.md', coverage: 'patch', patch: '@@ -0,0 +0,0 @@' });
    expect(patchKind(addedFileChange('n.md', 'x'))).toBe('add');
    expect(patchKind(deletedFileChange('n.md', 'x'))).toBe('delete');
    expect(patchKind({ path: 'a', coverage: 'patch', patch: '@@ -1,1 +1,1 @@\n-a\n+b' })).toBe('update');
    expect(patchKind({ path: 'a', coverage: 'fragment', patch: '+a' })).toBe('update');
  });

  it('repairs an older Codex record that stored a created file as raw content', () => {
    const raw = { path: 'notes.md', coverage: 'patch' as const, patch: 'Renamed greet to greetUser.\n' };
    expect(normalizeRecordedChange(raw, 'add')).toEqual(addedFileChange('notes.md', 'Renamed greet to greetUser.\n'));
    expect(normalizeRecordedChange(raw, 'delete').patch).toBe('@@ -1,1 +0,0 @@\n-Renamed greet to greetUser.');
    // Without a reported kind, or with hunks already, nothing is guessed.
    expect(normalizeRecordedChange(raw)).toBe(raw);
    const numbered = { path: 'a.ts', coverage: 'patch' as const, patch: '@@ -1,1 +1,1 @@\n-a\n+b' };
    expect(normalizeRecordedChange(numbered, 'add')).toBe(numbered);
    const fragment = { path: 'a.ts', coverage: 'fragment' as const, patch: '+a' };
    expect(normalizeRecordedChange(fragment, 'add')).toBe(fragment);
  });

  it('gives each conversation change its kind, counts and time, using the result payload', () => {
    const text = encodeFileChanges([
      { path: 'notes.md', patch: 'hello\nworld\n', coverage: 'patch' },
      { path: 'src/app.ts', patch: '@@ -1,2 +1,2 @@\n-a\n+b\n c', coverage: 'patch' },
    ])!;
    const item: DaemonTranscriptItem = {
      id: 'r', sessionId: 's', turnId: 't', sequence: 9, kind: 'tool-result', text, isDelta: false, isSensitive: false,
      createdAt: '2026-10-20T01:02:03Z',
      payload: { v: 1, type: 'tool', callId: 'c', name: 'fileChange', category: 'edit', phase: 'result', status: 'completed',
        files: [{ path: 'notes.md', kind: 'add', added: 2, removed: 0 }, { path: 'src/app.ts', kind: 'update', added: 1, removed: 1 }] },
    };
    const [created, updated] = conversationFileChanges([item], 's');
    expect(created).toMatchObject({ id: 'r:0', path: 'notes.md', kind: 'add', added: 2, removed: 0, createdAt: '2026-10-20T01:02:03Z', patch: '@@ -0,0 +1,2 @@\n+hello\n+world' });
    expect(updated).toMatchObject({ id: 'r:1', kind: 'update', added: 1, removed: 1 });
  });
});
