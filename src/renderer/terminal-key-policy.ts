export interface TerminalShortcutInput {
  readonly code: string;
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isCodex: boolean;
  readonly hasSelection: boolean;
  readonly canFind: boolean;
}

export type TerminalShortcutAction =
  | { readonly kind: 'pass' }
  | { readonly kind: 'copy' }
  | { readonly kind: 'paste'; readonly mode: 'default' | 'text' }
  | { readonly kind: 'find' }
  | { readonly kind: 'block'; readonly notice?: 'codex-interrupt-help' };

const PASS: TerminalShortcutAction = Object.freeze({ kind: 'pass' });
const codexInterruptNotices = new WeakSet<object>();

/** True only once for a run/controller identity; WeakSet avoids extending a
 * completed terminal run's lifetime. */
export function takeCodexInterruptNotice(owner: object): boolean {
  if (codexInterruptNotices.has(owner)) return false;
  codexInterruptNotices.add(owner);
  return true;
}

/** Browser/xterm-independent policy. Adapters own preventDefault, copy, paste,
 * and PTY delivery; this function only resolves shortcut intent. */
export function resolveTerminalShortcut(input: TerminalShortcutInput): TerminalShortcutAction {
  const commandModifier = (input.ctrlKey || input.metaKey) && !input.altKey;

  if (commandModifier && !input.shiftKey && input.code === 'KeyC') {
    if (input.hasSelection) return { kind: 'copy' };
    return input.isCodex
      ? { kind: 'block', notice: 'codex-interrupt-help' }
      : PASS;
  }
  if (commandModifier && input.shiftKey && input.code === 'KeyC') {
    return { kind: 'copy' };
  }
  if (commandModifier && !input.shiftKey && input.code === 'KeyD' && input.isCodex) {
    return { kind: 'block' };
  }
  if (commandModifier && !input.shiftKey && input.code === 'KeyV') {
    return { kind: 'paste', mode: 'default' };
  }
  if (commandModifier && input.shiftKey && input.code === 'KeyV') {
    return { kind: 'paste', mode: 'text' };
  }
  if (input.ctrlKey && !input.altKey && !input.metaKey && !input.shiftKey && input.code === 'Insert') {
    return input.hasSelection ? { kind: 'copy' } : PASS;
  }
  if (!input.ctrlKey && !input.altKey && !input.metaKey && input.shiftKey && input.code === 'Insert') {
    return { kind: 'paste', mode: 'text' };
  }
  if (commandModifier && input.shiftKey && input.code === 'KeyF' && input.canFind) {
    return { kind: 'find' };
  }
  return PASS;
}
