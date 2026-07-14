import { beforeEach, describe, expect, it } from 'vitest';

import {
  createTerminalAccessoryLayoutStore,
  defaultTerminalAccessoryLayout,
  moveTerminalAccessoryKey,
  moveTerminalAccessoryKeyToIndex,
  normalizeTerminalAccessoryLayout,
  setTerminalAccessoryKeyVisible,
  TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY,
} from './terminal-accessory-layout';

class MemoryStorage {
  readonly values = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('storage unavailable');
    this.values.set(key, value);
  }
}

describe('terminal accessory layout', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('preserves the original eight-key layout as the default', () => {
    expect(defaultTerminalAccessoryLayout().visible).toEqual([
      'escape',
      'tab',
      'ctrl-c',
      'ctrl-d',
      'arrow-up',
      'arrow-down',
      'arrow-left',
      'arrow-right',
    ]);
  });

  it('drops unknown and duplicate ids while appending new built-ins as hidden', () => {
    const normalized = normalizeTerminalAccessoryLayout({
      version: 1,
      order: ['ctrl-r', 'escape', 'ctrl-r', 'future-key'],
      visible: ['ctrl-r', 'future-key'],
    });
    expect(normalized?.order.slice(0, 2)).toEqual(['ctrl-r', 'escape']);
    expect(normalized?.visible).toEqual(['ctrl-r']);
    expect(normalized?.order).toContain('page-down');
    expect(normalized?.visible).not.toContain('page-down');
  });

  it('resets malformed persisted data and records that recovery', () => {
    storage.values.set(TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY, '{not-json');
    const store = createTerminalAccessoryLayoutStore(storage);
    expect(store.getSnapshot().persistence).toBe('recovered');
    expect(store.getSnapshot().layout).toEqual(defaultTerminalAccessoryLayout());
    expect(JSON.parse(storage.values.get(TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY) ?? '')).toEqual(
      defaultTerminalAccessoryLayout(),
    );
  });

  it('keeps a session-only change when persistence fails and saves it on retry', () => {
    const store = createTerminalAccessoryLayoutStore(storage);
    const hiddenEscape = setTerminalAccessoryKeyVisible(store.getSnapshot().layout, 'escape', false);
    storage.failWrites = true;
    store.setLayout(hiddenEscape);
    expect(store.getSnapshot().persistence).toBe('session-only');
    expect(store.getSnapshot().layout.visible).not.toContain('escape');

    storage.failWrites = false;
    store.retrySave();
    expect(store.getSnapshot().persistence).toBe('saved');
    expect(JSON.parse(storage.values.get(TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY) ?? '').visible).not.toContain('escape');
  });

  it('reorders keys without changing which keys are visible', () => {
    const layout = defaultTerminalAccessoryLayout();
    const moved = moveTerminalAccessoryKey(layout, 'tab', -1);
    expect(moved.order.slice(0, 2)).toEqual(['tab', 'escape']);
    expect(new Set(moved.visible)).toEqual(new Set(layout.visible));
  });

  it('moves a touch-dragged key before or after the pointed row', () => {
    const layout = defaultTerminalAccessoryLayout();
    const belowTab = moveTerminalAccessoryKeyToIndex(layout, 'escape', 2);
    expect(belowTab.order.slice(0, 3)).toEqual(['tab', 'escape', 'ctrl-c']);
    const aboveTab = moveTerminalAccessoryKeyToIndex(layout, 'ctrl-c', 1);
    expect(aboveTab.order.slice(0, 3)).toEqual(['escape', 'ctrl-c', 'tab']);
  });
});
