import type { TerminalClipboardSnapshot } from '../shared/terminal-clipboard';

interface ClipboardReader {
  readonly readText: () => string;
  readonly readImage: () => { readonly isEmpty: () => boolean };
}

interface ClipboardWriter {
  readonly writeText: (text: string) => void;
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

/** User-initiated terminal copy belongs to main's OS clipboard boundary.
 * Invalid or failed writes return false without logging the selected text. */
export function writeTerminalClipboardText(
  clipboardWriter: ClipboardWriter,
  text: unknown,
): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  try {
    clipboardWriter.writeText(text);
    return true;
  } catch {
    return false;
  }
}
