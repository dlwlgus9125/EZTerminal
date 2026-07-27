import type { RemoteClientIdentity } from '../shared/remote-protocol';
import type { RemoteDeviceEntry } from '../shared/ipc';

/**
 * Devices this run has seen pair with the bridge.
 *
 * Deliberately in memory only. The roster answers "what is attached to me, and
 * what was attached a moment ago", which is a live question; persisting device
 * names would write a record of a person's hardware to disk for a panel that is
 * read while the app is open. It resets with the process, and the panel says so.
 */
export class RemoteDeviceRoster {
  private readonly entries = new Map<string, RemoteDeviceEntry>();

  public record(identity: RemoteClientIdentity, presence: 'connected' | 'disconnected', at: number): void {
    this.entries.set(identity.clientId, {
      clientId: identity.clientId,
      clientName: identity.clientName,
      platform: identity.platform,
      connected: presence === 'connected',
      lastSeenAt: at,
    });
  }

  /** Connected devices first, then most recently seen. */
  public list(): readonly RemoteDeviceEntry[] {
    return [...this.entries.values()].sort(
      (a, b) =>
        Number(b.connected) - Number(a.connected)
        || b.lastSeenAt - a.lastSeenAt
        || a.clientName.localeCompare(b.clientName),
    );
  }

  /** A stopped bridge has no connected clients, whatever it saw earlier. */
  public markAllDisconnected(at: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.connected) this.entries.set(id, { ...entry, connected: false, lastSeenAt: at });
    }
  }
}
