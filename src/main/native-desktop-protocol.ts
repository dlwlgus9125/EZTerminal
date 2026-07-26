import type { RemoteDesktopServiceHealth } from '../shared/ipc';

/**
 * Native stdio/service protocol shared by the Electron probe adapter and the
 * desktop-control transport controller.
 */
export const NATIVE_DESKTOP_PROTOCOL_VERSION = 2;

export function parseRemoteDesktopServiceProbe(stdout: string): RemoteDesktopServiceHealth {
  try {
    const result = JSON.parse(stdout) as { service?: unknown; protocolVersion?: unknown };
    if (result.protocolVersion !== NATIVE_DESKTOP_PROTOCOL_VERSION) return 'unknown';
    switch (result.service) {
      case 'ready':
      case 'missing':
      case 'stopped':
      case 'denied':
        return result.service;
      default:
        return 'unknown';
    }
  } catch {
    return 'unknown';
  }
}
