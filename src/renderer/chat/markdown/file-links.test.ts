import { describe, expect, it } from 'vitest';

import {
  findFileReferences,
  isFileReference,
  normalizeChatLinkHref,
  parseFileReference,
} from './file-links';

describe('file references', () => {
  it('accepts path-shaped inline code and rejects versions, words and URLs', () => {
    for (const path of [
      'README.md',
      '.gitignore',
      'src/app.ts:42',
      'src/app.ts:42:7',
      './scripts/build.mjs',
      '../shared/x.ts',
      '~/notes.txt',
      'C:\\Working\\EZTerminal\\package.json',
      '/etc/hosts',
      'src/renderer/chat',
      'packages/@scope/pkg/index.d.ts',
    ]) {
      expect(isFileReference(path), path).toBe(true);
    }
    for (const text of ['1.2.3', 'v1.2.3', 'hello', 'npm run build', 'https://example.com/a.ts', 'src/', 'a.b c.d']) {
      expect(isFileReference(text), text).toBe(false);
    }
  });

  it('finds paths in prose with punctuation and Korean particles around them', () => {
    expect(findFileReferences('Open src/app.ts:42, then README.md.').map((match) => match.text))
      .toEqual(['src/app.ts:42', 'README.md']);
    expect(findFileReferences('(see docs/ROADMAP.md) and "package.json"').map((match) => match.text))
      .toEqual(['docs/ROADMAP.md', 'package.json']);
    expect(findFileReferences('README.md를 확인하고 src/main.ts에서 수정했습니다').map((match) => match.text))
      .toEqual(['README.md', 'src/main.ts']);
    expect(findFileReferences('Version 1.2.3 shipped').map((match) => match.text)).toEqual([]);
  });

  it('reports offsets of each prose match', () => {
    const text = 'a src/x.ts b';
    expect(findFileReferences(text)).toEqual([{ text: 'src/x.ts', index: 2 }]);
  });

  it('parses a trailing line and column into a resolver target', () => {
    expect(parseFileReference('src/app.ts:42')).toEqual({ path: 'src/app.ts', line: 42 });
    expect(parseFileReference('src/app.ts:42:7')).toEqual({ path: 'src/app.ts', line: 42 });
    expect(parseFileReference('C:\\repo\\a.ts:3')).toEqual({ path: 'C:\\repo\\a.ts', line: 3 });
    expect(parseFileReference('README.md')).toEqual({ path: 'README.md' });
    expect(parseFileReference('not a path')).toBeUndefined();
  });
});

describe('normalizeChatLinkHref', () => {
  it('passes http(s) and mailto and drops every other scheme', () => {
    expect(normalizeChatLinkHref('https://example.com/a b')).toBe('https://example.com/a%20b');
    expect(normalizeChatLinkHref('http://example.com')).toBe('http://example.com/');
    expect(normalizeChatLinkHref('mailto:dev@example.com')).toBe('mailto:dev@example.com');
    expect(normalizeChatLinkHref('javascript:alert(1)')).toBeUndefined();
    expect(normalizeChatLinkHref('file:///C:/secret.txt')).toBeUndefined();
    expect(normalizeChatLinkHref('vscode://file/a.ts')).toBeUndefined();
    expect(normalizeChatLinkHref('https://user:pass@example.com')).toBeUndefined();
    expect(normalizeChatLinkHref('mailto:')).toBeUndefined();
    expect(normalizeChatLinkHref('src/app.ts')).toBeUndefined();
    expect(normalizeChatLinkHref(undefined)).toBeUndefined();
  });
});
