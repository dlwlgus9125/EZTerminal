import type { ProjectSessionPanelMetadata } from '../shared/project-workspace';
import type { RendererRecoveryPane } from '../shared/renderer-recovery';

export interface TerminalSessionViewState extends RendererRecoveryPane {
  readonly title?: string;
  readonly projectSession?: ProjectSessionPanelMetadata;
}

/** Device/process-local presentation state, never serialized into a layout. */
const states = new Map<string, unknown>();
const scopes = new WeakMap<object, number>();
let scopeSequence = 0;

export function sessionViewKey(scope: object, sessionId: string): string {
  let id = scopes.get(scope);
  if (id === undefined) { id = ++scopeSequence; scopes.set(scope, id); }
  return `connection-${id}:${sessionId}`;
}

export function readSessionViewState<T>(key: string): T | undefined {
  return states.get(key) as T | undefined;
}

export function saveSessionViewState<T>(key: string, value: T): void {
  // Bound device-local presentation memory during long-running workspaces.
  states.delete(key);
  states.set(key, value);
  if (states.size > 200) states.delete(states.keys().next().value!);
}

export function forgetSessionViewState(key: string): void {
  states.delete(key);
}

export function clearSessionViewStates(): void {
  states.clear();
}
