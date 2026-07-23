/**
 * LAN connect-URL formatting for the desktop mobile-pairing panel (M4) — pure
 * function over `os.networkInterfaces()`'s return shape so it's unit-testable
 * without touching the real network stack (the `os` call itself stays at the
 * main.ts call site). Filters to non-internal IPv4 addresses (the ones a phone
 * on the same LAN/Tailscale can actually dial) and formats each as a
 * `ws://<ip>:<port>` URL — the scheme `remote-bridge.ts`'s WS server speaks.
 */
import type { NetworkInterfaceInfo } from 'node:os';

import type { RemoteConnectionInfo } from '../shared/ipc';

export function formatConnectionInfo(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
  port: number,
  allowedAddress?: string,
): RemoteConnectionInfo {
  const urls: string[] = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal || info.family !== 'IPv4') continue;
      if (allowedAddress && info.address !== allowedAddress) continue;
      urls.push(`ws://${info.address}:${port}`);
    }
  }
  return { urls, port };
}
