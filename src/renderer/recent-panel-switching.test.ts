// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  advanceRecentPanelSwitch,
  buildRecentPanelOrder,
  installRecentPanelKeybindings,
  reconcileRecentPanelSwitch,
  recordRecentPanelActivation,
  startRecentPanelSwitch,
} from './recent-panel-switching';

describe('recent panel MRU model', () => {
  it('keeps the active pane first, removes stale ids, appends new panes, and caps the overlay', () => {
    const available = Array.from({ length: 10 }, (_, index) => `p${index + 1}`);
    expect(buildRecentPanelOrder(
      ['stale', 'p4', 'p2', 'p4'],
      available,
      'p3',
    )).toEqual(['p3', 'p4', 'p2', 'p1', 'p5', 'p6', 'p7', 'p8']);
  });

  it('records activation without retaining removed panes', () => {
    expect(recordRecentPanelActivation(
      ['p1', 'gone', 'p2'],
      'p3',
      ['p1', 'p2', 'p3'],
    )).toEqual(['p3', 'p1', 'p2']);
  });

  it('starts forward or reverse and wraps repeated cycling', () => {
    const forward = startRecentPanelSwitch(['p1', 'p2', 'p3'], ['p1', 'p2', 'p3'], 'p1', false)!;
    const reverse = startRecentPanelSwitch(['p1', 'p2', 'p3'], ['p1', 'p2', 'p3'], 'p1', true)!;
    expect(forward.selectedPanelId).toBe('p2');
    expect(reverse.selectedPanelId).toBe('p3');
    expect(advanceRecentPanelSwitch(forward, false).selectedPanelId).toBe('p3');
    expect(advanceRecentPanelSwitch(reverse, true).selectedPanelId).toBe('p2');
  });

  it('cancels when the origin or selected pane disappears and sanitizes other removals', () => {
    const session = startRecentPanelSwitch(['p1', 'p2', 'p3'], ['p1', 'p2', 'p3'], 'p1', false)!;
    expect(reconcileRecentPanelSwitch(session, ['p1', 'p2'])).toEqual({
      ...session,
      panelIds: ['p1', 'p2'],
    });
    expect(reconcileRecentPanelSwitch(session, ['p1', 'p3'])).toBeNull();
    expect(reconcileRecentPanelSwitch(session, ['p2', 'p3'])).toBeNull();
  });

  it('does not open for a single pane or a stale active id', () => {
    expect(startRecentPanelSwitch([], ['p1'], 'p1', false)).toBeNull();
    expect(startRecentPanelSwitch([], ['p1', 'p2'], 'gone', false)).toBeNull();
  });
});

describe('recent panel keyboard capture', () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it('captures Ctrl+Tab before the focused terminal and commits on Ctrl release', () => {
    let open = false;
    const cycle = vi.fn(() => { open = true; });
    const commit = vi.fn(() => { open = false; });
    const terminalKeydown = vi.fn();
    const input = document.createElement('textarea');
    document.body.append(input);
    input.addEventListener('keydown', terminalKeydown);
    dispose = installRecentPanelKeybindings(window, {
      isOpen: () => open,
      cycle,
      commit,
      cancel: vi.fn(),
    });

    const tab = new KeyboardEvent('keydown', {
      code: 'Tab',
      key: 'Tab',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(cycle).toHaveBeenCalledWith(false);
    expect(terminalKeydown).not.toHaveBeenCalled();

    const controlUp = new KeyboardEvent('keyup', {
      code: 'ControlLeft',
      key: 'Control',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(controlUp);
    expect(controlUp.defaultPrevented).toBe(true);
    expect(commit).toHaveBeenCalledOnce();
    input.remove();
  });

  it('cycles in reverse and cancels without restoring focus on window blur', () => {
    let open = false;
    const cycle = vi.fn(() => { open = true; });
    const cancel = vi.fn(() => { open = false; });
    dispose = installRecentPanelKeybindings(window, {
      isOpen: () => open,
      cycle,
      commit: vi.fn(),
      cancel,
    });

    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'Tab',
      key: 'Tab',
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    }));
    expect(cycle).toHaveBeenCalledWith(true);
    window.dispatchEvent(new Event('blur'));
    expect(cancel).toHaveBeenCalledWith(false);
  });

  it('captures Escape only while the switcher is open', () => {
    let open = true;
    const cancel = vi.fn(() => { open = false; });
    dispose = installRecentPanelKeybindings(window, {
      isOpen: () => open,
      cycle: vi.fn(),
      commit: vi.fn(),
      cancel,
    });
    const escape = new KeyboardEvent('keydown', {
      code: 'Escape',
      key: 'Escape',
      cancelable: true,
    });
    window.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(cancel).toHaveBeenCalledWith(true);
  });
});
