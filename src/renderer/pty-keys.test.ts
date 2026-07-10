import type { KeyboardEvent } from 'react';
import { describe, expect, it } from 'vitest';

import { keyToPtyBytes } from './pty-keys';

// keyToPtyBytes reads only these fields — a plain object literal stands in
// for React's KeyboardEvent (same duck-typing approach as paste-routing.ts's
// PasteTargetSnapshot).
function key(
  props: Partial<{
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }>,
): KeyboardEvent {
  return {
    key: '',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...props,
  } as unknown as KeyboardEvent;
}

describe('keyToPtyBytes', () => {
  it('forwards printable characters, Enter, Backspace, Tab unchanged', () => {
    expect(keyToPtyBytes(key({ key: 'a' }))).toBe('a');
    expect(keyToPtyBytes(key({ key: 'Z' }))).toBe('Z');
    expect(keyToPtyBytes(key({ key: '5' }))).toBe('5');
    expect(keyToPtyBytes(key({ key: 'Enter' }))).toBe('\r');
    expect(keyToPtyBytes(key({ key: 'Backspace' }))).toBe('\x7f');
    expect(keyToPtyBytes(key({ key: 'Tab' }))).toBe('\t');
  });

  it('maps Escape', () => {
    expect(keyToPtyBytes(key({ key: 'Escape' }))).toBe('\x1b');
  });

  it('maps arrow keys', () => {
    expect(keyToPtyBytes(key({ key: 'ArrowUp' }))).toBe('\x1b[A');
    expect(keyToPtyBytes(key({ key: 'ArrowDown' }))).toBe('\x1b[B');
    expect(keyToPtyBytes(key({ key: 'ArrowRight' }))).toBe('\x1b[C');
    expect(keyToPtyBytes(key({ key: 'ArrowLeft' }))).toBe('\x1b[D');
  });

  it('maps navigation keys', () => {
    expect(keyToPtyBytes(key({ key: 'Home' }))).toBe('\x1b[H');
    expect(keyToPtyBytes(key({ key: 'End' }))).toBe('\x1b[F');
    expect(keyToPtyBytes(key({ key: 'Insert' }))).toBe('\x1b[2~');
    expect(keyToPtyBytes(key({ key: 'Delete' }))).toBe('\x1b[3~');
    expect(keyToPtyBytes(key({ key: 'PageUp' }))).toBe('\x1b[5~');
    expect(keyToPtyBytes(key({ key: 'PageDown' }))).toBe('\x1b[6~');
  });

  it('maps function keys F1-F12', () => {
    expect(keyToPtyBytes(key({ key: 'F1' }))).toBe('\x1bOP');
    expect(keyToPtyBytes(key({ key: 'F2' }))).toBe('\x1bOQ');
    expect(keyToPtyBytes(key({ key: 'F3' }))).toBe('\x1bOR');
    expect(keyToPtyBytes(key({ key: 'F4' }))).toBe('\x1bOS');
    expect(keyToPtyBytes(key({ key: 'F5' }))).toBe('\x1b[15~');
    expect(keyToPtyBytes(key({ key: 'F6' }))).toBe('\x1b[17~');
    expect(keyToPtyBytes(key({ key: 'F7' }))).toBe('\x1b[18~');
    expect(keyToPtyBytes(key({ key: 'F8' }))).toBe('\x1b[19~');
    expect(keyToPtyBytes(key({ key: 'F9' }))).toBe('\x1b[20~');
    expect(keyToPtyBytes(key({ key: 'F10' }))).toBe('\x1b[21~');
    expect(keyToPtyBytes(key({ key: 'F11' }))).toBe('\x1b[23~');
    expect(keyToPtyBytes(key({ key: 'F12' }))).toBe('\x1b[24~');
  });

  it('generalizes Ctrl+letter to control bytes, preserving Ctrl+C/D', () => {
    expect(keyToPtyBytes(key({ key: 'c', ctrlKey: true }))).toBe('\x03');
    expect(keyToPtyBytes(key({ key: 'C', ctrlKey: true }))).toBe('\x03');
    expect(keyToPtyBytes(key({ key: 'd', ctrlKey: true }))).toBe('\x04');
    expect(keyToPtyBytes(key({ key: 'D', ctrlKey: true }))).toBe('\x04');
    expect(keyToPtyBytes(key({ key: 'a', ctrlKey: true }))).toBe('\x01');
    expect(keyToPtyBytes(key({ key: 'z', ctrlKey: true }))).toBe('\x1a');
  });

  it('leaves Ctrl+Shift+<key> unforwarded (reserved for copy/paste)', () => {
    expect(keyToPtyBytes(key({ key: 'c', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(keyToPtyBytes(key({ key: 'v', ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('leaves Alt/Meta combos unforwarded', () => {
    expect(keyToPtyBytes(key({ key: 'a', altKey: true }))).toBeNull();
    expect(keyToPtyBytes(key({ key: 'a', metaKey: true }))).toBeNull();
    expect(keyToPtyBytes(key({ key: 'Enter', altKey: true }))).toBeNull();
  });

  it('leaves other Ctrl combos (non-letter) unforwarded', () => {
    expect(keyToPtyBytes(key({ key: '1', ctrlKey: true }))).toBeNull();
    expect(keyToPtyBytes(key({ key: 'Enter', ctrlKey: true }))).toBeNull();
  });

  it('returns null for unmapped keys (e.g. modifier keys alone)', () => {
    expect(keyToPtyBytes(key({ key: 'Shift' }))).toBeNull();
    expect(keyToPtyBytes(key({ key: 'Control' }))).toBeNull();
  });
});
