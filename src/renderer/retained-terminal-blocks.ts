import type { EzTerminalApi, RunStartedInfo } from '../shared/ipc';
import type { BlockController } from './block-controller';

interface Block {
  readonly id: string;
  readonly command: string;
  readonly controller: BlockController | null;
}

type Access = Pick<EzTerminalApi, 'listSessions' | 'onSessionRemoved' | 'onSessionDead'>;
const scopes = new WeakMap<Access, Map<string, readonly RunStartedInfo[]>>();

function scopeFor(access: Access): Map<string, readonly RunStartedInfo[]> {
  const existing = scopes.get(access);
  if (existing) return existing;
  const scope = new Map<string, readonly RunStartedInfo[]>();
  scopes.set(access, scope);
  access.onSessionRemoved?.((sessionId) => scope.delete(sessionId));
  access.onSessionDead?.(() => scope.clear());
  return scope;
}

/** Retain only volatile run descriptors, not DOM, controllers, ports, or output.
 * Reopening uses the host's replay stores, including completed blocks. */
export function retainTerminalBlocks(access: Access, sessionId: string, blocks: readonly Block[]): void {
  const scope = scopeFor(access);
  const runs = new Map((scope.get(sessionId) ?? []).map((run) => [run.runId, run]));
  for (const block of blocks) {
    if (!block.controller) continue;
    const executionKind = block.controller.getSnapshot().executionKind;
    runs.set(block.id, {
      sessionId, runId: block.id, commandText: block.command,
      ...(executionKind ? { executionKind } : {}),
    });
    block.controller.detach();
  }
  if (runs.size === 0) return;
  const retained = [...runs.values()];
  scope.set(sessionId, retained);
  // Guarded end can win just before React cleanup. Do not retain ended sessions
  // or remove descriptors already claimed/replaced by a later view.
  void access.listSessions?.().then((sessions) => {
    if (!sessions.some((session) => session.sessionId === sessionId)
      && scope.get(sessionId) === retained) scope.delete(sessionId);
  }, () => undefined);
}

export function takeRetainedTerminalBlocks(access: Access, sessionId: string): readonly RunStartedInfo[] {
  const scope = scopeFor(access);
  const runs = scope.get(sessionId) ?? [];
  scope.delete(sessionId);
  return runs;
}
