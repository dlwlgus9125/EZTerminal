import { describe, expect, it } from 'vitest';

import {
  resolveTerminalShortcut,
  takeCodexInterruptNotice,
  type TerminalShortcutInput,
} from './terminal-key-policy';

function key(partial: Partial<TerminalShortcutInput>): TerminalShortcutInput {
  return {
    code: '',
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isCodex: false,
    hasSelection: false,
    canFind: false,
    ...partial,
  };
}

describe('resolveTerminalShortcut', () => {
  it('blocks Codex exit chords without changing generic PTY control bytes', () => {
    expect(resolveTerminalShortcut(key({ code: 'KeyC', key: 'c', ctrlKey: true, isCodex: true })))
      .toEqual({ kind: 'block', notice: 'codex-interrupt-help' });
    expect(resolveTerminalShortcut(key({ code: 'KeyD', key: 'd', ctrlKey: true, isCodex: true })))
      .toEqual({ kind: 'block' });
    expect(resolveTerminalShortcut(key({ code: 'KeyC', key: 'c', ctrlKey: true })))
      .toEqual({ kind: 'pass' });
    expect(resolveTerminalShortcut(key({ code: 'KeyD', key: 'd', ctrlKey: true })))
      .toEqual({ kind: 'pass' });
  });

  it('copies a selection before applying the Codex block', () => {
    expect(resolveTerminalShortcut(key({
      code: 'KeyC', key: 'c', ctrlKey: true, isCodex: true, hasSelection: true,
    }))).toEqual({ kind: 'copy' });
    expect(resolveTerminalShortcut(key({
      code: 'Insert', key: 'Insert', ctrlKey: true, hasSelection: true,
    }))).toEqual({ kind: 'copy' });
    expect(resolveTerminalShortcut(key({
      code: 'KeyC', key: 'C', ctrlKey: true, shiftKey: true,
    }))).toEqual({ kind: 'copy' });
  });

  it('routes default and explicit-text paste aliases', () => {
    expect(resolveTerminalShortcut(key({ code: 'KeyV', key: 'v', ctrlKey: true })))
      .toEqual({ kind: 'paste', mode: 'default' });
    expect(resolveTerminalShortcut(key({ code: 'KeyV', key: 'V', ctrlKey: true, shiftKey: true })))
      .toEqual({ kind: 'paste', mode: 'text' });
    expect(resolveTerminalShortcut(key({ code: 'Insert', key: 'Insert', shiftKey: true })))
      .toEqual({ kind: 'paste', mode: 'text' });
  });

  it('moves terminal find to Ctrl+Shift+F and leaves Ctrl+F/Ctrl+P to the child', () => {
    expect(resolveTerminalShortcut(key({
      code: 'KeyF', key: 'F', ctrlKey: true, shiftKey: true, canFind: true,
    }))).toEqual({ kind: 'find' });
    expect(resolveTerminalShortcut(key({ code: 'KeyF', key: 'f', ctrlKey: true, canFind: true })))
      .toEqual({ kind: 'pass' });
    expect(resolveTerminalShortcut(key({ code: 'KeyP', key: 'p', ctrlKey: true })))
      .toEqual({ kind: 'pass' });
  });

  it('leaves Escape untouched for both Codex and generic PTYs', () => {
    expect(resolveTerminalShortcut(key({ code: 'Escape', key: 'Escape', isCodex: true })))
      .toEqual({ kind: 'pass' });
  });

  it('takes the blocked-Ctrl+C notice once per run identity', () => {
    const firstRun = {};
    const secondRun = {};
    expect(takeCodexInterruptNotice(firstRun)).toBe(true);
    expect(takeCodexInterruptNotice(firstRun)).toBe(false);
    expect(takeCodexInterruptNotice(secondRun)).toBe(true);
  });
});
