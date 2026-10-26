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
  holders: number;
}

const registries = new WeakMap<ChatStateAccess, Map<string, Entry>>();

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
  registry.set(key, { controller, holders: 0 });
  return controller;
}

/**
 * Hold the scope's controller while a view shows it. When the last holder lets
 * go, pending writes finish first and the controller is forgotten only if no one
 * held it again meanwhile, so a quick remount keeps the live draft.
 */
export function retainChatRecovery(controller: ChatRecoveryController, access: ChatStateAccess): () => void {
  const registry = registryFor(access);
  const key = chatRecoveryKey(controller.scope);
  let entry = registry.get(key);
  if (!entry) {
    // Looked up while rendering, then forgotten before this view committed: put it back.
    entry = { controller, holders: 0 };
    registry.set(key, entry);
  }
  if (entry.controller !== controller) return () => undefined;
  const held = entry;
  held.holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.holders -= 1;
    if (held.holders > 0) return;
    void held.controller.flush().then(() => {
      if (held.holders === 0 && registry.get(key) === held) registry.delete(key);
    });
  };
}
