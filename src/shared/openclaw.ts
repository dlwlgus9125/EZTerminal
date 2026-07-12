/**
 * Shared OpenClaw management types (openclaw-management M1) — main ↔ preload ↔
 * renderer contract for the drawer (M2), mobile parity (M4/M5), and the chat
 * panel (M3). `OpenClawService` (src/main/openclaw-service.ts) is the sole
 * producer; everything here is a plain data shape, no behavior.
 */

/**
 * `not-installed`: the `openclaw` CLI doesn't resolve on PATH.
 * `stopped`/`running`: HTTP liveness probe against the gateway's own port.
 * `starting`: a `runLifecycle('start'|'restart')` call is in flight.
 * `unknown`: the probe itself failed in an unexpected way (not a clean
 * connection-refused) — distinct from `stopped` so the UI doesn't claim
 * certainty it doesn't have.
 */
export type OpenClawStatusState = 'not-installed' | 'stopped' | 'starting' | 'running' | 'unknown';

export interface OpenClawStatus {
  readonly state: OpenClawStatusState;
  /** From the WS `status` RPC's `runtimeVersion` — only present while `running`. */
  readonly version?: string;
  /** Not obtainable from the fast HTTP/WS path (only `gateway status --json
   * --no-probe`, a 9-10s CLI call per M0 ⑥) — left undefined on the hot path. */
  readonly pid?: number;
  readonly port: number;
  readonly configPath?: string;
}

/** A subset of `sessions.list`'s per-session fields (WS RPC, M0 ④) — the raw
 * payload carries far more (thinking levels, delivery context, ...); this is
 * what the drawer/mobile session list actually renders. */
export interface OpenClawAgentSession {
  readonly key: string;
  readonly sessionId: string;
  readonly status?: string;
  readonly model?: string;
  readonly modelProvider?: string;
  readonly updatedAt?: number;
  readonly hasActiveRun?: boolean;
  readonly lastChannel?: string;
  readonly estimatedCostUsd?: number;
  readonly totalTokens?: number;
}

export interface OpenClawLogLine {
  readonly time: string;
  readonly level: string;
  readonly message: string;
}

export type OpenClawLifecycleAction = 'start' | 'stop' | 'restart';

export interface OpenClawLifecycleResult {
  readonly ok: boolean;
  readonly stderr?: string;
}

/** M0 ①: `config set` always requires a gateway restart to take effect
 * ("Updated <path>. Restart the gateway to apply.") — never a live reload. */
export interface OpenClawSetConfigResult {
  readonly ok: boolean;
  readonly restartRequired: boolean;
  readonly error?: string;
}

/** Core settings surfaced natively (plan §설정 범위) — everything else (channel
 * connections, etc.) stays inside the Control UI embed (M3). */
export const OPENCLAW_CONFIG_ALLOWLIST = ['agents.defaults.model', 'gateway.port'] as const;
export type OpenClawConfigKey = (typeof OPENCLAW_CONFIG_ALLOWLIST)[number];

/** Sentinel for "present in the allowlist but absent from openclaw.json" — M0
 * ①: `config get` exits 1 for an unset-but-schema-valid path (e.g. `gateway.port`
 * is normally resolved from the scheduled task's `--port` arg, not the config
 * file). This is the unset SIGNAL, not an error. */
export const OPENCLAW_CONFIG_UNSET = 'unset' as const;

export type OpenClawCoreConfig = Record<OpenClawConfigKey, string>;
