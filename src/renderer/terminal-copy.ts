import type { TerminalNoticeRuntime } from './terminal-notice';

export interface TerminalCopyRuntime extends TerminalNoticeRuntime {
  /** Desktop production supplies the main-backed writer. Other hosts may
   * explicitly supply the owner-document adapter below. Required so a new
   * terminal surface cannot silently fall back to a renderer write. */
  readonly writeUserClipboardText: (
    text: string,
    ownerDocument: Document,
  ) => Promise<boolean> | boolean;
}

export interface TerminalCopyRequest {
  readonly text: string;
  readonly ownerDocument: Document;
}

/** Explicit non-Electron adapter for Storybook, tests and mobile webviews. */
export async function writeOwnerDocumentClipboardText(
  text: string,
  ownerDocument: Document,
): Promise<boolean> {
  const clipboard = ownerDocument.defaultView?.navigator.clipboard;
  if (!clipboard) return false;
  await clipboard.writeText(text);
  return true;
}

/** One result boundary for context-menu and keyboard copy. Selection capture
 * stays adapter-owned; transport and feedback do not. */
export async function copyTerminalText(
  runtime: TerminalCopyRuntime,
  request: TerminalCopyRequest,
): Promise<boolean> {
  if (request.text.length === 0) return false;

  let copied = false;
  try {
    copied = await runtime.writeUserClipboardText(request.text, request.ownerDocument);
  } catch {
    copied = false;
  }

  runtime.notifyTerminal?.(
    copied ? 'clipboard-write-succeeded' : 'clipboard-write-failed',
    request.ownerDocument,
  );
  return copied;
}
