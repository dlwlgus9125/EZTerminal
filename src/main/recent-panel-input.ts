import type { RecentPanelInputEvent } from '../shared/ipc';

/** The Electron Input fields used by the Ctrl+Tab classifier. */
export interface RecentPanelNativeInput {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly control: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

export interface RecentPanelInputDecision {
  readonly active: boolean;
  readonly preventDefault: boolean;
  readonly event: RecentPanelInputEvent | null;
}

/**
 * Pure main-side classifier. Chromium reserves Ctrl+Tab, so waiting for a DOM
 * keydown is too late; every unrelated key remains on Electron's normal path.
 */
export function classifyRecentPanelInput(
  active: boolean,
  input: RecentPanelNativeInput,
): RecentPanelInputDecision {
  const tab = input.key === 'Tab' || input.code === 'Tab';
  if (
    input.type === 'keyDown'
    && tab
    && input.control
    && !input.alt
    && !input.meta
  ) {
    return {
      active: true,
      preventDefault: true,
      event: { type: 'cycle', reverse: input.shift },
    };
  }

  if (active && input.type === 'keyDown' && (input.key === 'Escape' || input.code === 'Escape')) {
    return {
      active: false,
      preventDefault: true,
      event: { type: 'cancel', restoreFocus: true },
    };
  }

  const control = input.key === 'Control'
    || input.code === 'ControlLeft'
    || input.code === 'ControlRight';
  if (active && input.type === 'keyUp' && control) {
    return {
      active: false,
      preventDefault: true,
      event: { type: 'commit' },
    };
  }

  return { active, preventDefault: false, event: null };
}
