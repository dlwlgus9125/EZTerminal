import { describe, expect, it } from 'vitest';

import { AnsiHtmlStream, ansiToHtml } from './ansi';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const ESC = '\x1b';

describe('ansiToHtml', () => {
  it('converts an SGR color sequence to an inline-styled span', () => {
    const html = ansiToHtml(`${ESC}[31mred${ESC}[0m`);
    expect(html).toContain('<span');
    expect(html).toContain('color:rgb(187,0,0)');
    expect(html).toContain('red');
  });

  it('sanitizes HTML in the source text (no XSS)', () => {
    const html = ansiToHtml('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;/script&gt;');
  });

  it('sanitizes even when wrapped in a color sequence', () => {
    const html = ansiToHtml(`${ESC}[32m<img src=x onerror=alert(1)>${ESC}[0m`);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('AnsiHtmlStream (stateful streaming)', () => {
  it('carries SGR color state across chunk boundaries', () => {
    const stream = new AnsiHtmlStream();
    const a = stream.push(enc(`${ESC}[32mgreen`));
    const b = stream.push(enc('-still-green'));
    expect(a).toContain('color:rgb(0,187,0)');
    // The second chunk is still green because the state persisted.
    expect(b).toContain('color:rgb(0,187,0)');
    expect(b).toContain('still-green');
  });

  it('buffers an escape sequence split across chunks', () => {
    const stream = new AnsiHtmlStream();
    const a = stream.push(enc(`plain${ESC}[3`)); // incomplete escape
    const b = stream.push(enc('1mred')); // completes \x1b[31m
    expect(a).toContain('plain');
    expect(a).not.toContain('[31'); // the partial escape was not leaked as text
    expect(b).toContain('color:rgb(187,0,0)');
    expect(b).toContain('red');
  });

  it('decodes a multi-byte UTF-8 char split across byte chunks', () => {
    const stream = new AnsiHtmlStream();
    const euro = enc('€'); // 3 bytes: E2 82 AC
    const first = stream.push(euro.slice(0, 2));
    const second = stream.push(euro.slice(2));
    expect((first + second)).toContain('€');
  });
});
