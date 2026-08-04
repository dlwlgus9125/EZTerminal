// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { focusPaneSurface } from './pane-focus';

afterEach(() => {
  document.body.replaceChildren();
});

function makePane(): { commandInput: HTMLInputElement; terminalInput: HTMLTextAreaElement } {
  const pane = document.createElement('div');
  pane.className = 'pane';
  const commandInput = document.createElement('input');
  commandInput.className = 'cmd-input';
  const pty = document.createElement('div');
  pty.className = 'pty-block';
  const terminalInput = document.createElement('textarea');
  terminalInput.className = 'xterm-helper-textarea';
  pty.append(terminalInput);
  pane.append(commandInput, pty);
  document.body.append(pane);
  return { commandInput, terminalInput };
}

describe('focusPaneSurface', () => {
  it('focuses the live xterm input for an active PTY and the command input otherwise', () => {
    const { commandInput, terminalInput } = makePane();
    expect(focusPaneSurface(commandInput, true)).toBe(true);
    expect(document.activeElement).toBe(terminalInput);

    expect(focusPaneSurface(commandInput, false)).toBe(true);
    expect(document.activeElement).toBe(commandInput);
  });

  it('falls back to the command input if xterm is not mounted yet', () => {
    const { commandInput, terminalInput } = makePane();
    terminalInput.remove();
    expect(focusPaneSurface(commandInput, true)).toBe(true);
    expect(document.activeElement).toBe(commandInput);
  });

  it('reports a detached input as not ready for focus', () => {
    const { commandInput } = makePane();
    commandInput.remove();

    expect(focusPaneSurface(commandInput, false)).toBe(false);
  });
});
