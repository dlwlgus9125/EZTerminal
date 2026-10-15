import { describe, expect, it } from 'vitest';
import { claudeFileChange, conversationFileChanges, decodeFileChanges, encodeFileChanges, reviewLines } from './conversation-changes';
import type { DaemonTranscriptItem } from './daemon-protocol';

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
