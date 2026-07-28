import { describe, expect, it } from 'vitest';

import {
  MAX_RECENT_DISCONNECTED_DEVICES,
  RECENT_DISCONNECTED_DEVICE_TTL_MS,
  RemoteDeviceRoster,
} from './remote-device-roster';
import type { RemoteClientIdentity } from '../shared/remote-protocol';

const PHONE: RemoteClientIdentity = {
  clientId: '01947000-0000-4000-8000-000000000001',
  clientName: 'Galaxy A',
  platform: 'android',
};

describe('RemoteDeviceRoster', () => {
  it('stays connected until the last socket for an install disconnects', () => {
    const roster = new RemoteDeviceRoster();

    roster.record(PHONE, 'connection-a', 'connected', 1);
    roster.record(PHONE, 'connection-b', 'connected', 2);
    roster.record(PHONE, 'connection-a', 'disconnected', 3);

    expect(roster.list()).toEqual([{
      ...PHONE,
      connected: true,
      lastSeenAt: 3,
    }]);

    roster.record(PHONE, 'connection-b', 'disconnected', 4);
    expect(roster.list()).toEqual([{
      ...PHONE,
      connected: false,
      lastSeenAt: 4,
    }]);
  });

  it('markAllDisconnected clears every tracked connection', () => {
    const roster = new RemoteDeviceRoster();
    roster.record(PHONE, 'connection-a', 'connected', 1);
    roster.record(PHONE, 'connection-b', 'connected', 2);

    roster.markAllDisconnected(3);
    expect(roster.list()[0]).toMatchObject({ connected: false, lastSeenAt: 3 });

    // A late close from a socket that was already cleared stays idempotent.
    roster.record(PHONE, 'connection-a', 'disconnected', 4);
    expect(roster.list()[0]).toMatchObject({ connected: false, lastSeenAt: 4 });
  });

  it('does not let an older socket close restore a stale device name', () => {
    const roster = new RemoteDeviceRoster();
    const renamed = { ...PHONE, clientName: 'Galaxy B' };

    roster.record(PHONE, 'connection-old', 'connected', 1);
    roster.record(renamed, 'connection-new', 'connected', 2);
    roster.record(PHONE, 'connection-old', 'disconnected', 3);

    expect(roster.list()[0]).toMatchObject({
      clientName: 'Galaxy B',
      connected: true,
      lastSeenAt: 3,
    });
  });

  it('bounds disconnected churn without evicting connected devices', () => {
    const roster = new RemoteDeviceRoster();
    roster.record(PHONE, 'connected', 'connected', 1);
    for (let index = 0; index < 1_000; index += 1) {
      const identity = {
        ...PHONE,
        clientId: `01947000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        clientName: `Phone ${index}`,
      };
      roster.record(identity, `connection-${index}`, 'connected', index + 2);
      roster.record(identity, `connection-${index}`, 'disconnected', index + 3);
    }

    const entries = roster.list();
    expect(entries.filter((entry) => entry.connected)).toEqual([
      expect.objectContaining({ clientId: PHONE.clientId }),
    ]);
    expect(entries.filter((entry) => !entry.connected)).toHaveLength(
      MAX_RECENT_DISCONNECTED_DEVICES,
    );
  });

  it('drops expired disconnected history and does not resurrect stale closes', () => {
    const roster = new RemoteDeviceRoster();
    roster.record(PHONE, 'old', 'connected', 1);
    roster.record(PHONE, 'old', 'disconnected', 2);
    const newer = { ...PHONE, clientId: '01947000-0000-4000-8000-000000000002' };
    const now = RECENT_DISCONNECTED_DEVICE_TTL_MS + 3;
    roster.record(newer, 'new', 'connected', now);

    expect(roster.list().map((entry) => entry.clientId)).toEqual([newer.clientId]);
    roster.record(PHONE, 'old', 'disconnected', now + 1);
    expect(roster.list().map((entry) => entry.clientId)).toEqual([newer.clientId]);
  });
});
