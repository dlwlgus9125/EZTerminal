export type RemoteConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'auth-rejected'
  | 'disconnected';

export type ConnectionHealthKind =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'warning'
  | 'unreachable'
  | 'auth-rejected'
  | 'disconnected';

export interface ConnectionHealthSnapshot {
  readonly state: RemoteConnectionState;
  readonly attempt: number;
  readonly nextRetryAt: number | null;
  readonly lastConnectedAt: number | null;
  readonly endpointKind: 'tailscale' | 'other';
}

export interface ConnectionHealthVerdict {
  readonly kind: ConnectionHealthKind;
  readonly label: string;
  readonly detail: string;
  readonly hint?: string;
}

export const CONNECTION_WARNING_ATTEMPTS = 3;
export const CONNECTION_UNREACHABLE_ATTEMPTS = 12;
export const CONNECTION_STALE_MS = 60_000;

export function classifyConnectionHealth(
  snapshot: ConnectionHealthSnapshot,
  now = Date.now(),
): ConnectionHealthVerdict {
  const hint = snapshot.endpointKind === 'tailscale'
    ? 'Check that Tailscale is connected on this device.'
    : undefined;

  if (snapshot.state === 'connected') {
    return { kind: 'connected', label: 'Connected', detail: 'The desktop connection is ready.' };
  }
  if (snapshot.state === 'auth-rejected') {
    return {
      kind: 'auth-rejected',
      label: 'Authentication rejected',
      detail: 'Retry the saved credential once, or pair this device again.',
    };
  }
  if (snapshot.state === 'disconnected') {
    return { kind: 'disconnected', label: 'Disconnected', detail: 'The connection was closed.' };
  }
  if (snapshot.state === 'connecting') {
    return { kind: 'connecting', label: 'Connecting…', detail: 'Contacting the desktop host.' };
  }

  const stale = snapshot.lastConnectedAt === null || now - snapshot.lastConnectedAt >= CONNECTION_STALE_MS;
  if (snapshot.attempt >= CONNECTION_UNREACHABLE_ATTEMPTS && stale) {
    return {
      kind: 'unreachable',
      label: 'Can’t reach desktop',
      detail: `Connection attempt ${snapshot.attempt} failed. Active terminals remain retained.`,
      ...(hint ? { hint } : {}),
    };
  }
  if (snapshot.attempt >= CONNECTION_WARNING_ATTEMPTS) {
    return {
      kind: 'warning',
      label: 'Can’t connect yet',
      detail: `Connection attempt ${snapshot.attempt} failed. Retrying automatically.`,
      ...(hint ? { hint } : {}),
    };
  }
  return {
    kind: 'reconnecting',
    label: 'Reconnecting…',
    detail: 'Active terminals are retained for up to five minutes.',
  };
}

export function classifyEndpoint(url: string): ConnectionHealthSnapshot['endpointKind'] {
  const host = url.match(/^wss?:\/\/([^/:?#]+)/i)?.[1]?.toLowerCase() ?? '';
  if (host.endsWith('.ts.net')) return 'tailscale';
  const firstOctet = Number(host.split('.')[0]);
  return Number.isInteger(firstOctet) && firstOctet === 100 ? 'tailscale' : 'other';
}
