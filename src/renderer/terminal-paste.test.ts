import { describe, expect, it, vi } from 'vitest';

import { pasteFromTerminalClipboard } from './terminal-paste';

describe('pasteFromTerminalClipboard', () => {
  it('delivers a Codex image shortcut without materializing image data', async () => {
    const deliverImage = vi.fn();
    const deliverText = vi.fn();
    await pasteFromTerminalClipboard({
      isCodex: true,
      mode: 'default',
      readClipboard: async () => ({ hasImage: true, text: 'fallback' }),
      deliverImage,
      deliverText,
    });
    expect(deliverImage).toHaveBeenCalledOnce();
    expect(deliverText).not.toHaveBeenCalled();
  });

  it('confirms risky text and delivers it exactly once', async () => {
    const confirmPaste = vi.fn(async () => true);
    const deliverText = vi.fn();
    await pasteFromTerminalClipboard({
      isCodex: true,
      mode: 'text',
      readClipboard: async () => ({ hasImage: true, text: 'one\ntwo' }),
      confirmPaste,
      deliverImage: vi.fn(),
      deliverText,
    });
    expect(confirmPaste).toHaveBeenCalledWith(expect.objectContaining({ multiline: true, lineCount: 2 }));
    expect(deliverText).toHaveBeenCalledOnce();
    expect(deliverText).toHaveBeenCalledWith('one\ntwo');
  });

  it('sends nothing after warning cancellation', async () => {
    const deliverText = vi.fn();
    await pasteFromTerminalClipboard({
      isCodex: false,
      mode: 'default',
      readClipboard: async () => ({ hasImage: false, text: 'one\ntwo' }),
      confirmPaste: async () => false,
      deliverImage: vi.fn(),
      deliverText,
    });
    expect(deliverText).not.toHaveBeenCalled();
  });

  it.each([
    [{ hasImage: false, text: '' }, 'clipboard-empty'],
    [{ hasImage: true, text: '' }, 'clipboard-no-text'],
  ] as const)('reports unavailable paste data without delivery', async (snapshot, notice) => {
    const notify = vi.fn();
    await pasteFromTerminalClipboard({
      isCodex: false,
      mode: 'default',
      readClipboard: async () => snapshot,
      deliverImage: vi.fn(),
      deliverText: vi.fn(),
      notify,
    });
    expect(notify).toHaveBeenCalledWith(notice);
  });

  it('reports clipboard failures and never calls a delivery adapter', async () => {
    const notify = vi.fn();
    const deliverText = vi.fn();
    await pasteFromTerminalClipboard({
      isCodex: true,
      mode: 'default',
      readClipboard: async () => { throw new Error('denied'); },
      deliverImage: vi.fn(),
      deliverText,
      notify,
    });
    expect(notify).toHaveBeenCalledWith('clipboard-read-failed');
    expect(deliverText).not.toHaveBeenCalled();
  });
});
