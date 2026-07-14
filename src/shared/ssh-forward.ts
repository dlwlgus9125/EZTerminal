/** Shared, JSON-cloneable contracts for loopback-only SSH local forwarding. */

export const SSH_FORWARD_BIND_HOST = '127.0.0.1' as const;
export const SSH_FORWARD_MAX_PER_CONNECTION = 16;
export const SSH_FORWARD_MAX_GLOBAL = 64;
export const SSH_FORWARD_MAX_STREAMS_GLOBAL = 128;
export const SSH_FORWARD_STREAM_HIGH_WATER = 1024 * 1024;
export const SSH_FORWARD_STREAM_LOW_WATER = 256 * 1024;
export const SSH_FORWARD_STREAM_OPEN_TIMEOUT_MS = 10_000;
/** ssh2 cannot cancel a dispatched forwardOut callback; keep late callbacks bounded. */
export const SSH_FORWARD_PENDING_OPEN_CAP = 32;

export type SshForwardErrorCode =
  | 'INVALID_CONNECTION_ID'
  | 'INVALID_FORWARD_ID'
  | 'INVALID_REMOTE_HOST'
  | 'INVALID_REMOTE_PORT'
  | 'INVALID_LOCAL_PORT'
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_NOT_READY'
  | 'CONNECTION_CLOSED'
  | 'FORWARD_NOT_FOUND'
  | 'FORWARD_NOT_OWNED'
  | 'ORIGIN_NOT_ALLOWED'
  | 'FORWARD_LIMIT_REACHED'
  | 'STREAM_LIMIT_REACHED'
  | 'BIND_FAILED'
  | 'STREAM_OPEN_FAILED'
  | 'CANCELLED'
  | 'INTERPRETER_UNAVAILABLE'
  | 'INTERNAL';

export interface SshForwardErrorInfo {
  readonly code: SshForwardErrorCode;
  readonly message: string;
}

export interface SshForwardInfo {
  readonly forwardId: string;
  readonly connectionId: string;
  readonly bindHost: typeof SSH_FORWARD_BIND_HOST;
  readonly localPort: number;
  readonly remoteHost: string;
  readonly remotePort: number;
  readonly state: 'listening';
}

export interface SshForwardStartInput {
  readonly connectionId: string;
  readonly remoteHost: string;
  readonly remotePort: number;
  /** Zero asks the OS for an ephemeral loopback port. */
  readonly localPort: number;
}

export type SshForwardAction =
  | ({ readonly action: 'start' } & SshForwardStartInput)
  | { readonly action: 'list'; readonly connectionId: string }
  | { readonly action: 'stop'; readonly connectionId: string; readonly forwardId: string };

export type SshForwardResult =
  | { readonly ok: true; readonly forwards: readonly SshForwardInfo[] }
  | { readonly ok: false; readonly error: SshForwardErrorInfo };

/** Main -> interpreter, transferred-port control/data protocol. */
export type MainToSshForwardStream =
  | { readonly type: 'data'; readonly data: Uint8Array; readonly bytes: number }
  | { readonly type: 'ack'; readonly bytes: number }
  | { readonly type: 'end' };

/** Interpreter -> main, transferred-port control/data protocol. */
export type SshForwardStreamToMain =
  | { readonly type: 'ready' }
  | { readonly type: 'data'; readonly data: Uint8Array; readonly bytes: number }
  | { readonly type: 'ack'; readonly bytes: number }
  | { readonly type: 'end' }
  | { readonly type: 'error'; readonly error: SshForwardErrorInfo };

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DNS_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function isIpv6Literal(value: string): boolean {
  if (!/^[0-9A-Fa-f:]+$/.test(value) || value.includes(':::')) return false;
  const compression = value.indexOf('::');
  if (compression !== -1 && value.indexOf('::', compression + 2) !== -1) return false;
  const groups = value.split(':');
  if (compression === -1) return groups.length === 8 && groups.every((group) => /^[0-9A-Fa-f]{1,4}$/.test(group));
  const present = groups.filter((group) => group.length > 0);
  return present.length < 8 && present.every((group) => /^[0-9A-Fa-f]{1,4}$/.test(group));
}

export class SshForwardError extends Error {
  constructor(
    readonly code: SshForwardErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SshForwardError';
  }

  toInfo(): SshForwardErrorInfo {
    return { code: this.code, message: this.message };
  }
}

export function validateSshConnectionId(value: string): void {
  if (!ID_RE.test(value)) throw new SshForwardError('INVALID_CONNECTION_ID', 'SSH connection id is invalid');
}

export function validateSshForwardId(value: string): void {
  if (!ID_RE.test(value)) throw new SshForwardError('INVALID_FORWARD_ID', 'SSH forward id is invalid');
}

/** Accept DNS names, IPv4, and colon-delimited IPv6 literals; reject every
 * control/whitespace/shell-like form before it reaches ssh2. */
export function validateSshRemoteHost(value: string): void {
  if (!value || value.length > 253 || /[\p{Cc}\s/@\\]/u.test(value)) {
    throw new SshForwardError('INVALID_REMOTE_HOST', 'SSH forward remote host is invalid');
  }
  if (value.includes(':')) {
    if (!isIpv6Literal(value)) {
      throw new SshForwardError('INVALID_REMOTE_HOST', 'SSH forward remote host is invalid');
    }
    return;
  }
  const labels = value.split('.');
  if (labels.some((label) => !DNS_LABEL_RE.test(label))) {
    throw new SshForwardError('INVALID_REMOTE_HOST', 'SSH forward remote host is invalid');
  }
  // Numeric dotted forms must be canonical IPv4, not ambiguous octal/short forms.
  if (labels.every((label) => /^\d+$/.test(label))) {
    if (labels.length !== 4 || labels.some((label) => Number(label) > 255 || String(Number(label)) !== label)) {
      throw new SshForwardError('INVALID_REMOTE_HOST', 'SSH forward remote host is invalid');
    }
  }
}

export function validateSshRemotePort(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new SshForwardError('INVALID_REMOTE_PORT', 'SSH forward remote port must be an integer from 1 to 65535');
  }
}

export function validateSshLocalPort(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new SshForwardError('INVALID_LOCAL_PORT', 'SSH forward local port must be an integer from 0 to 65535');
  }
}

export function validateSshForwardAction(action: SshForwardAction): void {
  validateSshConnectionId(action.connectionId);
  if (action.action === 'start') {
    validateSshRemoteHost(action.remoteHost);
    validateSshRemotePort(action.remotePort);
    validateSshLocalPort(action.localPort);
  } else if (action.action === 'stop') {
    validateSshForwardId(action.forwardId);
  }
}

export function sshForwardFailure(error: unknown): SshForwardResult {
  if (error instanceof SshForwardError) return { ok: false, error: error.toInfo() };
  return { ok: false, error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) } };
}
