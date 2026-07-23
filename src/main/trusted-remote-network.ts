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
      if (info.internal || info.family !== 'IPv4') continue;
      const explicitlySelected = requested === interfaceName.toLowerCase()
        || requested === info.address.toLowerCase();
      if (!explicitlySelected && !TRUSTED_VPN_NAME.test(interfaceName)) continue;
      return { interfaceName, address: info.address };
    }
  }
  return null;
}
