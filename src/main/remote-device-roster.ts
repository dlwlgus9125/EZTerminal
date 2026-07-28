import type { RemoteClientIdentity } from '../shared/remote-protocol';
import type { RemoteDeviceEntry } from '../shared/ipc';

export const MAX_RECENT_DISCONNECTED_DEVICES = 100;
export const RECENT_DISCONNECTED_DEVICE_TTL_MS = 24 * 60 * 60_000;

/**
 * Devices this run has seen pair with the bridge.
 *
 * Deliberately in memory only. The roster answers "what is attached to me, and
 * what was attached a moment ago", which is a live question; persisting device
 * names would write a record of a person's hardware to disk for a panel that is
 * read while the app is open. It resets with the process, and the panel says so.
 */
export class RemoteDeviceRoster {
  private readonly entries = new Map<
    string,
    { entry: RemoteDeviceEntry; readonly connections: Set<string> }
  >();

  public record(
    identity: RemoteClientIdentity,
    connectionId: string,
    presence: 'connected' | 'disconnected',
    at: number,
  ): void {
    const current = this.entries.get(identity.clientId);
    // Connected records are never evicted. Therefore a disconnect for an
    // unknown id is either duplicated or stale and must not resurrect an
    // already-pruned device.
    if (presence === 'disconnected' && !current) return;
    const connections = current?.connections ?? new Set<string>();
    if (presence === 'connected') connections.add(connectionId);
    else connections.delete(connectionId);
    // A close carries the identity captured when that socket authenticated.
    // Keep the newest connected presentation instead of letting a late close
    // from an older socket roll a renamed device backward.
    const presentedIdentity = presence === 'connected' || !current
      ? identity
      : current.entry;
    this.entries.set(identity.clientId, {
      connections,
      entry: {
        clientId: presentedIdentity.clientId,
        clientName: presentedIdentity.clientName,
        platform: presentedIdentity.platform,
        connected: connections.size > 0,
        lastSeenAt: at,
      },
    });
    this.pruneDisconnected(at);
  }

  /** Connected devices first, then most recently seen. */
  public list(): readonly RemoteDeviceEntry[] {
    return [...this.entries.values()].map(({ entry }) => entry).sort(
      (a, b) =>
        Number(b.connected) - Number(a.connected)
        || b.lastSeenAt - a.lastSeenAt
        || a.clientName.localeCompare(b.clientName),
    );
  }

  /** A stopped bridge has no connected clients, whatever it saw earlier. */
  public markAllDisconnected(at: number): void {
    for (const state of this.entries.values()) {
      state.connections.clear();
      if (state.entry.connected) {
        state.entry = { ...state.entry, connected: false, lastSeenAt: at };
      }
    }
    this.pruneDisconnected(at);
  }

  private pruneDisconnected(at: number): void {
    for (const [clientId, state] of this.entries) {
      if (
        !state.entry.connected
        && at - state.entry.lastSeenAt > RECENT_DISCONNECTED_DEVICE_TTL_MS
      ) {
        this.entries.delete(clientId);
      }
    }
    const disconnected = [...this.entries.entries()]
      .filter(([, state]) => !state.entry.connected)
      .sort(([, a], [, b]) => b.entry.lastSeenAt - a.entry.lastSeenAt);
    for (const [clientId] of disconnected.slice(MAX_RECENT_DISCONNECTED_DEVICES)) {
      this.entries.delete(clientId);
    }
  }
}
