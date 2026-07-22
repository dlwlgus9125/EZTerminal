import type { TerminalClipboardSnapshot } from '../shared/terminal-clipboard';

interface ClipboardReader {
  readonly readText: () => string;
  readonly readImage: () => { readonly isEmpty: () => boolean };
}

/** Keep the privileged Electron clipboard object in main. The isolated
 * renderer receives only the minimum routing snapshot it needs. */
export function readTerminalClipboardSnapshot(
  clipboardReader: ClipboardReader,
): TerminalClipboardSnapshot {
  const image = clipboardReader.readImage();
  return {
    hasImage: !image.isEmpty(),
    text: clipboardReader.readText(),
  };
}
