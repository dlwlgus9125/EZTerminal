/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import { commandCenterShortcutMode, isTerminalEditingTarget } from './command-center-shortcut';

function shortcut(
  code: string,
  target: EventTarget,
  options: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {},
) {
  return commandCenterShortcutMode({
    altKey: false,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    code,
    target,
    ...options,
  });
}

describe('Command Center contextual shortcut', () => {
  it('opens all results from application chrome with Ctrl/Cmd+K', () => {
    const button = document.createElement('button');
    expect(shortcut('KeyK', button)).toBe('all');
    expect(shortcut('KeyK', button, { ctrlKey: false, metaKey: true })).toBe('all');
  });

  it('preserves Ctrl/Cmd+K for the terminal composer and xterm', () => {
    const composer = document.createElement('input');
    composer.dataset.testid = 'cmd-input';
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const helper = document.createElement('textarea');
    xterm.append(helper);

    expect(isTerminalEditingTarget(composer)).toBe(true);
    expect(isTerminalEditingTarget(helper)).toBe(true);
    expect(shortcut('KeyK', composer)).toBeNull();
    expect(shortcut('KeyK', helper, { ctrlKey: false, metaKey: true })).toBeNull();
  });

  it('recognizes editing targets created by an auxiliary document realm', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const composer = frame.contentDocument!.createElement('input');
    composer.className = 'cmd-input';
    frame.contentDocument!.body.appendChild(composer);

    expect(isTerminalEditingTarget(composer)).toBe(true);
    expect(shortcut('KeyK', composer)).toBeNull();
    frame.remove();
  });

  it('preserves Ctrl/Cmd+K in ordinary editable controls and contenteditable descendants', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const inline = document.createElement('span');
    editor.append(inline);

    for (const target of [input, textarea, editor, inline]) {
      expect(isTerminalEditingTarget(target)).toBe(true);
      expect(shortcut('KeyK', target)).toBeNull();
    }
    expect(shortcut('KeyP', input, { shiftKey: true })).toBe('commands');
  });

  it('keeps Ctrl/Cmd+Shift+P global and rejects unrelated modifiers', () => {
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    expect(shortcut('KeyP', xterm, { shiftKey: true })).toBe('commands');
    expect(shortcut('KeyK', document.body, { altKey: true })).toBeNull();
    expect(shortcut('KeyK', document.body, { shiftKey: true })).toBeNull();
  });
});
