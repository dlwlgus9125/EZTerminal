import { describe, expect, it, vi } from 'vitest';

import { readTerminalClipboardSnapshot } from './terminal-clipboard';

describe('readTerminalClipboardSnapshot', () => {
  it('returns only image presence and text', () => {
    const readText = vi.fn(() => 'copied text');
    const isEmpty = vi.fn(() => false);
    expect(readTerminalClipboardSnapshot({ readText, readImage: () => ({ isEmpty }) })).toEqual({
      hasImage: true,
      text: 'copied text',
    });
    expect(readText).toHaveBeenCalledOnce();
    expect(isEmpty).toHaveBeenCalledOnce();
  });

  it('does not expose an image object when no text is present', () => {
    const image = { isEmpty: () => false, secretBytes: new Uint8Array([1, 2, 3]) };
    const snapshot = readTerminalClipboardSnapshot({ readText: () => '', readImage: () => image });
    expect(snapshot).toEqual({ hasImage: true, text: '' });
    expect(snapshot).not.toHaveProperty('image');
    expect(snapshot).not.toHaveProperty('path');
  });
});
