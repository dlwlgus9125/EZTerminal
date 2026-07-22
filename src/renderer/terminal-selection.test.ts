// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { selectedTextWithin } from './terminal-selection';

function select(node: Node): Selection {
  const selection = document.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe('selectedTextWithin', () => {
  it('returns text only when both selection endpoints belong to the terminal surface', () => {
    const pane = document.createElement('div');
    pane.innerHTML = '<pre>terminal output</pre>';
    const outside = document.createElement('p');
    outside.textContent = 'other pane';
    document.body.append(pane, outside);

    expect(selectedTextWithin(pane, select(pane.querySelector('pre')!))).toBe('terminal output');
    expect(selectedTextWithin(pane, select(outside))).toBe('');

    pane.remove();
    outside.remove();
  });
});
