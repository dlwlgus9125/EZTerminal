import type { TFunction } from 'i18next';

export type RemoteConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'auth-rejected'
  | 'protocol-incompatible'
  | 'disconnected';

export type ConnectionHealthKind =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'warning'
  | 'unreachable'
  | 'auth-rejected'
  | 'protocol-incompatible'
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

export type ConnectionHealthTranslator = TFunction<'translation'>;

export const CONNECTION_WARNING_ATTEMPTS = 3;
export const CONNECTION_UNREACHABLE_ATTEMPTS = 12;
export const CONNECTION_STALE_MS = 60_000;

export function classifyConnectionHealth(
  snapshot: ConnectionHealthSnapshot,
  t: ConnectionHealthTranslator,
  now = Date.now(),
): ConnectionHealthVerdict {
  const hint = snapshot.endpointKind === 'tailscale'
    ? t('mobile.connect.tailscaleHint')
    : undefined;

  if (snapshot.state === 'connected') {
    return {
      kind: 'connected',
      label: t('mobile.connect.connectedLabel'),
      detail: t('mobile.connect.connectedDetail'),
    };
  }
  if (snapshot.state === 'auth-rejected') {
    return {
      kind: 'auth-rejected',
      label: t('mobile.connect.authRejectedLabel'),
      detail: t('mobile.connect.authRejectedDetail'),
    };
  }
  if (snapshot.state === 'protocol-incompatible') {
    return {
      kind: 'protocol-incompatible',
      label: t('mobile.connect.protocolIncompatibleLabel'),
      detail: t('mobile.connect.protocolIncompatibleDetail'),
    };
  }
  if (snapshot.state === 'disconnected') {
    return {
      kind: 'disconnected',
      label: t('mobile.connect.disconnectedLabel'),
      detail: t('mobile.connect.disconnectedDetail'),
    };
  }
  if (snapshot.state === 'connecting') {
    return {
      kind: 'connecting',
      label: t('mobile.connect.connecting'),
      detail: t('mobile.connect.connectingDetail'),
    };
  }

  const stale = snapshot.lastConnectedAt === null || now - snapshot.lastConnectedAt >= CONNECTION_STALE_MS;
  if (snapshot.attempt >= CONNECTION_UNREACHABLE_ATTEMPTS && stale) {
    return {
      kind: 'unreachable',
      label: t('mobile.connect.unreachableLabel'),
      detail: t('mobile.connect.unreachableDetail', { attempt: snapshot.attempt }),
      ...(hint ? { hint } : {}),
    };
  }
  if (snapshot.attempt >= CONNECTION_WARNING_ATTEMPTS) {
    return {
      kind: 'warning',
      label: t('mobile.connect.warningLabel'),
      detail: t('mobile.connect.warningDetail', { attempt: snapshot.attempt }),
      ...(hint ? { hint } : {}),
    };
  }
  return {
    kind: 'reconnecting',
    label: t('mobile.connect.reconnecting'),
    detail: t('mobile.connect.retained'),
  };
}

export function classifyEndpoint(url: string): ConnectionHealthSnapshot['endpointKind'] {
  const host = url.match(/^wss?:\/\/([^/:?#]+)/i)?.[1]?.toLowerCase() ?? '';
  if (host.endsWith('.ts.net')) return 'tailscale';
  const firstOctet = Number(host.split('.')[0]);
  return Number.isInteger(firstOctet) && firstOctet === 100 ? 'tailscale' : 'other';
}
