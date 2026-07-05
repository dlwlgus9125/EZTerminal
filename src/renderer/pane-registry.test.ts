import { describe, expect, it } from 'vitest';

import {
  getPaneCwd,
  insertIntoPaneInput,
  registerPaneInput,
  removePaneCwd,
  setPaneCwd,
  unregisterPaneInput,
} from './pane-registry';

describe('pane-registry', () => {
  it('set/get/remove cwd semantics', () => {
    expect(getPaneCwd('p1')).toBeUndefined();
    setPaneCwd('p1', 'C:\\Users\\a');
    expect(getPaneCwd('p1')).toBe('C:\\Users\\a');
    setPaneCwd('p1', 'C:\\Users\\b');
    expect(getPaneCwd('p1')).toBe('C:\\Users\\b');
    removePaneCwd('p1');
    expect(getPaneCwd('p1')).toBeUndefined();
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
