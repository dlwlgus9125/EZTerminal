import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';

import { selectTrustedRemoteNetwork } from './trusted-remote-network';

function ipv4(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/24`,
  };
}

describe('selectTrustedRemoteNetwork', () => {
  it('prefers a known overlay and never falls back to ordinary LAN', () => {
    expect(selectTrustedRemoteNetwork({ Ethernet: [ipv4('192.168.1.8')], Tailscale: [ipv4('100.64.0.8')] }))
      .toEqual({ interfaceName: 'Tailscale', address: '100.64.0.8' });
    expect(selectTrustedRemoteNetwork({ Ethernet: [ipv4('192.168.1.8')] })).toBeNull();
  });

  it('allows an explicit interface or address selection', () => {
    const interfaces = { 'Company VPN': [ipv4('10.44.0.8')] };
    expect(selectTrustedRemoteNetwork(interfaces, 'Company VPN')?.address).toBe('10.44.0.8');
    expect(selectTrustedRemoteNetwork(interfaces, '10.44.0.8')?.interfaceName).toBe('Company VPN');
  });
});
