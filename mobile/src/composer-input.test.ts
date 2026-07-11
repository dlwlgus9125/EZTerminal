import { describe, expect, it } from 'vitest';

import { beforeInputTextForPty } from './composer-input';

describe('beforeInputTextForPty', () => {
  it('routes a plain insertText commit (suggestion tap / word-committing space)', () => {
    expect(
      beforeInputTextForPty({ isComposing: false, inputType: 'insertText', data: 'hello ' }),
    ).toBe('hello ');
  });

  it('routes a keyboard clipboard-panel paste (insertFromPaste)', () => {
    expect(
      beforeInputTextForPty({ isComposing: false, inputType: 'insertFromPaste', data: 'pasted' }),
    ).toBe('pasted');
  });

  it('falls back to dataTransfer text when data is null (paste shape)', () => {
    expect(
      beforeInputTextForPty({
        isComposing: false,
        inputType: 'insertFromPaste',
        data: null,
        dataTransfer: { getData: () => 'from transfer' },
      }),
    ).toBe('from transfer');
  });

  it('leaves composition text alone — it is sent once, on compositionend', () => {
    expect(
      beforeInputTextForPty({ isComposing: true, inputType: 'insertCompositionText', data: '한' }),
    ).toBeNull();
    // Some keyboards mislabel mid-composition inserts as insertText — the
    // isComposing flag stays authoritative.
    expect(
      beforeInputTextForPty({ isComposing: true, inputType: 'insertText', data: 'h' }),
    ).toBeNull();
  });

  it('ignores non-insert input types (deletes, history, formatting)', () => {
    for (const inputType of ['deleteContentBackward', 'historyUndo', 'insertLineBreak']) {
      expect(beforeInputTextForPty({ isComposing: false, inputType, data: null })).toBeNull();
    }
  });

  it('ignores empty commits', () => {
    expect(beforeInputTextForPty({ isComposing: false, inputType: 'insertText', data: '' })).toBeNull();
    expect(beforeInputTextForPty({ isComposing: false, inputType: 'insertText', data: null })).toBeNull();
  });
});
