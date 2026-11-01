import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** The conversation is the phone's main screen, and Android 10's WebView is Chrome 74: found on the device, not here. */
const css = readFileSync(resolve(process.cwd(), 'src/renderer/chat/chat.css'), 'utf8').replace(/\r\n/gu, '\n');

describe('chat.css at the WebView 74 floor', () => {
  it('gives every overflow-wrap: anywhere a break-word fallback on the line before (anywhere needs Chrome 80)', () => {
    const lines = css.split('\n');
    const anywhere = lines.flatMap((line, index) => (line.includes('overflow-wrap: anywhere') ? [index] : []));
    expect(anywhere.length).toBeGreaterThan(0);
    for (const index of anywhere) expect(lines[index - 1]?.trim(), `line ${String(index + 1)}`).toBe('overflow-wrap: break-word;');
  });

  it('centres the send and stop icons without the grid a <button> does not get there', () => {
    const rule = /\.chat-composer__send > svg \{([^}]*)\}/u.exec(css)?.[1] ?? '';
    expect(rule).toContain('display: block');
    expect(rule).toContain('margin: 0 auto');
  });
});
