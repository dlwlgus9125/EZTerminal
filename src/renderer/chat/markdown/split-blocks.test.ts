import { describe, expect, it } from 'vitest';

import { splitMarkdownBlocks } from './split-blocks';

const texts = (markdown: string): string[] => splitMarkdownBlocks(markdown).map((block) => block.text);

describe('splitMarkdownBlocks', () => {
  it('splits top-level blocks at blank lines and reports their source offsets', () => {
    const markdown = '# Title\n\nFirst paragraph\ncontinues.\n\n\n> quote\n\n---';
    const blocks = splitMarkdownBlocks(markdown);
    expect(blocks.map((block) => block.text)).toEqual(['# Title', 'First paragraph\ncontinues.', '> quote', '---']);
    for (const block of blocks) expect(markdown.slice(block.start, block.start + block.text.length)).toBe(block.text);
  });

  it('returns nothing for empty or blank input and drops leading and trailing blank lines', () => {
    expect(texts('')).toEqual([]);
    expect(texts('\n\n  \n')).toEqual([]);
    expect(texts('\n\nHello\n\n')).toEqual(['Hello']);
  });

  it('never splits inside a fence, whatever the marker or length', () => {
    const markdown = [
      'Before',
      '',
      '```ts',
      'const a = 1;',
      '',
      'const b = 2;',
      '```',
      '',
      '````md',
      '```',
      '',
      'inner fence text',
      '```',
      '````',
      '',
      '~~~',
      'tilde',
      '',
      '~~~',
      '',
      'After',
    ].join('\n');
    expect(texts(markdown)).toEqual([
      'Before',
      '```ts\nconst a = 1;\n\nconst b = 2;\n```',
      '````md\n```\n\ninner fence text\n```\n````',
      '~~~\ntilde\n\n~~~',
      'After',
    ]);
  });

  it('treats a one-line ```code``` span as text, not a fence', () => {
    expect(texts('Use ```npm i``` here\n\nNext')).toEqual(['Use ```npm i``` here', 'Next']);
  });

  it('keeps loose lists, nested lists and indented continuations in one block', () => {
    const markdown = [
      '1. First step',
      '',
      '   Continuation paragraph.',
      '',
      '   ```bash',
      '   npm test',
      '',
      '   ```',
      '',
      '2. Second step',
      '   - nested',
      '',
      '     - deeper',
      '',
      'Closing paragraph.',
    ].join('\n');
    expect(texts(markdown)).toEqual([
      markdown.slice(0, markdown.indexOf('\n\nClosing')),
      'Closing paragraph.',
    ]);
  });

  it('keeps blank-separated bullet items together but splits a paragraph from a following list', () => {
    expect(texts('- a\n\n- b\n\n* c')).toEqual(['- a\n\n- b\n\n* c']);
    expect(texts('Intro\n\n- a\n- b')).toEqual(['Intro', '- a\n- b']);
  });

  it('keeps an HTML comment that spans blank lines in one block', () => {
    expect(texts('<!-- note\n\nstill comment -->\n\nText')).toEqual(['<!-- note\n\nstill comment -->', 'Text']);
  });

  it('parses messages with reference definitions or footnotes as one block', () => {
    const markdown = 'See [docs][1] and a note[^n].\n\n[1]: https://example.com\n\n[^n]: Footnote.';
    expect(texts(markdown)).toEqual([markdown]);
  });

  it('handles CRLF line endings', () => {
    // The carriage return stays with its line; markdown parsing ignores it.
    expect(texts('One\r\n\r\nTwo\r\n')).toEqual(['One\r', 'Two\r']);
  });

  it('gives a streaming tail with a half-open fence everything after the fence', () => {
    const markdown = 'Here is the fix:\n\n```ts\nexport function a() {\n\n  return 1;\n';
    const blocks = splitMarkdownBlocks(markdown);
    expect(blocks.map((block) => block.text)).toEqual([
      'Here is the fix:',
      '```ts\nexport function a() {\n\n  return 1;\n',
    ]);
    expect(blocks[1]!.start).toBe(markdown.indexOf('```'));
  });

  it('only ever changes the tail as a reply streams in', () => {
    const final = 'Intro paragraph.\n\n- one\n- two\n\n```js\nlet x = 1;\n\nx++;\n```\n\nDone.';
    let previous: string[] = [];
    for (let length = 1; length <= final.length; length += 1) {
      const current = texts(final.slice(0, length));
      // Every block except the last must already exist unchanged in the next
      // snapshot, otherwise the per-block memo would re-render settled blocks.
      for (let index = 0; index < previous.length - 1; index += 1) {
        expect(current[index]).toBe(previous[index]);
      }
      previous = current;
    }
    expect(previous).toEqual(['Intro paragraph.', '- one\n- two', '```js\nlet x = 1;\n\nx++;\n```', 'Done.']);
  });
});
