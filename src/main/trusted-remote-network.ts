import type { NetworkInterfaceInfo } from 'node:os';

export interface TrustedRemoteNetwork {
  readonly interfaceName: string;
  readonly address: string;
}

const TRUSTED_VPN_NAME = /(?:tailscale|wireguard|wintun)/i;

/** Selects only a known VPN adapter, unless an administrator explicitly pins one. */
export function selectTrustedRemoteNetwork(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  explicit?: string,
): TrustedRemoteNetwork | null {
  const requested = explicit?.trim().toLowerCase() || null;
  for (const [interfaceName, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4') continue;
      const explicitlySelected = requested === interfaceName.toLowerCase()
        || requested === info.address.toLowerCase();
      // Never choose loopback implicitly, but allow an administrator or an
      // isolated test harness to pin it explicitly. A loopback-only listener
      // is narrower than a VPN listener and does not weaken the default
      // fail-closed network selection.
      if (requested !== null && !explicitlySelected) continue;
      if (requested === null && (info.internal || !TRUSTED_VPN_NAME.test(interfaceName))) continue;
      return { interfaceName, address: info.address };
    }
  }
  return null;
}
