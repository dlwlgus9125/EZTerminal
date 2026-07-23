import { describe, expect, it } from 'vitest';

import {
  ANSI_PENDING_MAX_CHARS,
  AnsiHtmlStream,
  ansiToHtml,
} from './ansi';

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

  it('bounds an unterminated OSC carry and degrades it to inert escaped text', () => {
    const stream = new AnsiHtmlStream();
    const opener = `${ESC}]8;;https://example.invalid/${'<img>'.repeat(64)}`;
    const padding = 'x'.repeat(ANSI_PENDING_MAX_CHARS - opener.length);

    const fallback = stream.push(enc(opener + padding));

    expect(stream.diagnostics().pendingChars).toBe(0);
    expect(fallback).not.toContain('<img>');
    expect(fallback).toContain('&lt;img&gt;');
    expect(fallback).toContain('x'.repeat(128));
    expect(stream.push(enc('-after-reset'))).toContain('-after-reset');
  });

  it('flushes a short incomplete control as safe text without retaining carry', () => {
    const stream = new AnsiHtmlStream();

    expect(stream.push(enc(`${ESC}]8;;https://example.invalid`))).toBe('');
    const tail = stream.flush();

    expect(tail).toContain(']8;;https://example.invalid');
    expect(tail).not.toContain(ESC);
    expect(stream.diagnostics().pendingChars).toBe(0);
  });

  it('decodes a multi-byte UTF-8 char split across byte chunks', () => {
    const stream = new AnsiHtmlStream();
    const euro = enc('€'); // 3 bytes: E2 82 AC
    const first = stream.push(euro.slice(0, 2));
    const second = stream.push(euro.slice(2));
    expect((first + second)).toContain('€');
  });

  it('exposes a large PTY frame as ordered, independently parseable fragments', () => {
    const stream = new AnsiHtmlStream();
    const text = 'x'.repeat((ANSI_PENDING_MAX_CHARS * 2) + 17);

    const fragments = stream.pushFragments(enc(text));

    expect(fragments).toHaveLength(3);
    expect(fragments.every((fragment) => fragment.length <= ANSI_PENDING_MAX_CHARS)).toBe(true);
    expect(fragments.join('')).toBe(text);
  });

  it('preserves ANSI state and supplementary Unicode across fragment boundaries', () => {
    const stream = new AnsiHtmlStream();
    const prefix = 'x'.repeat(ANSI_PENDING_MAX_CHARS - 1);
    const fragments = stream.pushFragments(
      enc(`${ESC}[32m${prefix}😀green-after-boundary${ESC}[0m`),
    );

    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.join('')).toContain('😀green-after-boundary');
    expect(fragments.at(-1)).toContain('color:rgb(0,187,0)');
  });
});
