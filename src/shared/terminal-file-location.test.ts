import { describe, expect, it } from 'vitest';

import { findTerminalFileLinkAtOffset, findTerminalFileLinks } from './terminal-file-location';

describe('findTerminalFileLinks', () => {
  it('extracts Windows, POSIX and relative paths with optional line/column', () => {
    const line = 'at C:\\repo\\src\\a.ts:12:4, then ./docs/readme.md:7 and /tmp/x.txt';
    expect(findTerminalFileLinks(line)).toEqual([
      expect.objectContaining({ text: 'C:\\repo\\src\\a.ts:12:4', path: 'C:\\repo\\src\\a.ts', line: 12, column: 4 }),
      expect.objectContaining({ text: './docs/readme.md:7', path: './docs/readme.md', line: 7 }),
      expect.objectContaining({ text: '/tmp/x.txt', path: '/tmp/x.txt' }),
    ]);
  });

  it('does not turn ordinary words, URLs or malformed zero locations into links', () => {
    expect(findTerminalFileLinks('hello https://example.com foo.ts')).toEqual([]);
    expect(findTerminalFileLinks('./a.ts:0')).toEqual([
      expect.objectContaining({ path: './a.ts:0', line: undefined }),
    ]);
  });

  it('maps a plain-terminal caret offset to the path on that line only', () => {
    const text = 'first ./a.ts:3\nsecond C:\\repo\\b.ts:9:2 done';
    expect(findTerminalFileLinkAtOffset(text, text.indexOf('a.ts') + 1)).toEqual(
      expect.objectContaining({ path: './a.ts', line: 3 }),
    );
    expect(findTerminalFileLinkAtOffset(text, text.indexOf('b.ts') + 1)).toEqual(
      expect.objectContaining({ path: 'C:\\repo\\b.ts', line: 9, column: 2 }),
    );
    expect(findTerminalFileLinkAtOffset(text, text.indexOf('second'))).toBeNull();
  });
});
