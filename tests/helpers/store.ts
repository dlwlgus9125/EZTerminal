/**
 * Zustand store test helper.
 * Provides isolated store instances per test to prevent state leakage.
 */

import { act } from "@testing-library/react";
import type { StoreApi, UseBoundStore } from "zustand";

/**
 * Create an isolated store for testing.
 * Resets store state between tests when used with beforeEach/afterEach.
 *
 * @example
 * ```ts
 * import { createIsolatedStore } from '../helpers/store';
 * import { createTabStore } from '../../src/renderer/stores/tabSlice';
 *
 * const useStore = createIsolatedStore(createTabStore);
 *
 * beforeEach(() => {
 *   useStore.setState(useStore.getInitialState());
 * });
 * ```
 */
export function createIsolatedStore<T extends object>(
  createStore: () => UseBoundStore<StoreApi<T>>
): UseBoundStore<StoreApi<T>> {
  return createStore();
}

/**
 * Get current state snapshot from a Zustand store.
 * Useful for asserting state after actions.
 */
export function getStoreState<T>(store: UseBoundStore<StoreApi<T>>): T {
  return store.getState();
}

/**
 * Dispatch an action and flush React updates.
 * Wraps action in act() for component tests.
 */
export async function dispatchAction<T>(
  store: UseBoundStore<StoreApi<T>>,
  action: (state: T) => Partial<T> | undefined
): Promise<void> {
  await act(async () => {
    const state = store.getState();
    const update = action(state);
    if (update !== undefined && update !== null) {
      store.setState(update);
    }
  });
}

/**
 * Subscribe to store changes and collect updates.
 * Returns collected updates and an unsubscribe function.
 *
 * @example
 * ```ts
 * const { updates, unsubscribe } = subscribeToStore(useStore);
 * // ... trigger state changes ...
 * unsubscribe();
 * expect(updates).toHaveLength(2);
 * ```
 */
export function subscribeToStore<T>(store: UseBoundStore<StoreApi<T>>): {
  updates: T[];
  unsubscribe: () => void;
} {
  const updates: T[] = [];
  const unsubscribe = store.subscribe((state) => {
    updates.push(state);
  });
  return { updates, unsubscribe };
}

/**
 * Wait for a store state condition to be true.
 * Polls every 10ms up to timeout (default 1000ms).
 */
export async function waitForStoreState<T>(
  store: UseBoundStore<StoreApi<T>>,
  predicate: (state: T) => boolean,
  timeout = 1000
): Promise<void> {
  const start = Date.now();
  while (!predicate(store.getState())) {
    if (Date.now() - start > timeout) {
      throw new Error("waitForStoreState timed out");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
