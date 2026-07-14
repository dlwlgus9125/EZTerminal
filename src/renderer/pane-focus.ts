/** Focus the interactive surface that currently owns keyboard input. Keeping
 * this DOM-only policy outside TerminalPane makes it independently testable
 * without importing xterm/canvas code. */
export function focusPaneSurface(commandInput: HTMLInputElement | null, activePty: boolean): void {
  const terminalInput = commandInput
    ?.closest('.pane')
    ?.querySelector<HTMLTextAreaElement>('.pty-block .xterm-helper-textarea');
  if (activePty && terminalInput) terminalInput.focus();
  else commandInput?.focus();
}
