import { useSyncExternalStore } from 'react';

import {
  DEFAULT_TERMINAL_ACCESSORY_KEY_IDS,
  TERMINAL_ACCESSORY_KEYS,
  isTerminalAccessoryKeyId,
  type TerminalAccessoryKeyId,
} from './terminal-accessory-keys';

export const TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY = 'ezterminal-mobile-terminal-accessory-layout';
export const TERMINAL_ACCESSORY_LAYOUT_VERSION = 1 as const;
export const OPEN_TERMINAL_KEY_SETTINGS_EVENT = 'ezterminal:open-terminal-key-settings';
export const ACTIVE_MOBILE_TAB_CHANGE_EVENT = 'ezterminal:active-mobile-tab-change';

export interface TerminalAccessoryLayout {
  readonly version: typeof TERMINAL_ACCESSORY_LAYOUT_VERSION;
  readonly order: readonly TerminalAccessoryKeyId[];
  readonly visible: readonly TerminalAccessoryKeyId[];
}

export type TerminalAccessoryPersistence = 'saved' | 'recovered' | 'session-only';
export type TerminalAccessoryMessageCode =
  | 'unavailable'
  | 'read-failed'
  | 'invalid-reset'
  | 'invalid-session'
  | 'save-failed'
  | 'retry-failed';

export interface TerminalAccessoryLayoutSnapshot {
  readonly layout: TerminalAccessoryLayout;
  readonly persistence: TerminalAccessoryPersistence;
  readonly messageCode: TerminalAccessoryMessageCode | null;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const ALL_IDS = TERMINAL_ACCESSORY_KEYS.map((key) => key.id);

export function defaultTerminalAccessoryLayout(): TerminalAccessoryLayout {
  return {
    version: TERMINAL_ACCESSORY_LAYOUT_VERSION,
    order: [...ALL_IDS],
    visible: [...DEFAULT_TERMINAL_ACCESSORY_KEY_IDS],
  };
}

function uniqueKnownIds(value: unknown): TerminalAccessoryKeyId[] {
  if (!Array.isArray(value)) return [];
  const result: TerminalAccessoryKeyId[] = [];
  const seen = new Set<TerminalAccessoryKeyId>();
  for (const item of value) {
    if (!isTerminalAccessoryKeyId(item) || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function normalizeTerminalAccessoryLayout(value: unknown): TerminalAccessoryLayout | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { version?: unknown; order?: unknown; visible?: unknown };
  if (candidate.version !== TERMINAL_ACCESSORY_LAYOUT_VERSION) return null;
  if (!Array.isArray(candidate.order) || !Array.isArray(candidate.visible)) return null;

  const storedOrder = uniqueKnownIds(candidate.order);
  const storedVisible = uniqueKnownIds(candidate.visible);
  const storedOrderSet = new Set(storedOrder);
  const order = [...storedOrder, ...ALL_IDS.filter((id) => !storedOrderSet.has(id))];
  const visibleSet = new Set(storedVisible);
  return {
    version: TERMINAL_ACCESSORY_LAYOUT_VERSION,
    order,
    visible: order.filter((id) => visibleSet.has(id)),
  };
}

export function setTerminalAccessoryKeyVisible(
  layout: TerminalAccessoryLayout,
  id: TerminalAccessoryKeyId,
  visible: boolean,
): TerminalAccessoryLayout {
  const visibleSet = new Set(layout.visible);
  if (visible) visibleSet.add(id);
  else visibleSet.delete(id);
  return { ...layout, visible: layout.order.filter((keyId) => visibleSet.has(keyId)) };
}

export function moveTerminalAccessoryKey(
  layout: TerminalAccessoryLayout,
  id: TerminalAccessoryKeyId,
  direction: -1 | 1,
): TerminalAccessoryLayout {
  const index = layout.order.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= layout.order.length) return layout;
  const order = [...layout.order];
  [order[index], order[target]] = [order[target], order[index]];
  const visibleSet = new Set(layout.visible);
  return { ...layout, order, visible: order.filter((keyId) => visibleSet.has(keyId)) };
}

export function moveTerminalAccessoryKeyBefore(
  layout: TerminalAccessoryLayout,
  movingId: TerminalAccessoryKeyId,
  targetId: TerminalAccessoryKeyId,
): TerminalAccessoryLayout {
  if (movingId === targetId || !layout.order.includes(movingId) || !layout.order.includes(targetId)) return layout;
  const order = layout.order.filter((id) => id !== movingId);
  order.splice(order.indexOf(targetId), 0, movingId);
  const visibleSet = new Set(layout.visible);
  return { ...layout, order, visible: order.filter((id) => visibleSet.has(id)) };
}

export function moveTerminalAccessoryKeyToIndex(
  layout: TerminalAccessoryLayout,
  id: TerminalAccessoryKeyId,
  targetIndex: number,
): TerminalAccessoryLayout {
  const currentIndex = layout.order.indexOf(id);
  if (currentIndex < 0) return layout;
  const order = layout.order.filter((keyId) => keyId !== id);
  let insertionIndex = Math.max(0, Math.min(layout.order.length, Math.trunc(targetIndex)));
  if (insertionIndex > currentIndex) insertionIndex -= 1;
  insertionIndex = Math.min(insertionIndex, order.length);
  order.splice(insertionIndex, 0, id);
  if (order.every((keyId, index) => keyId === layout.order[index])) return layout;
  const visibleSet = new Set(layout.visible);
  return { ...layout, order, visible: order.filter((keyId) => visibleSet.has(keyId)) };
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export interface TerminalAccessoryLayoutStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => TerminalAccessoryLayoutSnapshot;
  readonly setLayout: (layout: TerminalAccessoryLayout) => void;
  readonly reset: () => void;
  readonly retrySave: () => void;
  readonly reload: () => void;
}

export function createTerminalAccessoryLayoutStore(
  storage: StorageLike | null = browserStorage(),
): TerminalAccessoryLayoutStore {
  let snapshot: TerminalAccessoryLayoutSnapshot | null = null;
  const listeners = new Set<() => void>();

  const persist = (layout: TerminalAccessoryLayout): boolean => {
    if (!storage) return false;
    try {
      storage.setItem(TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
      return true;
    } catch {
      return false;
    }
  };

  const read = (): TerminalAccessoryLayoutSnapshot => {
    if (!storage) {
      return {
        layout: defaultTerminalAccessoryLayout(),
        persistence: 'session-only',
        messageCode: 'unavailable',
      };
    }
    let raw: string | null;
    try {
      raw = storage.getItem(TERMINAL_ACCESSORY_LAYOUT_STORAGE_KEY);
    } catch {
      return {
        layout: defaultTerminalAccessoryLayout(),
        persistence: 'session-only',
        messageCode: 'read-failed',
      };
    }
    if (raw === null) return { layout: defaultTerminalAccessoryLayout(), persistence: 'saved', messageCode: null };
    try {
      const layout = normalizeTerminalAccessoryLayout(JSON.parse(raw));
      if (layout) return { layout, persistence: 'saved', messageCode: null };
    } catch {
      // The recovery below deliberately replaces malformed data with defaults.
    }
    const layout = defaultTerminalAccessoryLayout();
    const saved = persist(layout);
    return {
      layout,
      persistence: saved ? 'recovered' : 'session-only',
      messageCode: saved ? 'invalid-reset' : 'invalid-session',
    };
  };

  const getSnapshot = (): TerminalAccessoryLayoutSnapshot => {
    snapshot ??= read();
    return snapshot;
  };

  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  const storeLayout = (layout: TerminalAccessoryLayout): void => {
    const normalized = normalizeTerminalAccessoryLayout(layout) ?? defaultTerminalAccessoryLayout();
    const saved = persist(normalized);
    snapshot = {
      layout: normalized,
      persistence: saved ? 'saved' : 'session-only',
      messageCode: saved ? null : 'save-failed',
    };
    emit();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot,
    setLayout: storeLayout,
    reset: () => storeLayout(defaultTerminalAccessoryLayout()),
    retrySave: () => {
      const current = getSnapshot();
      const saved = persist(current.layout);
      snapshot = {
        layout: current.layout,
        persistence: saved ? 'saved' : 'session-only',
        messageCode: saved ? null : 'retry-failed',
      };
      emit();
    },
    reload: () => {
      snapshot = read();
      emit();
    },
  };
}

export const terminalAccessoryLayoutStore = createTerminalAccessoryLayoutStore();

export function useTerminalAccessoryLayout(): TerminalAccessoryLayoutSnapshot {
  return useSyncExternalStore(
    terminalAccessoryLayoutStore.subscribe,
    terminalAccessoryLayoutStore.getSnapshot,
    terminalAccessoryLayoutStore.getSnapshot,
  );
}
