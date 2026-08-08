import { describe, expect, it, vi } from 'vitest';

import {
  getPaneCwd,
  insertIntoPaneInput,
  notifyPaneChanged,
  registerPane,
  registerPaneInput,
  subscribePaneRegistry,
  unregisterPaneInput,
  type PaneHandle,
  type PaneSnapshot,
} from './pane-registry';

describe('pane-registry', () => {
  it('reads cwd from the live pane handle and removes it with the registration', () => {
    expect(getPaneCwd('p1')).toBeUndefined();
    let cwd = 'C:\\Users\\a';
    const handle = {
      getSnapshot: () => ({ cwd } as PaneSnapshot),
      insertText: () => ({ ok: false, reason: 'unavailable' }),
      runText: () => ({ ok: false, reason: 'unavailable' }),
      pasteToPty: () => ({ ok: false, reason: 'unavailable' }),
      focus: () => true,
    } satisfies PaneHandle;
    const unregister = registerPane('p1', handle);
    expect(getPaneCwd('p1')).toBe('C:\\Users\\a');
    cwd = 'C:\\Users\\b';
    expect(getPaneCwd('p1')).toBe('C:\\Users\\b');
    unregister();
    expect(getPaneCwd('p1')).toBeUndefined();
  });

  it('notifies subscribers without replacing the registered pane', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePaneRegistry(listener);
    const handle = {
      getSnapshot: () => ({ cwd: 'C:\\repo' } as PaneSnapshot),
      insertText: () => ({ ok: false, reason: 'unavailable' }),
      runText: () => ({ ok: false, reason: 'unavailable' }),
      pasteToPty: () => ({ ok: false, reason: 'unavailable' }),
      focus: () => true,
    } satisfies PaneHandle;
    const unregister = registerPane('p-notify', handle);
    listener.mockClear();

    notifyPaneChanged('p-notify');

    expect(listener).toHaveBeenCalledTimes(1);
    unregister();
    unsubscribe();
  });

  it('insertIntoPaneInput returns false when no pane is registered', () => {
    expect(insertIntoPaneInput('missing', 'text')).toBe(false);
  });

  it('insertIntoPaneInput returns true and delivers text when registered', () => {
    const received: string[] = [];
    registerPaneInput('p2', (text) => received.push(text));
    expect(insertIntoPaneInput('p2', 'hello')).toBe(true);
    expect(received).toEqual(['hello']);
    unregisterPaneInput('p2');
    expect(insertIntoPaneInput('p2', 'again')).toBe(false);
  });
});
