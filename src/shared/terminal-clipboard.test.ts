import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TERMINAL_PASTE_PREFERENCES,
  LARGE_PASTE_BYTES,
  assessTerminalPasteRisk,
  resolveTerminalPaste,
} from './terminal-clipboard';

describe('terminal clipboard policy', () => {
  it('lets Codex own an image-bearing default paste, including mixed clipboards', () => {
    expect(resolveTerminalPaste({ hasImage: true, text: '' }, true, 'default'))
      .toEqual({ kind: 'codex-image' });
    expect(resolveTerminalPaste({ hasImage: true, text: 'fallback URL' }, true, 'default'))
      .toEqual({ kind: 'codex-image' });
  });

  it('uses text for explicit-text paste and for generic PTYs', () => {
    expect(resolveTerminalPaste({ hasImage: true, text: 'caption' }, true, 'text'))
      .toEqual({ kind: 'text', text: 'caption' });
    expect(resolveTerminalPaste({ hasImage: true, text: 'caption' }, false, 'default'))
      .toEqual({ kind: 'text', text: 'caption' });
  });

  it('does not invent text for empty or image-only generic clipboards', () => {
    expect(resolveTerminalPaste({ hasImage: false, text: '' }, true, 'default'))
      .toEqual({ kind: 'empty' });
    expect(resolveTerminalPaste({ hasImage: true, text: '' }, false, 'default'))
      .toEqual({ kind: 'no-text' });
    expect(resolveTerminalPaste({ hasImage: true, text: '' }, true, 'text'))
      .toEqual({ kind: 'no-text' });
  });

  it('detects multiline and UTF-8 byte-size risks at exact boundaries', () => {
    expect(assessTerminalPasteRisk('one\ntwo', DEFAULT_TERMINAL_PASTE_PREFERENCES)).toMatchObject({
      multiline: true,
      large: false,
      lineCount: 2,
    });
    expect(assessTerminalPasteRisk('a'.repeat(LARGE_PASTE_BYTES), DEFAULT_TERMINAL_PASTE_PREFERENCES).large)
      .toBe(false);
    expect(assessTerminalPasteRisk('a'.repeat(LARGE_PASTE_BYTES + 1), DEFAULT_TERMINAL_PASTE_PREFERENCES).large)
      .toBe(true);
    expect(assessTerminalPasteRisk('가'.repeat(1_708), DEFAULT_TERMINAL_PASTE_PREFERENCES).large)
      .toBe(true);
  });

  it('honors independent warning preferences while retaining metadata', () => {
    expect(assessTerminalPasteRisk('one\ntwo', { warnOnMultiline: false, warnOnLarge: true }))
      .toMatchObject({ multiline: false, large: false, lineCount: 2 });
    expect(assessTerminalPasteRisk('a'.repeat(LARGE_PASTE_BYTES + 1), {
      warnOnMultiline: true,
      warnOnLarge: false,
    })).toMatchObject({ multiline: false, large: false, byteLength: LARGE_PASTE_BYTES + 1 });
  });
});
