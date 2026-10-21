import { createDaemonCommand, type DaemonCommand, type DaemonCommandReceipt, type DaemonSnapshot } from '../shared/daemon-protocol';

export interface ReleaseDaemonAccess {
  getSnapshot(): Promise<DaemonSnapshot | null>;
  sendCommand(command: DaemonCommand): Promise<DaemonCommandReceipt | null>;
}

/**
 * After `/clear` replaced a conversation in its tab, stop its idle provider process. Best effort:
 * the host refuses while it is not idle, and a later message reattaches it either way.
 */
export async function releaseProviderAfterClear(daemon: ReleaseDaemonAccess, sessionId: string, newId: () => string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await daemon.getSnapshot().catch(() => null);
    if (!snapshot) return;
    const commandId = newId();
    const receipt = await daemon.sendCommand(createDaemonCommand({
      commandId,
      idempotencyKey: commandId,
      expectedRevision: snapshot.revision,
      issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type: 'agent.release',
      payload: { sessionId },
    })).catch(() => null);
    if (!receipt || receipt.ok || receipt.error.code !== 'revision-conflict') return;
  }
}
