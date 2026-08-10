const TERMINAL_EDITING_TARGETS = [
  '.xterm',
  '.cmd-input',
  '[data-testid="cmd-input"]',
  '[data-terminal-shortcuts="native"]',
  'input',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

export function isTerminalEditingTarget(target: EventTarget | null): boolean {
  return typeof (target as Element | null)?.closest === 'function'
    && (target as Element).closest(TERMINAL_EDITING_TARGETS) !== null;
}

/**
 * Ctrl/Cmd+K is contextual: application chrome opens the Command Center while
 * terminal and ordinary form editing surfaces retain their native behavior.
 * Ctrl/Cmd+Shift+P remains the global fallback, including from the terminal.
 */
export function commandCenterShortcutMode(
  event: Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'target'>,
): 'all' | 'commands' | null {
  if (event.altKey || (!event.ctrlKey && !event.metaKey)) return null;
  if (event.code === 'KeyP' && event.shiftKey) return 'commands';
  if (event.code === 'KeyK' && !event.shiftKey && !isTerminalEditingTarget(event.target)) return 'all';
  return null;
}
