import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** wrap-up.css renders on Android too, so it holds to the WebView 74 floor (its header lists what that rules out). */
const css = readFileSync(resolve(process.cwd(), 'src/renderer/chat/wrap-up/wrap-up.css'), 'utf8')
  .replace(/\r\n/gu, '\n')
  .replace(/\/\*[\s\S]*?\*\//gu, '');

describe('the CLI result line the cards use', () => {
  it('has the same fallback in chat.css (the phone shows the CLI skin too)', () => {
    const chat = readFileSync(resolve(process.cwd(), 'src/renderer/chat/chat.css'), 'utf8').replace(/\r\n/gu, '\n');
    expect(chat).toMatch(/\.chat-cli-result__line \{[^}]*overflow-wrap: break-word;\n\s*overflow-wrap: anywhere;/u);
  });
});

describe('wrap-up.css at the WebView 74 floor', () => {
  it('gives every overflow-wrap: anywhere a break-word fallback on the line before (anywhere needs Chrome 80)', () => {
    const lines = css.split('\n');
    const anywhere = lines.flatMap((line, index) => (line.includes('overflow-wrap: anywhere') ? [index] : []));
    expect(anywhere.length).toBeGreaterThan(0);
    for (const index of anywhere) expect(lines[index - 1]?.trim(), `line before: ${lines[index] ?? ''}`).toBe('overflow-wrap: break-word;');
  });

  it('uses nothing the floor cannot read, and no one-side borders', () => {
    for (const banned of [/color-mix\(/u, /:has\(/u, /(?:^|\s|;)gap:/mu, /(?:^|\s|;)inset:/mu, /aspect-ratio/u, /border-(?:left|right)\s*:/u]) {
      expect(css, String(banned)).not.toMatch(banned);
    }
  });
});
