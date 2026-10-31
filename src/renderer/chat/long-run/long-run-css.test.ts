import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** long-run.css renders on Android too, so it holds to the WebView 74 floor (its header lists what that rules out). */
const css = readFileSync(resolve(process.cwd(), 'src/renderer/chat/long-run/long-run.css'), 'utf8')
  .replace(/\r\n/gu, '\n')
  .replace(/\/\*[\s\S]*?\*\//gu, '');

describe('long-run.css at the WebView 74 floor', () => {
  it('gives every overflow-wrap: anywhere a break-word fallback on the line before (anywhere needs Chrome 80)', () => {
    const lines = css.split('\n');
    const anywhere = lines.flatMap((line, index) => (line.includes('overflow-wrap: anywhere') ? [index] : []));
    expect(anywhere.length).toBeGreaterThan(0);
    for (const index of anywhere) expect(lines[index - 1]?.trim(), `line before: ${lines[index] ?? ''}`).toBe('overflow-wrap: break-word;');
  });

  it('uses nothing the floor cannot read, no one-side borders and no amber', () => {
    for (const banned of [/color-mix\(/u, /:has\(/u, /(?:^|\s|;)gap:/mu, /(?:^|\s|;)inset:/mu, /aspect-ratio/u, /border-(?:left|right|top|bottom)\s*:/u, /--ui-warning/u]) {
      expect(css, String(banned)).not.toMatch(banned);
    }
  });

  it('touches the existing message box only through the attribute a long-run box carries', () => {
    const shared = css.split('\n').filter((line) => /\.chat-composer__(?:bar|send|stop)|\.structured-agent-composer__hint/u.test(line));
    expect(shared.length).toBeGreaterThan(0);
    for (const line of shared) expect(line).toContain('[data-long-run]');
  });
});
