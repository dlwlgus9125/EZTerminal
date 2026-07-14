/**
 * OpenClawService — the main process's sole owner of OpenClaw gateway access
 * (openclaw-management M1). Electron-free (constructor-injected `{spawn,
 * httpGet, wsFactory, readFile, env, now}`) so the whole surface is
 * unit-testable; `main.ts` wires the real seams and exposes IPC over it.
 *
 * M0 Stage-0 (docs/research/2026-07-12-openclaw-stage0.md) found the CLI
 * unusable for anything on a hot path — `gateway status --json --no-probe`
 * alone costs 9-10s, `status --json` 17-18s (dozens of eagerly-loaded command
 * groups at Node startup, not a one-off cold-start blip). Every polled/
 * interactive read therefore goes over WS RPC or a plain HTTP GET; the CLI is
 * reserved for genuinely rare, user-initiated actions that already have a
 * "busy" affordance: `gateway start/stop/restart`, install detection (PATH
 * resolution only — no spawn), and `config get/set`.
 *
 * WS RPC handshake (verified live against a real gateway, 2026-07-12 — the
 * protocol docs' own worked example used a `client.mode` that this gateway's
 * schema actually rejects; `id:'gateway-client'`/`mode:'backend'` is the
 * combination that is both accepted AND granted full `operator.read`/
 * `operator.write` scope on a token-mode loopback gateway — `mode:'cli'` also
 * connects but comes back with EMPTY granted scopes, useless for reads):
 *   1. Server pushes `{type:'event', event:'connect.challenge', payload:{nonce}}`
 *      unsolicited on socket open — the client does not initiate.
 *   2. Client replies `{type:'req', id, method:'connect', params:{...,
 *      auth:{token}}}`; server replies `{type:'res', id, ok, payload:
 *      {type:'hello-ok', ...}}` (or `ok:false` + `error`).
 *   3. Every further call is `{type:'req', id, method, params}` ->
 *      `{type:'res', id, ok, payload|error}`, correlated by `id`. Unsolicited
 *      server pushes (`tick`, `sessions.changed`, ...) arrive as
 *      `{type:'event', event, payload}` with no `id` — this client ignores
 *      them (no push consumer needed for M1's read/enrich scope).
 *
 * `logs.tail` (method name confirmed present in the live `hello-ok.features.
 * methods` list — resolves the handoff's open risk) is a ONE-SHOT byte-cursor
 * read (`{cursor?, limit?} -> {cursor, size, lines, truncated, reset}`), not a
 * subscription — verified live: re-calling with the previous response's
 * `cursor` returns `lines:[]` once caught up. `subscribeLogs` therefore polls
 * it on an interval instead of spawning `openclaw logs --follow --json`
 * (avoiding an entire child-process refcount/kill-idempotence surface the
 * plan anticipated needing). Each returned line is itself a JSON-encoded
 * string (tslog's file format) with ANSI color codes baked into `.message`;
 * `parseLogLine` unwraps and strips them.
 */
import { promises as fsPromises } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import crossSpawn from 'cross-spawn';
import { WebSocket as NodeWebSocket } from 'ws';

import { CommandResolver, envGet, type EnvLike } from '../interpreter/external/command-resolver';
import {
  OPENCLAW_CONFIG_ALLOWLIST,
  OPENCLAW_CONFIG_UNSET,
  type OpenClawAgentSession,
  type OpenClawAutostartAction,
  type OpenClawAutostartResult,
  type OpenClawConfigKey,
  type OpenClawCoreConfig,
  type OpenClawEndpoint,
  type OpenClawLifecycleAction,
  type OpenClawLifecycleResult,
  type OpenClawLogLine,
  type OpenClawInsecureAuthStatus,
  type OpenClawSetConfigResult,
  type OpenClawStatus,
} from '../shared/openclaw';

const DEFAULT_PORT = 18789;
const DEFAULT_HOST = '127.0.0.1';
const ENDPOINT_UNAVAILABLE_ERROR = 'EZTERMINAL_OPENCLAW_URL must be a valid http origin';
const MUTATION_BUSY_ERROR = 'OpenClaw lifecycle operation is already running';

const HTTP_LIVENESS_TIMEOUT_MS = 5000;
const RPC_CONNECT_TIMEOUT_MS = 5000;
const RPC_CALL_TIMEOUT_MS = 10_000;
const RPC_INITIAL_BACKOFF_MS = 500;
const RPC_MAX_BACKOFF_MS = 5000;

// M1 (openclaw-management stabilization): a single timed-out/errored probe no
// longer flips `running` -> `stopped` — the gateway can go briefly
// unresponsive (e.g. a busy cron job) without actually being down. A
// `refused` failure (the OS rejects the connection outright) is still treated
// as definitive since a stopped gateway refuses instantly.
const STATUS_FAILURE_THRESHOLD = 3;

// M2 (openclaw-stabilization): TTL for a NEGATIVE `isInstalled()` result only
// — see isInstalled's doc for why a positive one never expires.
const INSTALL_RECHECK_MS = 30_000;

const STATUS_POLL_INTERVAL_MS = 4000;
const LOG_POLL_INTERVAL_MS = 2000;
const LOG_BACKFILL_LIMIT = 50;
const LOG_POLL_LIMIT = 200;
const CLI_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const CLI_KILL_GRACE_MS = 2000;

interface OpenClawCliTimeouts {
  readonly config: number;
  readonly lifecycle: number;
  readonly autostart: number;
}

const DEFAULT_CLI_TIMEOUTS: OpenClawCliTimeouts = {
  config: 20_000,
  lifecycle: 30_000,
  autostart: 60_000,
};

const OPENCLAW_CLIENT_VERSION = '1.0.0';
// eslint-disable-next-line no-control-regex -- deliberately matching ESC (0x1B) that starts an ANSI SGR code
const ANSI_PATTERN = /\[[0-9;]*m/g;

// ── DI seams (narrow slices of child_process/http/ws — real instances satisfy
//    these structurally, fakes in tests need implement nothing more) ─────────

export interface ChildProcessLike {
  readonly pid?: number;
  readonly stdout?: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  readonly stderr?: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  kill?(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: (code: number | null) => void): void;
}

export type SpawnFn = (
  file: string,
  args: readonly string[],
  options: { shell?: boolean; windowsHide?: boolean },
) => ChildProcessLike;

export interface HttpGetResult {
  readonly ok: boolean;
  /** Failure classification (absent when `ok` is true). `refused` is a
   * definitive "not running" signal (the OS rejected the connection
   * outright); `timeout`/`error` are ambiguous — the gateway may just be
   * momentarily busy — and get debounced in `getStatus`. */
  readonly reason?: 'timeout' | 'refused' | 'error';
}

export type HttpGetFn = (url: string) => Promise<HttpGetResult>;

export interface OpenClawWsLike {
  send(data: string): void;
  close(code?: number): void;
  on(event: 'message', listener: (data: { toString(): string }) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: unknown) => void): void;
}

export type OpenClawWsFactory = (url: string) => OpenClawWsLike;

export interface OpenClawServiceDeps {
  spawn?: SpawnFn;
  httpGet?: HttpGetFn;
  wsFactory?: OpenClawWsFactory;
  readFile?: (path: string) => Promise<string>;
  env?: EnvLike;
  now?: () => number;
  cliTimeouts?: Partial<OpenClawCliTimeouts>;
  killProcess?: (child: ChildProcessLike) => void;
}

const defaultSpawn: SpawnFn = (file, args, options) =>
  crossSpawn(file, args, options) as unknown as ChildProcessLike;

function defaultKillProcess(child: ChildProcessLike): void {
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = crossSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => {
        try {
          child.kill?.();
        } catch {
          // The process may already have exited between timeout and kill.
        }
      });
      return;
    } catch {
      // Fall through to the direct child-process signal.
    }
  }
  try {
    child.kill?.('SIGTERM');
  } catch {
    return;
  }
  const forceTimer = setTimeout(() => {
    try {
      child.kill?.('SIGKILL');
    } catch {
      // Already exited.
    }
  }, CLI_KILL_GRACE_MS);
  forceTimer.unref?.();
}

function defaultHttpGet(url: string): Promise<HttpGetResult> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: HTTP_LIVENESS_TIMEOUT_MS }, (res) => {
      res.resume(); // drain — we only care that the server answered
      resolve({ ok: (res.statusCode ?? 0) < 500 });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'timeout' });
    });
    req.on('error', (err: NodeJS.ErrnoException) =>
      resolve({ ok: false, reason: err.code === 'ECONNREFUSED' ? 'refused' : 'error' }),
    );
  });
}

const defaultWsFactory: OpenClawWsFactory = (url) => new NodeWebSocket(url) as unknown as OpenClawWsLike;

function defaultReadFile(target: string): Promise<string> {
  return fsPromises.readFile(target, 'utf8');
}

// ── Log line parsing ──────────────────────────────────────────────────────

interface RawLogEntry {
  readonly time?: string;
  readonly message?: string;
  readonly _meta?: { readonly logLevelName?: string };
}

/** Exported for unit testing — see the module doc for the double-encoded,
 * ANSI-laden shape `logs.tail` actually returns. */
export function parseLogLine(raw: string, now: () => number): OpenClawLogLine {
  try {
    const parsed = JSON.parse(raw) as RawLogEntry;
    const message = typeof parsed.message === 'string' ? parsed.message.replace(ANSI_PATTERN, '') : raw;
    return {
      time: typeof parsed.time === 'string' ? parsed.time : new Date(now()).toISOString(),
      level: parsed._meta?.logLevelName ?? 'INFO',
      message,
    };
  } catch {
    return { time: new Date(now()).toISOString(), level: 'INFO', message: raw.replace(ANSI_PATTERN, '') };
  }
}

// ── WS RPC envelope + connection ──────────────────────────────────────────

interface RpcEnvelope {
  readonly type?: 'req' | 'res' | 'event';
  readonly id?: string;
  readonly ok?: boolean;
  readonly payload?: unknown;
  readonly error?: { readonly code?: string; readonly message?: string };
  readonly event?: string;
}

type PendingRpc = { resolve: (v: unknown) => void; reject: (err: Error) => void };

/**
 * One WS connection to the gateway, correlating `req`/`res` by `id`. Two
 * lifecycles share this class: a THROWAWAY one-off (`connect()` once, one or
 * two `call()`s, then `close()` — used when nothing is subscribed) and a
 * PERSISTENT one (`enablePersistent()` — auto-reconnects with capped backoff
 * until `close()`, used while `subscribeStatus`/`subscribeLogs` has ≥1
 * listener). Both share the same connect/call/close machinery.
 */
class OpenClawRpcConnection {
  private ws: OpenClawWsLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingRpc>();
  private reqCounter = 0;
  private disposed = false;
  private persistent = false;
  private backoffMs = RPC_INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly wsFactory: OpenClawWsFactory,
    private readonly url: string,
    private readonly getToken: () => Promise<string | null>,
  ) {}

  get isConnected(): boolean {
    return this.ws !== null;
  }

  /** Enables auto-reconnect-with-backoff on an unexpected close and connects now. */
  enablePersistent(): void {
    this.persistent = true;
    void this.connect().catch(() => undefined);
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('openclaw rpc connection disposed'));
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect();
    return this.connectPromise;
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = this.wsFactory(this.url);
      this.ws = ws;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error('openclaw rpc connect timeout'));
      }, RPC_CONNECT_TIMEOUT_MS);

      ws.on('message', (data) => {
        let msg: RpcEnvelope;
        try {
          msg = JSON.parse(data.toString()) as RpcEnvelope;
        } catch {
          return;
        }
        if (!settled && msg.type === 'event' && msg.event === 'connect.challenge') {
          void this.sendConnectRequest(ws);
          return;
        }
        if (!settled && msg.type === 'res' && msg.id === 'connect') {
          settled = true;
          clearTimeout(timer);
          if (msg.ok) {
            this.backoffMs = RPC_INITIAL_BACKOFF_MS;
            resolve();
          } else {
            reject(new Error(msg.error?.message ?? 'openclaw connect rejected'));
          }
          return;
        }
        this.handleMessage(msg);
      });

      ws.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      ws.on('close', () => {
        this.ws = null;
        this.connectPromise = null;
        this.failAllPending(new Error('openclaw rpc connection closed'));
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('openclaw rpc closed before handshake completed'));
        }
        this.scheduleReconnect();
      });
    });
  }

  private async sendConnectRequest(ws: OpenClawWsLike): Promise<void> {
    const token = await this.getToken();
    ws.send(
      JSON.stringify({
        type: 'req',
        id: 'connect',
        method: 'connect',
        params: {
          minProtocol: 1,
          maxProtocol: 4,
          client: { id: 'gateway-client', version: OPENCLAW_CLIENT_VERSION, platform: process.platform, mode: 'backend' },
          role: 'operator',
          scopes: ['operator.read', 'operator.write'],
          auth: { token: token ?? '' },
        },
      }),
    );
  }

  private handleMessage(msg: RpcEnvelope): void {
    if (msg.type !== 'res' || !msg.id) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.ok) pending.resolve(msg.payload);
    else pending.reject(new Error(msg.error?.message ?? 'openclaw rpc error'));
  }

  private scheduleReconnect(): void {
    if (!this.persistent || this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, RPC_MAX_BACKOFF_MS);
      void this.connect().catch(() => undefined);
    }, this.backoffMs);
  }

  async call(method: string, params: unknown = {}): Promise<unknown> {
    await this.connect();
    const ws = this.ws;
    if (!ws) throw new Error('openclaw rpc not connected');
    const id = `m${++this.reqCounter}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`openclaw rpc timeout: ${method}`));
      }, RPC_CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  private failAllPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.persistent = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failAllPending(new Error('openclaw rpc connection disposed'));
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.connectPromise = null;
  }
}

// ── OpenClawService ────────────────────────────────────────────────────────

function createEndpoint(
  rawUrl: string,
  generation: number,
  source: OpenClawEndpoint['source'],
): OpenClawEndpoint | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:') return null;
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    const origin = parsed.origin;
    const port = parsed.port ? Number(parsed.port) : 80;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
    return {
      origin,
      wsUrl: origin.replace(/^http/, 'ws'),
      port,
      generation,
      source,
    };
  } catch {
    return null;
  }
}

export class OpenClawService {
  private readonly env: EnvLike;
  private readonly spawnFn: SpawnFn;
  private readonly httpGet: HttpGetFn;
  private readonly wsFactory: OpenClawWsFactory;
  private readonly readFileFn: (path: string) => Promise<string>;
  private readonly now: () => number;
  private readonly cliTimeouts: OpenClawCliTimeouts;
  private readonly killProcess: (child: ChildProcessLike) => void;
  private endpoint: OpenClawEndpoint;
  private readonly endpointLockedByEnv: boolean;
  private readonly endpointUnavailableReason: string | null;
  private pendingPort: number | null = null;
  private endpointInitialization: Promise<void> | null = null;
  private readonly endpointListeners = new Set<(endpoint: OpenClawEndpoint) => void>();

  private installedCache: boolean | null = null;
  // M2: timestamp of the last NEGATIVE isInstalled() resolution — see
  // isInstalled's doc. Unused while installedCache is `true` or `null`.
  private installedCacheAt: number | null = null;
  private configPathPromise: Promise<string> | null = null;

  private mutationBusy = false;
  private busyAction: OpenClawLifecycleAction | null = null;

  // M1 status debounce — see STATUS_FAILURE_THRESHOLD's comment.
  private wasRunning = false;
  private probeFailureStreak = 0;
  // Coalesces concurrent getStatus() callers (the renderer's one-shot IPC
  // getStatus can overlap the internal poll loop) onto a single in-flight
  // probe — otherwise two concurrent failing probes would each advance
  // probeFailureStreak, shortening the intended debounce window.
  private statusProbe: Promise<OpenClawStatus> | null = null;

  private rpc: OpenClawRpcConnection | null = null;
  private rpcRefCount = 0;

  private readonly statusListeners = new Set<(status: OpenClawStatus) => void>();
  private statusTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly logListeners = new Set<(line: OpenClawLogLine) => void>();
  private logTimer: ReturnType<typeof setTimeout> | null = null;
  private logCursor: number | undefined;
  private logBackfillDone = false;

  private disposed = false;

  constructor(deps: OpenClawServiceDeps = {}) {
    this.env = deps.env ?? (process.env as EnvLike);
    this.spawnFn = deps.spawn ?? defaultSpawn;
    this.httpGet = deps.httpGet ?? defaultHttpGet;
    this.wsFactory = deps.wsFactory ?? defaultWsFactory;
    this.readFileFn = deps.readFile ?? defaultReadFile;
    this.now = deps.now ?? Date.now;
    this.cliTimeouts = { ...DEFAULT_CLI_TIMEOUTS, ...deps.cliTimeouts };
    this.killProcess = deps.killProcess ?? defaultKillProcess;

    const urlOverride = envGet(this.env, 'EZTERMINAL_OPENCLAW_URL');
    const defaultEndpoint = createEndpoint(`http://${DEFAULT_HOST}:${DEFAULT_PORT}`, 0, 'default');
    if (!defaultEndpoint) throw new Error('invalid built-in OpenClaw endpoint');
    const environmentEndpoint = urlOverride ? createEndpoint(urlOverride, 0, 'environment') : null;
    this.endpointLockedByEnv = Boolean(urlOverride);
    this.endpointUnavailableReason = urlOverride && !environmentEndpoint ? ENDPOINT_UNAVAILABLE_ERROR : null;
    // Keep a well-formed endpoint object for the existing Interface, but it
    // is only an inert placeholder while endpointUnavailableReason is set.
    // Every network and mutation surface below fails closed before using it.
    this.endpoint = environmentEndpoint ?? defaultEndpoint;
  }

  getEndpoint(): OpenClawEndpoint {
    return this.endpoint;
  }

  onEndpointChanged(listener: (endpoint: OpenClawEndpoint) => void): () => void {
    this.endpointListeners.add(listener);
    return () => {
      this.endpointListeners.delete(listener);
    };
  }

  private activatePort(port: number, source: OpenClawEndpoint['source']): void {
    if (this.endpointLockedByEnv) return;
    const current = new URL(this.endpoint.origin);
    current.port = String(port);
    const next = createEndpoint(current.origin, this.endpoint.generation + 1, source);
    if (!next || next.origin === this.endpoint.origin) {
      this.pendingPort = null;
      return;
    }
    this.endpoint = next;
    this.pendingPort = null;
    this.wasRunning = false;
    this.probeFailureStreak = 0;
    this.statusProbe = null;
    this.logCursor = undefined;
    this.logBackfillDone = false;
    if (this.rpc) {
      this.rpc.close();
      this.rpc = null;
      if (this.rpcRefCount > 0) {
        this.rpc = new OpenClawRpcConnection(this.wsFactory, next.wsUrl, () => this.getChatToken());
        this.rpc.enablePersistent();
      }
    }
    for (const listener of this.endpointListeners) {
      try {
        listener(next);
      } catch (error) {
        console.error('[OpenClawService] endpoint listener failed:', error);
      }
    }
  }

  /** Resolve the configured gateway port before the first network/chat read. */
  private ensureEndpointInitialized(): Promise<void> {
    if (this.endpointLockedByEnv || this.endpointUnavailableReason) return Promise.resolve();
    if (!this.endpointInitialization) {
      this.endpointInitialization = (async () => {
        try {
          const configPath = await this.resolveConfigPath();
          const text = await this.readFileFn(configPath);
          const parsed = JSON.parse(text) as { gateway?: { port?: unknown } };
          const rawPort = parsed.gateway?.port;
          const configuredPort = typeof rawPort === 'number'
            ? rawPort
            : typeof rawPort === 'string'
              ? Number(rawPort)
              : Number.NaN;
          if (
            this.pendingPort === null
            && Number.isSafeInteger(configuredPort)
            && configuredPort >= 1
            && configuredPort <= 65_535
          ) {
            this.activatePort(configuredPort, 'config');
          }
        } catch {
          // Missing/malformed config retains the built-in default endpoint.
        }
      })();
    }
    return this.endpointInitialization;
  }

  // ── Status ────────────────────────────────────────────────────────────

  async getStatus(force = false): Promise<OpenClawStatus> {
    if (this.endpointUnavailableReason) return { state: 'unknown', port: this.endpoint.port };
    await this.ensureEndpointInitialized();
    if (force) {
      this.installedCache = null;
      this.installedCacheAt = null;
    }
    if (!this.statusProbe) {
      const endpoint = this.endpoint;
      const probe = this.probeStatus(endpoint);
      this.statusProbe = probe;
      void probe.finally(() => {
        if (this.statusProbe === probe) this.statusProbe = null;
      });
    }
    return this.statusProbe;
  }

  private async probeStatus(endpoint: OpenClawEndpoint): Promise<OpenClawStatus> {
    if (!(await this.isInstalled())) return { state: 'not-installed', port: endpoint.port };

    let probe: HttpGetResult;
    try {
      probe = await this.httpGet(`${endpoint.origin}/`);
    } catch {
      return { state: 'unknown', port: endpoint.port };
    }
    if (endpoint.generation !== this.endpoint.generation) return this.probeStatus(this.endpoint);

    if (probe.ok) {
      this.wasRunning = true;
      this.probeFailureStreak = 0;
      const enrichment = await this.withRpc((rpc) => rpc.call('status'));
      const version =
        enrichment && typeof enrichment === 'object' && enrichment !== null && 'runtimeVersion' in enrichment
          ? String((enrichment as { runtimeVersion: unknown }).runtimeVersion)
          : undefined;
      return { state: 'running', port: endpoint.port, version };
    }

    // `refused` is definitive (a stopped gateway refuses instantly) — report
    // it right away. `timeout`/`error` are ambiguous, so a prior `running`
    // observation is held through up to STATUS_FAILURE_THRESHOLD - 1
    // transient failures before flipping to `stopped`.
    if (probe.reason !== 'refused' && this.wasRunning) {
      this.probeFailureStreak += 1;
      if (this.probeFailureStreak < STATUS_FAILURE_THRESHOLD) {
        return { state: 'running', port: endpoint.port };
      }
    }
    this.wasRunning = false;
    this.probeFailureStreak = 0;
    const starting = this.busyAction === 'start' || this.busyAction === 'restart';
    return { state: starting ? 'starting' : 'stopped', port: endpoint.port };
  }

  /** PATH resolution only — no spawn (see the module doc). A `true` result
   * caches forever (the CLI doesn't get uninstalled mid-session in any
   * realistic scenario); a `false` result caches for only
   * INSTALL_RECHECK_MS (M2), so a user who installs the CLI mid-session sees
   * OpenClaw UI appear within ~30s of the next probe, without needing an
   * app restart or an explicit `getStatus(force=true)`. */
  async isInstalled(): Promise<boolean> {
    if (this.installedCache === true) return true;
    if (
      this.installedCache === false &&
      this.installedCacheAt !== null &&
      this.now() - this.installedCacheAt < INSTALL_RECHECK_MS
    ) {
      return false;
    }
    const cliName = envGet(this.env, 'EZTERMINAL_OPENCLAW_CLI') ?? 'openclaw';
    const resolver = new CommandResolver(this.env);
    const resolved = resolver.resolve(cliName, []) !== null;
    this.installedCache = resolved;
    this.installedCacheAt = resolved ? null : this.now();
    return resolved;
  }

  subscribeStatus(listener: (status: OpenClawStatus) => void): () => void {
    this.statusListeners.add(listener);
    this.acquireRpc();
    this.ensureStatusLoop();
    return () => {
      if (!this.statusListeners.delete(listener)) return;
      if (this.statusListeners.size === 0 && this.statusTimer) {
        clearTimeout(this.statusTimer);
        this.statusTimer = null;
      }
      this.releaseRpc();
    };
  }

  private ensureStatusLoop(): void {
    if (this.statusTimer || this.statusListeners.size === 0) return;
    const tick = (): void => {
      void this.getStatus().then((status) => {
        this.notifyStatusListeners(status);
        if (this.statusListeners.size > 0) this.statusTimer = setTimeout(tick, STATUS_POLL_INTERVAL_MS);
      });
    };
    this.statusTimer = setTimeout(tick, 0);
  }

  private async pushStatusNow(): Promise<void> {
    if (this.statusListeners.size === 0) return;
    const status = await this.getStatus();
    this.notifyStatusListeners(status);
  }

  private notifyStatusListeners(status: OpenClawStatus): void {
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (error) {
        // Observers are adapters owned by callers. Their failure must not
        // break service polling or change a successful lifecycle result.
        console.error('[OpenClawService] status listener failed:', error);
      }
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async runLifecycle(action: OpenClawLifecycleAction): Promise<OpenClawLifecycleResult> {
    if (this.endpointUnavailableReason) {
      return { ok: false, code: 'unavailable', stderr: this.endpointUnavailableReason };
    }
    if (this.mutationBusy) {
      return { ok: false, code: 'busy', stderr: MUTATION_BUSY_ERROR };
    }
    this.mutationBusy = true;
    this.busyAction = action;
    try {
      const result = await this.execCli(['gateway', action], this.cliTimeouts.lifecycle, 'lifecycle').then(
        ({ code, stderr, timedOut }) =>
          code === 0
            ? { ok: true as const }
            : {
                ok: false as const,
                code: timedOut ? ('timeout' as const) : ('cli-failed' as const),
                stderr: stderr || `exit code ${code}`,
              },
      );
      // A user-initiated stop must show up as `stopped` immediately, not
      // after riding out the debounce grace on the next poll.
      if (action === 'stop' && result.ok) {
        this.wasRunning = false;
        this.probeFailureStreak = 0;
      }
      if ((action === 'start' || action === 'restart') && result.ok && this.pendingPort !== null) {
        this.activatePort(this.pendingPort, 'config');
      }
      return result;
    } finally {
      this.busyAction = null;
      this.mutationBusy = false;
      await this.pushStatusNow();
    }
  }

  // ── Autostart (task #9: `gateway install`/`gateway uninstall`) ──────────
  // Shares `lifecycleOp`'s serialization lane with `runLifecycle` — installing
  // the OS service must never race a concurrent start/stop/restart CLI spawn.
  // Deliberately does NOT touch `busyAction` (that flag only means "gateway
  // is starting up", which install/uninstall never causes).
  async runAutostart(action: OpenClawAutostartAction): Promise<OpenClawAutostartResult> {
    if (this.endpointUnavailableReason) {
      return { ok: false, code: 'unavailable', stderr: this.endpointUnavailableReason };
    }
    if (this.mutationBusy) {
      return { ok: false, code: 'busy', stderr: MUTATION_BUSY_ERROR };
    }
    this.mutationBusy = true;
    try {
      return await this.execCli(['gateway', action], this.cliTimeouts.autostart, 'autostart').then(
        ({ code, stderr, timedOut }) =>
          code === 0
            ? { ok: true as const }
            : {
                ok: false as const,
                code: timedOut ? ('timeout' as const) : ('cli-failed' as const),
                stderr: stderr || `exit code ${code}`,
              },
      );
    } finally {
      this.mutationBusy = false;
    }
  }

  // ── Sessions ──────────────────────────────────────────────────────────

  async listAgentSessions(): Promise<readonly OpenClawAgentSession[]> {
    const result = await this.withRpc((rpc) => rpc.call('sessions.list'));
    if (!result || typeof result !== 'object') return [];
    const sessions = (result as { sessions?: unknown }).sessions;
    if (!Array.isArray(sessions)) return [];
    const out: OpenClawAgentSession[] = [];
    for (const raw of sessions) {
      const session = toAgentSession(raw);
      if (session) out.push(session);
    }
    return out;
  }

  // ── Core config ───────────────────────────────────────────────────────

  async getCoreConfig(): Promise<OpenClawCoreConfig> {
    const entries = await Promise.all(
      OPENCLAW_CONFIG_ALLOWLIST.map(async (key) => [key, await this.cliConfigGet(key)] as const),
    );
    const config = Object.fromEntries(entries) as OpenClawCoreConfig;
    if (!this.endpointLockedByEnv && this.pendingPort === null) {
      const configuredPort = Number(config['gateway.port']);
      if (Number.isSafeInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65_535) {
        this.activatePort(configuredPort, 'config');
      }
    }
    return config;
  }

  private async cliConfigGet(key: OpenClawConfigKey): Promise<string> {
    const { code, stdout } = await this.execCli(
      ['config', 'get', key, '--json'],
      this.cliTimeouts.config,
      'config',
    );
    // M0 ①: exit 1 ("Config path not found: ...") is the UNSET signal, not an
    // error — every allowlisted field can legitimately be absent from the file.
    if (code !== 0) return OPENCLAW_CONFIG_UNSET;
    const trimmed = stdout.trim();
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed : trimmed;
    } catch {
      return trimmed || OPENCLAW_CONFIG_UNSET;
    }
  }

  async setCoreConfig(key: string, value: string): Promise<OpenClawSetConfigResult> {
    if (!(OPENCLAW_CONFIG_ALLOWLIST as readonly string[]).includes(key)) {
      // Defense against a hostile/buggy mobile client — the allowlist is
      // enforced HERE, not just in the UI that normally constrains it.
      throw new Error(`setCoreConfig: '${key}' is not an allowlisted config key`);
    }
    if (this.endpointUnavailableReason) {
      return {
        ok: false,
        restartRequired: false,
        code: 'unavailable',
        error: this.endpointUnavailableReason,
      };
    }
    const trimmed = value.trim();
    let encodedValue: string;
    if (key === 'agents.defaults.model') {
      if (!trimmed) {
        return {
          ok: false,
          restartRequired: false,
          code: 'invalid-value',
          error: 'agents.defaults.model must not be empty',
        };
      }
      encodedValue = JSON.stringify(trimmed);
    } else {
      if (!/^\d+$/.test(trimmed)) {
        return {
          ok: false,
          restartRequired: false,
          code: 'invalid-value',
          error: 'gateway.port must be an integer between 1 and 65535',
        };
      }
      const port = Number(trimmed);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        return {
          ok: false,
          restartRequired: false,
          code: 'invalid-value',
          error: 'gateway.port must be an integer between 1 and 65535',
        };
      }
      encodedValue = String(port);
    }
    if (this.mutationBusy) {
      return {
        ok: false,
        restartRequired: false,
        code: 'busy',
        error: MUTATION_BUSY_ERROR,
      };
    }
    this.mutationBusy = true;
    try {
      const { code, stderr, timedOut } = await this.execCli(
        ['config', 'set', key, encodedValue, '--strict-json'],
        this.cliTimeouts.config,
        'config',
      );
      if (code !== 0) {
        return {
          ok: false,
          restartRequired: false,
          code: timedOut ? 'timeout' : 'cli-failed',
          error: stderr || 'config set failed',
        };
      }
      if (key === 'gateway.port' && !this.endpointLockedByEnv) this.pendingPort = Number(encodedValue);
    // M0 ①: every successful `config set` requires a gateway restart to apply
    // — there is no live-reload path.
      return { ok: true, restartRequired: true };
    } finally {
      this.mutationBusy = false;
    }
  }

  // ── Chat token/URL ────────────────────────────────────────────────────

  async getChatToken(): Promise<string | null> {
    if (this.endpointUnavailableReason) return null;
    await this.ensureEndpointInitialized();
    try {
      const configPath = await this.resolveConfigPath();
      const text = await this.readFileFn(configPath);
      const parsed = JSON.parse(text) as { gateway?: { auth?: { token?: unknown } } };
      const token = parsed.gateway?.auth?.token;
      return typeof token === 'string' && token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  async getChatUrl(): Promise<string | null> {
    const token = await this.getChatToken();
    if (!token) return null;
    return `${this.endpoint.origin}/#token=${encodeURIComponent(token)}`;
  }

  /**
   * env override -> default install path (fast, no CLI) -> `openclaw config
   * file` CLI (only for a non-default install location; ~9s per M0 ⑥, paid
   * at most once and memoized). The module list's own priority order is
   * env -> CLI -> default; this swaps the last two so the COMMON case (a
   * default-location install) never pays the CLI tax on a path that can run
   * as early as the drawer's first open — see the module doc.
   */
  private resolveConfigPath(): Promise<string> {
    if (this.configPathPromise) return this.configPathPromise;
    this.configPathPromise = this.doResolveConfigPath();
    return this.configPathPromise;
  }

  private async doResolveConfigPath(): Promise<string> {
    const envOverride = envGet(this.env, 'EZTERMINAL_OPENCLAW_CONFIG_PATH');
    if (envOverride) return envOverride;
    const defaultPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    try {
      await this.readFileFn(defaultPath);
      return defaultPath;
    } catch {
      const { code, stdout } = await this.execCli(
        ['config', 'file'],
        this.cliTimeouts.config,
        'config',
      );
      const resolved = stdout.trim();
      return code === 0 && resolved ? resolved : defaultPath;
    }
  }

  // ── Logs ──────────────────────────────────────────────────────────────

  subscribeLogs(listener: (line: OpenClawLogLine) => void): () => void {
    this.logListeners.add(listener);
    this.acquireRpc();
    if (!this.logBackfillDone) {
      listener({ time: new Date(this.now()).toISOString(), level: 'INFO', message: 'Connecting to OpenClaw logs…' });
    }
    this.ensureLogLoop();
    return () => {
      if (!this.logListeners.delete(listener)) return;
      if (this.logListeners.size === 0) {
        if (this.logTimer) {
          clearTimeout(this.logTimer);
          this.logTimer = null;
        }
        this.logCursor = undefined;
        this.logBackfillDone = false;
      }
      this.releaseRpc();
    };
  }

  private ensureLogLoop(): void {
    if (this.logTimer || this.logListeners.size === 0) return;
    const tick = (): void => {
      void this.logTick().finally(() => {
        if (this.logListeners.size > 0) this.logTimer = setTimeout(tick, LOG_POLL_INTERVAL_MS);
      });
    };
    this.logTimer = setTimeout(tick, 0);
  }

  private async logTick(): Promise<void> {
    // M5 (openclaw-stabilization reliability sweep): skip the RPC call
    // entirely while the gateway isn't known-running — `wasRunning` (the M1
    // debounce flag, updated by every `probeStatus()`) is the same signal
    // status polling already trusts. Without this, an unconditional
    // `withRpc` call here re-triggers `OpenClawRpcConnection.connect()` on
    // EVERY tick once a failed attempt nulls its `connectPromise` — that
    // bypasses `scheduleReconnect`'s own exponential-backoff timer entirely
    // (a SEPARATE, correctly-capped mechanism owned by the persistent
    // connection itself), producing an effective 2s reconnect-attempt storm
    // while stopped. The timer keeps ticking either way (cheap no-op) —
    // this only stops it from touching the network.
    //
    // Invariant this relies on: a concurrent status subscription keeps
    // `wasRunning` fresh (every current surface guarantees one — the desktop
    // drawer arms status alongside logs; mobile's view subscribes status for
    // its whole lifetime). A logs-only surface would silently get no lines,
    // or reintroduce the reconnect storm described above.
    if (!this.wasRunning) return;
    const params = this.logCursor === undefined ? { limit: LOG_BACKFILL_LIMIT } : { cursor: this.logCursor, limit: LOG_POLL_LIMIT };
    const result = await this.withRpc((rpc) => rpc.call('logs.tail', params));
    if (!result || typeof result !== 'object') return;
    const { cursor, lines, reset } = result as { cursor?: number; lines?: unknown; reset?: boolean };
    this.logBackfillDone = true;
    if (typeof cursor === 'number') this.logCursor = reset ? 0 : cursor;
    if (!Array.isArray(lines)) return;
    for (const raw of lines) {
      if (typeof raw !== 'string') continue;
      const line = parseLogLine(raw, this.now);
      for (const listener of this.logListeners) listener(line);
    }
  }

  // ── RPC connection lifecycle ──────────────────────────────────────────

  private acquireRpc(): void {
    if (this.endpointUnavailableReason) return;
    if (!this.rpc) this.rpc = new OpenClawRpcConnection(this.wsFactory, this.endpoint.wsUrl, () => this.getChatToken());
    this.rpcRefCount += 1;
    this.rpc.enablePersistent();
  }

  private releaseRpc(): void {
    this.rpcRefCount = Math.max(0, this.rpcRefCount - 1);
    if (this.rpcRefCount === 0 && this.rpc) {
      this.rpc.close();
      this.rpc = null;
    }
  }

  /** Reuses the persistent connection if one is live (subscriber-driven);
   * otherwise opens a throwaway one for this call and closes it after.
   * Returns `undefined` on any failure — enrichment is always best-effort. */
  private async withRpc(fn: (rpc: OpenClawRpcConnection) => Promise<unknown>): Promise<unknown> {
    if (this.endpointUnavailableReason) return undefined;
    const owned = this.rpc !== null;
    const rpc = this.rpc ?? new OpenClawRpcConnection(this.wsFactory, this.endpoint.wsUrl, () => this.getChatToken());
    try {
      await rpc.connect();
      return await fn(rpc);
    } catch {
      return undefined;
    } finally {
      if (!owned) rpc.close();
    }
  }

  // ── CLI spawn ─────────────────────────────────────────────────────────

  private async execCli(
    args: readonly string[],
    timeoutMs: number,
    commandLabel: 'config' | 'lifecycle' | 'autostart',
  ): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    const cliName = envGet(this.env, 'EZTERMINAL_OPENCLAW_CLI') ?? 'openclaw';
    const resolver = new CommandResolver(this.env);
    const spec = resolver.resolve(cliName, args);
    if (!spec) return { code: -1, stdout: '', stderr: `${cliName}: command not found`, timedOut: false };
    return new Promise((resolve) => {
      let child: ChildProcessLike;
      try {
        child = this.spawnFn(spec.file, spec.args, { shell: spec.shell, windowsHide: true });
      } catch (error) {
        resolve({ code: -1, stdout: '', stderr: String(error), timedOut: false });
        return;
      }
      let settled = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const append = (chunks: Buffer[], used: number, chunk: Buffer): number => {
        const remaining = CLI_OUTPUT_LIMIT_BYTES - used;
        if (remaining <= 0) return used;
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        return used + kept.length;
      };
      const finish = (code: number, timedOut: boolean, overrideError?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const capturedStderr = Buffer.concat(stderrChunks).toString('utf8');
        resolve({ code, stdout, stderr: overrideError ?? capturedStderr, timedOut });
      };
      const timer = setTimeout(() => {
        this.killProcess(child);
        finish(-1, true, `OpenClaw ${commandLabel} command timed out`);
      }, Math.max(1, timeoutMs));
      timer.unref?.();
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes = append(stdoutChunks, stdoutBytes, chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes = append(stderrChunks, stderrBytes, chunk);
      });
      child.on('error', (err) => finish(-1, false, Buffer.concat(stderrChunks).toString('utf8') || String(err)));
      child.on('close', (code) => finish(code ?? -1, false));
    });
  }

  async getInsecureAuthStatus(): Promise<OpenClawInsecureAuthStatus> {
    if (this.endpointUnavailableReason) return 'error';
    try {
      const configPath = await this.resolveConfigPath();
      const text = await this.readFileFn(configPath);
      const parsed = JSON.parse(text) as { gateway?: { controlUi?: { allowInsecureAuth?: unknown } } };
      const value = parsed.gateway?.controlUi?.allowInsecureAuth;
      if (value === true) return 'enabled';
      if (value === false) return 'disabled';
      return 'unset';
    } catch {
      return 'error';
    }
  }

  // ── Disposal ──────────────────────────────────────────────────────────

  /** Idempotent. NEVER touches the gateway itself — no lifecycle CLI call here. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.logTimer) {
      clearTimeout(this.logTimer);
      this.logTimer = null;
    }
    this.statusListeners.clear();
    this.logListeners.clear();
    this.endpointListeners.clear();
    this.rpcRefCount = 0;
    this.rpc?.close();
    this.rpc = null;
  }
}

function toAgentSession(raw: unknown): OpenClawAgentSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string' || typeof r.sessionId !== 'string') return null;
  return {
    key: r.key,
    sessionId: r.sessionId,
    status: typeof r.status === 'string' ? r.status : undefined,
    model: typeof r.model === 'string' ? r.model : undefined,
    modelProvider: typeof r.modelProvider === 'string' ? r.modelProvider : undefined,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : undefined,
    hasActiveRun: typeof r.hasActiveRun === 'boolean' ? r.hasActiveRun : undefined,
    lastChannel: typeof r.lastChannel === 'string' ? r.lastChannel : undefined,
    estimatedCostUsd: typeof r.estimatedCostUsd === 'number' ? r.estimatedCostUsd : undefined,
    totalTokens: typeof r.totalTokens === 'number' ? r.totalTokens : undefined,
  };
}
