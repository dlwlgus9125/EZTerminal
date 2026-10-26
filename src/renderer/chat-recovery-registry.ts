import { ChatRecoveryController, type ChatStateAccess } from './chat-recovery';
import type { ChatStateScope } from '../shared/chat-state';

/**
 * One draft controller per conversation scope in this renderer. The same
 * conversation can be typed into from its tab and from a terminal's AI input
 * at once; two controllers would each hold their own revision and the second
 * writer would be refused as stale. Shared, both inputs read and write one
 * draft and one pending submission, so a send from either clears both and a
 * second send waits for the first. Popout windows share this module (Dockview
 * moves their DOM; it does not start another renderer).
 */

interface Entry {
  readonly controller: ChatRecoveryController;
  readonly registry: Map<string, Entry>;
  readonly key: string;
  holders: number;
  /** Bumped by every hold, so a release only forgets the entry it saw last. */
  generation: number;
}

const registries = new WeakMap<ChatStateAccess, Map<string, Entry>>();
const entries = new WeakMap<ChatRecoveryController, Entry>();

function registryFor(access: ChatStateAccess): Map<string, Entry> {
  const existing = registries.get(access);
  if (existing) return existing;
  const created = new Map<string, Entry>();
  registries.set(access, created);
  return created;
}

export function chatRecoveryKey(scope: ChatStateScope): string {
  return `${scope.projectId}\0${scope.sessionId}\0${scope.kind ?? ''}`;
}

/** The scope's shared controller; safe to call while rendering (creating one starts no I/O). */
export function sharedChatRecovery(scope: ChatStateScope, access: ChatStateAccess): ChatRecoveryController {
  const registry = registryFor(access);
  const key = chatRecoveryKey(scope);
  const existing = registry.get(key);
  if (existing) return existing.controller;
  const controller = new ChatRecoveryController(scope, access);
  const entry: Entry = { controller, registry, key, holders: 0, generation: 0 };
  registry.set(key, entry);
  entries.set(controller, entry);
  return controller;
}

/**
 * Hold a shared controller while a view shows it or a send it started is in
 * flight. When the last holder lets go, pending writes finish first and the
 * controller is forgotten only if no one held it again meanwhile, so a quick
 * remount — or a delivery that outlives its view — keeps the live draft.
 *
 * Returns null when the scope now has another controller (this one was
 * forgotten and replaced before the caller held it): the caller re-reads
 * `sharedChatRecovery`. A controller made outside the registry is held as a
 * no-op.
 */
export function retainChatRecovery(controller: ChatRecoveryController): (() => void) | null {
  const entry = entries.get(controller);
  if (!entry) return () => undefined;
  const current = entry.registry.get(entry.key);
  if (current && current !== entry) return null;
  if (!current) entry.registry.set(entry.key, entry);
  entry.holders += 1;
  entry.generation += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.holders -= 1;
    if (entry.holders > 0) return;
    const generation = entry.generation;
    void entry.controller.flush().then(() => {
      if (entry.holders === 0 && entry.generation === generation && entry.registry.get(entry.key) === entry) {
        entry.registry.delete(entry.key);
      }
    });
  };
}
