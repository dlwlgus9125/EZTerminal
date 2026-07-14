import { describe, expect, it } from 'vitest';

import { classifyRecentPanelInput, type RecentPanelNativeInput } from './recent-panel-input';

function input(overrides: Partial<RecentPanelNativeInput> = {}): RecentPanelNativeInput {
  return {
    type: 'keyDown',
    key: 'a',
    code: 'KeyA',
    control: false,
    shift: false,
    alt: false,
    meta: false,
    ...overrides,
  };
}

describe('classifyRecentPanelInput', () => {
  it('captures only Ctrl+Tab and carries reverse direction', () => {
    expect(classifyRecentPanelInput(false, input({
      key: 'Tab',
      code: 'Tab',
      control: true,
    }))).toEqual({
      active: true,
      preventDefault: true,
      event: { type: 'cycle', reverse: false },
    });
    expect(classifyRecentPanelInput(true, input({
      key: 'Tab',
      code: 'Tab',
      control: true,
      shift: true,
    }))).toEqual({
      active: true,
      preventDefault: true,
      event: { type: 'cycle', reverse: true },
    });
  });

  it('does not steal plain, Alt, or Meta modified Tab', () => {
    expect(classifyRecentPanelInput(false, input({ key: 'Tab', code: 'Tab' })).preventDefault).toBe(false);
    expect(classifyRecentPanelInput(false, input({
      key: 'Tab', code: 'Tab', control: true, alt: true,
    })).preventDefault).toBe(false);
    expect(classifyRecentPanelInput(false, input({
      key: 'Tab', code: 'Tab', control: true, meta: true,
    })).preventDefault).toBe(false);
  });

  it('commits on Control release only while a switch is active', () => {
    expect(classifyRecentPanelInput(true, input({
      type: 'keyUp', key: 'Control', code: 'ControlLeft',
    }))).toEqual({
      active: false,
      preventDefault: true,
      event: { type: 'commit' },
    });
    expect(classifyRecentPanelInput(false, input({
      type: 'keyUp', key: 'Control', code: 'ControlLeft',
    })).preventDefault).toBe(false);
  });

  it('cancels with focus restoration on Escape and leaves unrelated input untouched', () => {
    expect(classifyRecentPanelInput(true, input({ key: 'Escape', code: 'Escape' }))).toEqual({
      active: false,
      preventDefault: true,
      event: { type: 'cancel', restoreFocus: true },
    });
    expect(classifyRecentPanelInput(true, input()).event).toBeNull();
    expect(classifyRecentPanelInput(true, input()).active).toBe(true);
    expect(classifyRecentPanelInput(false, input({ key: 'Escape', code: 'Escape' })).preventDefault).toBe(false);
  });
});
