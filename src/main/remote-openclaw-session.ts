import type { ClientToServerMessage , OpenClawChatTicketFailureReason, ServerToClientMessage } from '../shared/remote-protocol';


import {
  OPENCLAW_CONFIG_ALLOWLIST,
  OPENCLAW_CONFIG_UNSET,
  type OpenClawAgentSession,
  type OpenClawControlSnapshot,
  type OpenClawCoreConfig,
  type OpenClawLifecycleAction,
  type OpenClawLifecycleReceipt,
  type OpenClawLogLine,
  type OpenClawSetConfigResult,
  type OpenClawStatus,
} from '../shared/openclaw';
import type { RemoteWs } from './remote-bridge';

export type OpenClawChatTicketResult =
  | { readonly ticket: string; readonly proxyPort: number; readonly token: string; }
  | { readonly ticket: null; readonly reason: OpenClawChatTicketFailureReason; };

export interface RemoteOpenClawSource {
  subscribeStatus(listener: (status: OpenClawStatus) => void): () => void;
  subscribeControl(listener: (snapshot: OpenClawControlSnapshot) => void): () => void;
  runLifecycle(action: OpenClawLifecycleAction): Promise<OpenClawLifecycleReceipt>;
  subscribeLogs(listener: (line: OpenClawLogLine) => void): () => void;
  listAgentSessions(): Promise<readonly OpenClawAgentSession[]>;
  getCoreConfig(): Promise<OpenClawCoreConfig>;
  setCoreConfig(key: string, value: string): Promise<OpenClawSetConfigResult>;
  mintChatTicket(): Promise<OpenClawChatTicketResult>;
  /** Effective desktop presentation visibility right now. This is only an
   * availability hint pushed to mobile; it does not authorize remote APIs. */
  isVisible(): boolean;
  /** Fires whenever desktop visibility changes (the tri-state mode was
   * toggled) — relayed to every authed connection as `openclaw-availability`. */
  subscribeVisibility(listener: (visible: boolean) => void): () => void;
}

const OPENCLAW_LOG_FLUSH_MS = 500;

const OPENCLAW_LOG_PENDING_CAP = 500;

const OPENCLAW_LOG_BACKPRESSURE_BYTES = 262_144;

const OPENCLAW_CHAT_TICKET_TIMEOUT_MS = 15_000;

interface OpenClawConnection {
  readonly source: RemoteOpenClawSource | undefined;
  readonly bufferedAmount: RemoteWs['bufferedAmount'];
  isAuthenticated(): boolean;
  send(message: ServerToClientMessage): void;
}

/** One socket's OpenClaw subscriptions, bounded log queue, and request replies. */
export function createRemoteOpenClawSession(connection: OpenClawConnection) {
  const send = connection.send;
  let openclawStatusSubscribed = false;

  let openclawStatusUnsub: (() => void) | null = null;

  let openclawControlUnsub: (() => void) | null = null;

  let openclawLogsSubscribed = false;

  let openclawLogsUnsub: (() => void) | null = null;

  let pendingOpenClawLogLines: OpenClawLogLine[] = [];

  let openclawLogFlushTimer: ReturnType<typeof setInterval> | null = null;

  const stopOpenClawStatusSubscription = (): void => {
    if (!openclawStatusSubscribed) return;
    openclawStatusSubscribed = false;
    const unsubscribe = openclawStatusUnsub;
    const unsubscribeControl = openclawControlUnsub;
    openclawStatusUnsub = null;
    openclawControlUnsub = null;
    unsubscribe?.();
    unsubscribeControl?.();
  };

  const flushPendingOpenClawLogs = (): void => {
    if (pendingOpenClawLogLines.length === 0) return;
    if ((connection.bufferedAmount ?? 0) > OPENCLAW_LOG_BACKPRESSURE_BYTES) {
      pendingOpenClawLogLines = []; // skip AND clear — don't pile onto a backed-up link
      return;
    }
    const lines = pendingOpenClawLogLines;
    pendingOpenClawLogLines = [];
    send({ kind: 'openclaw-log-lines', lines });
  };

  const stopOpenClawLogsSubscription = (): void => {
    if (!openclawLogsSubscribed) return;
    openclawLogsSubscribed = false;
    const unsubscribe = openclawLogsUnsub;
    openclawLogsUnsub = null;
    if (openclawLogFlushTimer !== null) {
      clearInterval(openclawLogFlushTimer);
      openclawLogFlushTimer = null;
    }
    pendingOpenClawLogLines = [];
    unsubscribe?.();
  };

  const unsubOpenClawVisibility =
    connection.source?.subscribeVisibility((visible) => {
      if (connection.isAuthenticated()) send({ kind: 'openclaw-availability', visible });
    }) ?? (() => undefined);
  return {
    unsubscribeVisibility: unsubOpenClawVisibility,
    stopStatusSubscription: stopOpenClawStatusSubscription,
    stopLogsSubscription: stopOpenClawLogsSubscription,
    authenticated(): void {
      if (connection.source) send({ kind: 'openclaw-availability', visible: connection.source.isVisible() });
    },
    handleMessage(msg: Extract<ClientToServerMessage, { kind: 'openclaw-status-subscribe' | 'openclaw-status-unsubscribe' | 'openclaw-lifecycle' | 'openclaw-logs-subscribe' | 'openclaw-logs-unsubscribe' | 'openclaw-sessions-get' | 'openclaw-config-get' | 'openclaw-config-set' | 'openclaw-chat-ticket'; }>): void {
      switch (msg.kind) {
        case 'openclaw-status-subscribe': {
          if (!connection.source) break;
          if (openclawStatusSubscribed) break; // idempotent — already on
          openclawStatusSubscribed = true;
          openclawStatusUnsub = connection.source.subscribeStatus((status) => {
            send({ kind: 'openclaw-status', status });
          });
          openclawControlUnsub = connection.source.subscribeControl((control) => {
            send({ kind: 'openclaw-control', control });
          });
          break;
        }
        case 'openclaw-status-unsubscribe':
          stopOpenClawStatusSubscription();
          break;
        case 'openclaw-lifecycle': {
          if (!connection.source) break;
          const { requestId, action } = msg;
          connection.source
            .runLifecycle(action)
            .then((result) => send({ kind: 'openclaw-lifecycle-result', requestId, result }))
            .catch((err: unknown) => {
              send({
                kind: 'openclaw-lifecycle-result',
                requestId,
                result: {
                  accepted: false,
                  issue: {
                    code: 'supervisor-failed',
                    detail: err instanceof Error ? err.message : String(err),
                    remediation: 'Retry the requested OpenClaw action.',
                    diagnosticId: `remote-${Date.now().toString(36)}`,
                  },
                },
              });
            });
          break;
        }
        case 'openclaw-logs-subscribe': {
          if (!connection.source) break;
          if (openclawLogsSubscribed) break; // idempotent — already on
          openclawLogsSubscribed = true;
          openclawLogsUnsub = connection.source.subscribeLogs((line) => {
            pendingOpenClawLogLines.push(line);
            if (pendingOpenClawLogLines.length > OPENCLAW_LOG_PENDING_CAP) {
              pendingOpenClawLogLines = pendingOpenClawLogLines.slice(
                pendingOpenClawLogLines.length - OPENCLAW_LOG_PENDING_CAP,
              );
            }
          });
          openclawLogFlushTimer = setInterval(flushPendingOpenClawLogs, OPENCLAW_LOG_FLUSH_MS);
          break;
        }
        case 'openclaw-logs-unsubscribe':
          stopOpenClawLogsSubscription();
          break;
        case 'openclaw-sessions-get': {
          if (!connection.source) break;
          const { requestId } = msg;
          connection.source
            .listAgentSessions()
            .then((sessions) => send({ kind: 'openclaw-sessions-reply', requestId, sessions }))
            .catch(() => send({ kind: 'openclaw-sessions-reply', requestId, sessions: [] }));
          break;
        }
        case 'openclaw-config-get': {
          if (!connection.source) break;
          const { requestId } = msg;
          connection.source
            .getCoreConfig()
            .then((config) => send({ kind: 'openclaw-config-reply', requestId, config }))
            .catch(() =>
              send({
                kind: 'openclaw-config-reply',
                requestId,
                config: Object.fromEntries(OPENCLAW_CONFIG_ALLOWLIST.map((key) => [key, OPENCLAW_CONFIG_UNSET])) as OpenClawCoreConfig,
              }),
            );
          break;
        }
        case 'openclaw-config-set': {
          if (!connection.source) break;
          const { requestId, key, value } = msg;
          // `setCoreConfig` REJECTS for a non-allowlisted key (defense against a
          // hostile/buggy client, see OpenClawService's own doc) — that must
          // surface as an `ok:false` reply, never crash this connection handler.
          connection.source
            .setCoreConfig(key, value)
            .then((result) => send({ kind: 'openclaw-config-set-reply', requestId, result }))
            .catch((err: unknown) => {
              send({
                kind: 'openclaw-config-set-reply',
                requestId,
                result: { ok: false, restartRequired: false, error: err instanceof Error ? err.message : String(err) },
              });
            });
          break;
        }
        case 'openclaw-chat-ticket': {
          if (!connection.source) break;
          const { requestId } = msg;
          let settled = false;
          const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            send({
              kind: 'openclaw-chat-ticket-reply',
              requestId,
              ticket: null,
              proxyPort: 0,
              token: null,
              reason: 'timeout',
            });
          }, OPENCLAW_CHAT_TICKET_TIMEOUT_MS);
          timeout.unref?.();
          void connection.source
            .mintChatTicket()
            .then((result) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              if (result.ticket === null) {
                send({
                  kind: 'openclaw-chat-ticket-reply',
                  requestId,
                  ticket: null,
                  proxyPort: 0,
                  token: null,
                  reason: result.reason,
                });
                return;
              }
              send({
                kind: 'openclaw-chat-ticket-reply',
                requestId,
                ticket: result.ticket,
                proxyPort: result.proxyPort,
                token: result.token,
              });
            })
            .catch(() => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              send({
                kind: 'openclaw-chat-ticket-reply',
                requestId,
                ticket: null,
                proxyPort: 0,
                token: null,
                reason: 'proxy-unavailable',
              });
            });
          break;
        }
      }
    },
  };
}
