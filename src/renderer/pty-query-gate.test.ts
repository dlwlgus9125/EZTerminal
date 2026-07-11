import { describe, expect, it } from 'vitest';

import { containsTerminalQuery } from './pty-query-gate';

const ESC = '\x1b';

describe('containsTerminalQuery (mirror auto-reply gate)', () => {
  it('detects the queries xterm auto-answers', () => {
    expect(containsTerminalQuery(`${ESC}[c`)).toBe(true); // DA1
    expect(containsTerminalQuery(`${ESC}[0c`)).toBe(true); // DA1 with param
    expect(containsTerminalQuery(`${ESC}[>c`)).toBe(true); // DA2
    expect(containsTerminalQuery(`${ESC}[=0c`)).toBe(true); // DA3
    expect(containsTerminalQuery(`${ESC}[5n`)).toBe(true); // DSR status
    expect(containsTerminalQuery(`${ESC}[6n`)).toBe(true); // CPR
    expect(containsTerminalQuery(`${ESC}[?2026$p`)).toBe(true); // DECRQM
    expect(containsTerminalQuery(`${ESC}[>0q`)).toBe(true); // XTVERSION (claude burst)
    expect(containsTerminalQuery(`${ESC}[x`)).toBe(true); // DECREQTPARM
    expect(containsTerminalQuery(`${ESC}]10;?\x07`)).toBe(true); // OSC fg color query
    expect(containsTerminalQuery(`${ESC}]11;?${ESC}\\`)).toBe(true); // OSC bg color query
  });

  it('detects the bundled-ConPTY startup preamble (the ring-replay case the gate exists for)', () => {
    expect(containsTerminalQuery(`${ESC}[1t${ESC}[c${ESC}[?1004h${ESC}[?9001h`)).toBe(true);
  });

  it('does NOT flag ordinary TUI repaint traffic (claude-style animation frames)', () => {
    const frame =
      `${ESC}[?25l${ESC}[H${ESC}[38;2;215;119;87m spinner ✻ ${ESC}[39m` +
      `${ESC}[2;1H${ESC}[48;2;0;0;0mstatus 5h:[#-------]16%${ESC}[49m${ESC}[?25h`;
    expect(containsTerminalQuery(frame)).toBe(false);
  });

  it('does NOT flag user-input-shaped bytes (mouse reports, arrows, bracketed paste)', () => {
    expect(containsTerminalQuery(`${ESC}[<64;56;21M`)).toBe(false); // SGR wheel report
    expect(containsTerminalQuery(`${ESC}[A${ESC}[B`)).toBe(false); // arrows
    expect(containsTerminalQuery(`${ESC}[200~hello${ESC}[201~`)).toBe(false); // paste framing
    expect(containsTerminalQuery('plain typed text 123')).toBe(false);
  });

  it('does NOT confuse SGR/cursor sequences ending in other finals', () => {
    expect(containsTerminalQuery(`${ESC}[5C`)).toBe(false); // cursor forward (uppercase C)
    expect(containsTerminalQuery(`${ESC}[38;2;1;2;3m`)).toBe(false); // SGR color
    expect(containsTerminalQuery(`${ESC}]0;title${ESC}\\`)).toBe(false); // OSC title, no query
  });
});
