import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const stripped = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/gu, '\n').replace(/\/\*[\s\S]*?\*\//gu, '');

/** browser-rows.css renders on Android too, so it holds to the WebView 74 floor (its header lists what that rules out). */
const rows = stripped('src/renderer/chat/browser/browser-rows.css');
const pane = stripped('src/renderer/browser/browser-pane.css');

describe('browser-rows.css at the WebView 74 floor', () => {
  it('gives every overflow-wrap: anywhere a break-word fallback on the line before (anywhere needs Chrome 80)', () => {
    const lines = rows.split('\n');
    const anywhere = lines.flatMap((line, index) => (line.includes('overflow-wrap: anywhere') ? [index] : []));
    expect(anywhere.length).toBeGreaterThan(0);
    for (const index of anywhere) expect(lines[index - 1]?.trim(), `line before: ${lines[index] ?? ''}`).toBe('overflow-wrap: break-word;');
  });

  it('uses nothing the floor cannot read', () => {
    for (const banned of [/color-mix\(/u, /:has\(/u, /(?:^|\s|;)gap:/mu, /(?:^|\s|;)inset:/mu, /aspect-ratio/u]) expect(rows, String(banned)).not.toMatch(banned);
  });

  it('keeps amber on the phone\'s waiting line: nothing else in a row waits on a person', () => {
    const amber = rows.split('}').filter((rule) => rule.includes('--ui-warning'));
    expect(amber.length).toBe(1);
    expect(amber[0]).toContain('.chat-browser-waiting');
  });

  it('makes every action on a phone a thumb target', () => {
    const rule = /\.structured-agent\[data-variant='mobile'\] \.chat-browser-run__toggle,[^{]*\{([^}]*)\}/u.exec(rows)?.[1] ?? '';
    expect(rule).toContain('min-height: 2.75rem');
    expect(rule).toContain('min-width: 2.75rem');
  });
});

describe('an allowed site', () => {
  it('carries a key, never the shield: allowing a site says nothing about whether it is safe', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/browser/BrowserPane.tsx'), 'utf8');
    expect(source).toContain("allowed: 'key'");
    expect(source).not.toMatch(/glyph: 'ok'|: 'ok'/u);
  });
});

describe('the browser\'s CSS', () => {
  it('draws no one-side border, in the rows or on the pane', () => {
    for (const css of [rows, pane]) expect(css).not.toMatch(/border-(?:left|right|top|bottom)\s*:/u);
  });

  it('keeps amber on the pane to the waiting strip and the allow warning', () => {
    const amber = pane.split('}').filter((rule) => rule.includes('--ui-warning')).map((rule) => rule.trim().split('{')[0]?.trim());
    expect(amber).toEqual([".browser-pane__strip[data-tone='amber']", '.browser-allow__warn']);
  });
});
