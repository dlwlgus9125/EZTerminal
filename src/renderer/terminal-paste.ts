import {
  DEFAULT_TERMINAL_PASTE_PREFERENCES,
  assessTerminalPasteRisk,
  resolveTerminalPaste,
  type TerminalClipboardSnapshot,
  type TerminalPasteMode,
  type TerminalPastePreferences,
  type TerminalPasteRisk,
} from '../shared/terminal-clipboard';

export type TerminalNoticeKind =
  | 'clipboard-empty'
  | 'clipboard-no-text'
  | 'clipboard-read-failed'
  | 'codex-interrupt-help';

export interface TerminalPasteRuntime {
  readonly readClipboard?: () => Promise<TerminalClipboardSnapshot>;
  readonly pastePreferences?: TerminalPastePreferences;
  readonly confirmPaste?: (risk: TerminalPasteRisk) => Promise<boolean>;
  readonly notifyTerminal?: (notice: TerminalNoticeKind) => void;
}

interface TerminalPasteRequest {
  readonly isCodex: boolean;
  readonly mode: TerminalPasteMode;
  readonly readClipboard: () => Promise<TerminalClipboardSnapshot>;
  readonly pastePreferences?: TerminalPastePreferences;
  readonly confirmPaste?: (risk: TerminalPasteRisk) => Promise<boolean>;
  readonly notify?: (notice: TerminalNoticeKind) => void;
  readonly deliverImage: () => void;
  readonly deliverText: (text: string) => void;
}

/** One shared async routing path for key, DOM-paste, and context-menu entry
 * points. Delivery remains adapter-owned so xterm can preserve bracketed paste. */
export async function pasteFromTerminalClipboard(request: TerminalPasteRequest): Promise<void> {
  let snapshot: TerminalClipboardSnapshot;
  try {
    snapshot = await request.readClipboard();
  } catch {
    request.notify?.('clipboard-read-failed');
    return;
  }

  const decision = resolveTerminalPaste(snapshot, request.isCodex, request.mode);
  if (decision.kind === 'codex-image') {
    request.deliverImage();
    return;
  }
  if (decision.kind === 'empty') {
    request.notify?.('clipboard-empty');
    return;
  }
  if (decision.kind === 'no-text') {
    request.notify?.('clipboard-no-text');
    return;
  }

  const risk = assessTerminalPasteRisk(
    decision.text,
    request.pastePreferences ?? DEFAULT_TERMINAL_PASTE_PREFERENCES,
  );
  if (risk.shouldWarn && request.confirmPaste && !(await request.confirmPaste(risk))) return;
  request.deliverText(decision.text);
}

export function pasteFromRuntimeClipboard(
  runtime: TerminalPasteRuntime,
  request: Omit<
    TerminalPasteRequest,
    'readClipboard' | 'pastePreferences' | 'confirmPaste' | 'notify'
  >,
): Promise<void> {
  return pasteFromTerminalClipboard({
    ...request,
    readClipboard: runtime.readClipboard ?? (async () => ({
      hasImage: false,
      text: await navigator.clipboard.readText(),
    })),
    pastePreferences: runtime.pastePreferences,
    confirmPaste: runtime.confirmPaste,
    notify: runtime.notifyTerminal,
  });
}
