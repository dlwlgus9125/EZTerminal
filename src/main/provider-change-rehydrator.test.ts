import { describe, expect, it } from 'vitest';

import type { ProviderFileChangeRecord } from './agent-history-provider';
import { rehydrateProviderChanges } from './provider-change-rehydrator';

function edit(original: string, modified: string): ProviderFileChangeRecord {
  return { path: 'src/app.ts', kind: 'modified', original, modified };
}

describe('rehydrateProviderChanges', () => {
  it('places a provider edit inside the complete current file', () => {
    expect(rehydrateProviderChanges(
      'header\nconst value = 2;\nfooter\n',
      [edit('const value = 1;', 'const value = 2;')],
    )).toEqual({
      ok: true,
      original: 'header\nconst value = 1;\nfooter\n',
      modified: 'header\nconst value = 2;\nfooter\n',
    });
  });

  it('reverses ordered edits to the same file and verifies them forward', () => {
    expect(rehydrateProviderChanges(
      'header\nbeta\ndelta\npost-turn context\n',
      [edit('alpha', 'beta'), edit('gamma', 'delta')],
    )).toEqual({
      ok: true,
      original: 'header\nalpha\ngamma\npost-turn context\n',
      modified: 'header\nbeta\ndelta\npost-turn context\n',
    });
  });

  it('strictly reverses a unified patch with complete surrounding context', () => {
    expect(rehydrateProviderChanges(
      'header\nnew value\nfooter\n',
      [{
        path: 'src/app.ts',
        kind: 'modified',
        diff: '@@ -1,3 +1,3 @@\n header\n-old value\n+new value\n footer',
      }],
    )).toEqual({
      ok: true,
      original: 'header\nold value\nfooter\n',
      modified: 'header\nnew value\nfooter\n',
    });
  });

  it('applies multiple unified hunks in reverse without shifting earlier positions', () => {
    expect(rehydrateProviderChanges(
      'one\nnew-a\nmiddle\nnew-b\nlast\n',
      [{
        path: 'src/app.ts',
        kind: 'modified',
        diff: [
          '@@ -1,2 +1,2 @@',
          ' one',
          '-old-a',
          '+new-a',
          '@@ -4,2 +4,2 @@',
          '-old-b',
          '+new-b',
          ' last',
        ].join('\n'),
      }],
    )).toEqual({
      ok: true,
      original: 'one\nold-a\nmiddle\nold-b\nlast\n',
      modified: 'one\nnew-a\nmiddle\nnew-b\nlast\n',
    });
  });

  it('normalizes CRLF only after an exact line-level patch match', () => {
    expect(rehydrateProviderChanges('old header\r\nnew\r\n', [{
      path: 'src/app.ts',
      kind: 'modified',
      diff: '@@ -1,2 +1,2 @@\n old header\n-old\n+new',
    }])).toEqual({
      ok: true,
      original: 'old header\nold\n',
      modified: 'old header\nnew\n',
    });
  });

  it('relocates a hunk only when its complete modified-side sequence is unique', () => {
    expect(rehydrateProviderChanges(
      'inserted later\nheader\nnew value\nfooter\n',
      [{
        path: 'src/app.ts',
        kind: 'modified',
        diff: '@@ -1,3 +1,3 @@\n header\n-old value\n+new value\n footer',
      }],
    )).toEqual({
      ok: true,
      original: 'inserted later\nheader\nold value\nfooter\n',
      modified: 'inserted later\nheader\nnew value\nfooter\n',
    });
    expect(rehydrateProviderChanges(
      'header\nnew value\nfooter\nheader\nnew value\nfooter\n',
      [{
        path: 'src/app.ts',
        kind: 'modified',
        diff: '@@ -20,3 +20,3 @@\n header\n-old value\n+new value\n footer',
      }],
    )).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('treats a raw added-file record as a complete file only on an exact match', () => {
    expect(rehydrateProviderChanges('export const added = true;\n', [{
      path: 'src/added.ts',
      kind: 'added',
      diff: 'export const added = true;\n',
    }])).toEqual({
      ok: true,
      original: '',
      modified: 'export const added = true;\n',
    });
    expect(rehydrateProviderChanges('later content\n', [{
      path: 'src/added.ts',
      kind: 'added',
      diff: 'original content\n',
    }])).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects an ambiguous fragment instead of guessing its position', () => {
    expect(rehydrateProviderChanges('new\nnew\n', [edit('old', 'new')]))
      .toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('falls back atomically when any ordered record no longer matches', () => {
    expect(rehydrateProviderChanges(
      'missing-first\ndelta\n',
      [edit('alpha', 'beta'), edit('gamma', 'delta')],
    )).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects malformed or newline-ambiguous patches', () => {
    expect(rehydrateProviderChanges('new\n', [{
      path: 'src/app.ts',
      kind: 'modified',
      diff: '@@ malformed @@\n-old\n+new',
    }])).toEqual({ ok: false, reason: 'malformed-patch' });
    expect(rehydrateProviderChanges('new', [{
      path: 'src/app.ts',
      kind: 'modified',
      diff: '@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file',
    }])).toEqual({ ok: false, reason: 'unsupported-newline' });
  });

  it('rejects Write and replace-all records without a complete before snapshot', () => {
    expect(rehydrateProviderChanges('generated\n', [{
      ...edit('', 'generated\n'),
      operation: 'write',
    }])).toEqual({ ok: false, reason: 'unsupported-record' });
    expect(rehydrateProviderChanges('new new\n', [{
      ...edit('old', 'new'),
      operation: 'edit',
      replaceAll: true,
    }])).toEqual({ ok: false, reason: 'ambiguous' });
  });
});
