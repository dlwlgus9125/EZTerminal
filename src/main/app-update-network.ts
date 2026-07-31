import { net, type ClientRequest } from 'electron';

import { APP_UPDATE_API_URL, APP_UPDATE_OWNER, APP_UPDATE_REPOSITORY } from '../shared/app-update';

export type UpdateHttpFailureCode =
  | 'ABORTED'
  | 'INVALID_REDIRECT'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'TOO_LARGE';

export class UpdateHttpError extends Error {
  constructor(readonly code: UpdateHttpFailureCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'UpdateHttpError';
  }
}

export interface UpdateHttpResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly receivedBytes: number;
}

export interface UpdateHttpRequest {
  readonly signal: AbortSignal;
  readonly maximumBytes: number;
  readonly idleTimeoutMs: number;
  readonly onChunk: (chunk: Buffer) => void;
}

export interface UpdateHttpClient {
  get(url: string, options: UpdateHttpRequest): Promise<UpdateHttpResult>;
}

const MAX_REDIRECTS = 5;
const RELEASE_ASSET_HOSTS = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);
const RELEASE_PATH_PREFIX = `/${APP_UPDATE_OWNER}/${APP_UPDATE_REPOSITORY}/releases/download/`;

function isAllowedInitialUrl(value: string): boolean {
  if (value === APP_UPDATE_API_URL) return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.pathname.startsWith(RELEASE_PATH_PREFIX)
      && url.hash === ''
    );
  } catch {
    return false;
  }
}

export function isAllowedUpdateRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.port !== ''
      || url.username !== ''
      || url.password !== ''
      || url.hash !== ''
    ) return false;
    if (RELEASE_ASSET_HOSTS.has(url.hostname)) return true;
    return url.hostname === 'github.com' && url.pathname.startsWith(RELEASE_PATH_PREFIX);
  } catch {
    return false;
  }
}

function contentLengthOf(headers: Readonly<Record<string, string | readonly string[]>>): number | null {
  const value = headers['content-length'];
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export class ElectronUpdateHttpClient implements UpdateHttpClient {
  get(url: string, options: UpdateHttpRequest): Promise<UpdateHttpResult> {
    if (!isAllowedInitialUrl(url)) {
      return Promise.reject(new UpdateHttpError('INVALID_REDIRECT'));
    }
    if (options.signal.aborted) {
      return Promise.reject(new UpdateHttpError('ABORTED'));
    }

    return new Promise<UpdateHttpResult>((resolve, reject) => {
      let settled = false;
      let receivedBytes = 0;
      let redirectCount = 0;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const request: ClientRequest = net.request({
        method: 'GET',
        url,
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json, application/octet-stream;q=0.9',
          'User-Agent': 'EZTerminal-Updater',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      const clearIdleTimer = (): void => {
        if (idleTimer !== null) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };
      const settleReject = (error: UpdateHttpError): void => {
        if (settled) return;
        settled = true;
        clearIdleTimer();
        options.signal.removeEventListener('abort', handleAbort);
        request.abort();
        reject(error);
      };
      const resetIdleTimer = (): void => {
        clearIdleTimer();
        idleTimer = setTimeout(() => settleReject(new UpdateHttpError('TIMEOUT')), options.idleTimeoutMs);
      };
      const handleAbort = (): void => settleReject(new UpdateHttpError('ABORTED'));

      options.signal.addEventListener('abort', handleAbort, { once: true });
      request.on('redirect', (_statusCode, _method, redirectUrl) => {
        redirectCount += 1;
        if (redirectCount > MAX_REDIRECTS || !isAllowedUpdateRedirect(redirectUrl)) {
          settleReject(new UpdateHttpError('INVALID_REDIRECT'));
          return;
        }
        request.followRedirect();
        resetIdleTimer();
      });
      request.on('response', (incoming) => {
        const headers = incoming.headers as Readonly<Record<string, string | readonly string[]>>;
        const declaredBytes = contentLengthOf(headers);
        if (declaredBytes !== null && declaredBytes > options.maximumBytes) {
          settleReject(new UpdateHttpError('TOO_LARGE'));
          return;
        }
        resetIdleTimer();
        incoming.on('data', (chunk) => {
          if (settled) return;
          resetIdleTimer();
          receivedBytes += chunk.length;
          if (receivedBytes > options.maximumBytes) {
            settleReject(new UpdateHttpError('TOO_LARGE'));
            return;
          }
          try {
            options.onChunk(chunk);
          } catch (error) {
            settleReject(new UpdateHttpError('NETWORK', error));
          }
        });
        incoming.on('aborted', () => settleReject(new UpdateHttpError('NETWORK')));
        incoming.on('error', (error) => settleReject(new UpdateHttpError('NETWORK', error)));
        incoming.on('end', () => {
          if (settled) return;
          settled = true;
          clearIdleTimer();
          options.signal.removeEventListener('abort', handleAbort);
          resolve({
            statusCode: incoming.statusCode,
            headers,
            receivedBytes,
          });
        });
      });
      request.on('error', (error) => settleReject(new UpdateHttpError('NETWORK', error)));
      resetIdleTimer();
      request.end();
    });
  }
}
