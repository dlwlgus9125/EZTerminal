// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { copyTerminalText, writeOwnerDocumentClipboardText } from './terminal-copy';

describe('copyTerminalText', () => {
  it('routes a user copy through the injected writer and reports success to its document', async () => {
    const writeUserClipboardText = vi.fn(async () => true);
    const notifyTerminal = vi.fn();

    await expect(copyTerminalText(
      { writeUserClipboardText, notifyTerminal },
      { text: 'selected output', ownerDocument: document },
    )).resolves.toBe(true);
    expect(writeUserClipboardText).toHaveBeenCalledWith('selected output', document);
    expect(notifyTerminal).toHaveBeenCalledWith('clipboard-write-succeeded', document);
  });

  it.each([
    ['false result', vi.fn(async () => false)],
    ['rejection', vi.fn(async () => { throw new Error('clipboard unavailable'); })],
  ])('reports failure for a %s without leaking the selected text to feedback', async (_label, writer) => {
    const notifyTerminal = vi.fn();

    await expect(copyTerminalText(
      { writeUserClipboardText: writer, notifyTerminal },
      { text: 'private selection', ownerDocument: document },
    )).resolves.toBe(false);
    expect(notifyTerminal).toHaveBeenCalledWith('clipboard-write-failed', document);
    expect(notifyTerminal.mock.calls.flat()).not.toContain('private selection');
  });

  it('does not write or notify for an empty selection', async () => {
    const writeUserClipboardText = vi.fn(async () => true);
    const notifyTerminal = vi.fn();

    await expect(copyTerminalText(
      { writeUserClipboardText, notifyTerminal },
      { text: '', ownerDocument: document },
    )).resolves.toBe(false);
    expect(writeUserClipboardText).not.toHaveBeenCalled();
    expect(notifyTerminal).not.toHaveBeenCalled();
  });

  it('uses the source document Clipboard API only when no host writer is supplied', async () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const ownerDocument = frame.contentDocument!;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(ownerDocument.defaultView!.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    await expect(copyTerminalText(
      { writeUserClipboardText: writeOwnerDocumentClipboardText },
      { text: 'popout selection', ownerDocument },
    ))
      .resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('popout selection');
    frame.remove();
  });
});
