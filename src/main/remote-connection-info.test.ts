import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';

import { formatConnectionInfo } from './remote-connection-info';

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` };
}

function ipv6(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/64`,
    scopeid: 0,
  };
}

describe('formatConnectionInfo', () => {
  it('formats a non-internal IPv4 interface as a ws:// URL with the given port', () => {
    const result = formatConnectionInfo({ Ethernet: [ipv4('192.168.1.42')] }, 7420);
    expect(result).toEqual({ urls: ['ws://192.168.1.42:7420'], port: 7420 });
  });

  it('excludes internal (loopback) interfaces', () => {
    const result = formatConnectionInfo({ 'Loopback Pseudo-Interface 1': [ipv4('127.0.0.1', true)] }, 7420);
    expect(result).toEqual({ urls: [], port: 7420 });
  });

  it('excludes IPv6 interfaces', () => {
    const result = formatConnectionInfo({ Ethernet: [ipv6('fe80::1')] }, 7420);
    expect(result).toEqual({ urls: [], port: 7420 });
  });

  it('handles multiple interfaces each with multiple addresses, keeping only non-internal IPv4', () => {
    const result = formatConnectionInfo(
      {
        Ethernet: [ipv4('192.168.1.42'), ipv6('fe80::1')],
        'Wi-Fi': [ipv4('10.0.0.5'), ipv4('127.0.0.1', true)],
      },
      7420,
    );
    expect(result.port).toBe(7420);
    expect(result.urls.slice().sort()).toEqual(['ws://10.0.0.5:7420', 'ws://192.168.1.42:7420'].sort());
  });

  it('returns an empty list for an empty interfaces object', () => {
    expect(formatConnectionInfo({}, 7420)).toEqual({ urls: [], port: 7420 });
  });

  it('tolerates an undefined entry in the interfaces dict (Node types this as optional)', () => {
    const result = formatConnectionInfo({ ghost: undefined }, 7420);
    expect(result).toEqual({ urls: [], port: 7420 });
  });

  it('carries a custom port through unchanged', () => {
    const result = formatConnectionInfo({ Ethernet: [ipv4('192.168.1.42')] }, 9999);
    expect(result).toEqual({ urls: ['ws://192.168.1.42:9999'], port: 9999 });
  });
});
