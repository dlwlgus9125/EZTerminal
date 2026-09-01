/**
 * Shared OpenClaw management types (openclaw-management M1) — main ↔ preload ↔
 * renderer contract for the drawer (M2), mobile parity (M4/M5), and the chat
 * panel (M3). `OpenClawService` (src/main/openclaw-service.ts) is the sole
 * producer; everything here is a plain data shape, no behavior.
 */
import type { OpenClawMode } from './layout-schema';

/**
 * `not-installed`: the `openclaw` CLI doesn't resolve on PATH.
 * `stopped`/`running`: HTTP liveness probe against the gateway's own port.
 * A `running` observation is held through up to 2 transient probe timeouts
 * (M1 status debounce) before flipping to `stopped` — a connection-refused
 * failure is treated as definitive and reported immediately instead.
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
  readonly port: number;
}

export interface OpenClawEndpoint {
  readonly origin: string;
  readonly wsUrl: string;
  readonly port: number;
  readonly generation: number;
  readonly source: 'environment' | 'config' | 'default';
}

export type OpenClawInsecureAuthStatus = 'enabled' | 'disabled' | 'unset' | 'error';

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

export type OpenClawOperationErrorCode =
  | 'busy'
  | 'timeout'
  | 'invalid-value'
  | 'cli-failed'
  | 'unhealthy'
  | 'unavailable';

export interface OpenClawLifecycleResult {
  readonly ok: boolean;
  readonly code?: OpenClawOperationErrorCode;
  readonly stderr?: string;
}

/** `gateway install`/`gateway uninstall` (task #9, autostart toggle) — distinct
 * from `OpenClawLifecycleAction` because these register/remove the OS service
 * (launchd/systemd/schtasks) rather than start/stop the running process, but
 * share the same serialized CLI lane in OpenClawService (never races against
 * a start/stop/restart). `--help` confirmed (2026-07-12) neither subcommand
 * needs a confirmation flag to run non-interactively. */
export type OpenClawAutostartAction = 'install' | 'uninstall';

export interface OpenClawAutostartResult {
  readonly ok: boolean;
  readonly code?: OpenClawOperationErrorCode;
  readonly stderr?: string;
}

/** M0 ①: `config set` always requires a gateway restart to take effect
 * ("Updated <path>. Restart the gateway to apply.") — never a live reload. */
export interface OpenClawSetConfigResult {
  readonly ok: boolean;
  readonly restartRequired: boolean;
  readonly code?: OpenClawOperationErrorCode;
  readonly error?: string;
}

/** Core settings surfaced natively (plan §설정 범위) — everything else (channel
 * connections, etc.) stays inside the Control UI embed (M3). */
export const OPENCLAW_CONFIG_ALLOWLIST = ['agents.defaults.model', 'gateway.port'] as const;
export type OpenClawConfigKey = (typeof OPENCLAW_CONFIG_ALLOWLIST)[number];

/** Wire shape for the chat placeholder's reported bounding rect
 * (openclaw-management M3) — window-content-relative pixels, the same
 * coordinate space `WebContentsView.setBounds` expects. */
export interface OpenClawChatBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Durable lifecycle intent accepted by the EZTerminal supervisor.  Acceptance
 * means the intent is persisted and will continue after the requesting UI (or
 * the whole Electron app) closes; completion is reported by
 * `OpenClawControlSnapshot`, not by keeping this request open. */
export interface OpenClawLifecycleReceipt {
  readonly accepted: boolean;
  readonly intentId?: string;
  readonly generation?: number;
  readonly coalesced?: boolean;
  readonly issue?: OpenClawControlIssue;
}

export type OpenClawDesiredState = 'running' | 'stopped';

export type OpenClawSupervisorState =
  | 'unregistered'
  | 'installing'
  | 'ready'
  | 'error';

export type OpenClawOperationPhase =
  | 'idle'
  | 'starting'
  | 'restarting'
  | 'stopping'
  | 'diagnosing'
  | 'backing-up'
  | 'repairing'
  | 'verifying'
  | 'blocked';

export type OpenClawControlIssueCode =
  | 'cli-missing'
  | 'cli-incompatible'
  | 'backup-failed'
  | 'permission-denied'
  | 'port-conflict'
  | 'watchdog-conflict'
  | 'unsafe-repair-required'
  | 'repair-exhausted'
  | 'supervisor-failed'
  | 'gateway-unhealthy';

export interface OpenClawControlIssue {
  readonly code: OpenClawControlIssueCode;
  readonly detail: string;
  readonly remediation: string;
  readonly diagnosticId: string;
}

export interface OpenClawControlOperation {
  readonly intentId: string;
  readonly generation: number;
  readonly action: OpenClawLifecycleAction;
  readonly phase: OpenClawOperationPhase;
  readonly attempt: number;
  readonly maxAttempts: 3;
  readonly requestedAt: string;
}

/** Truthful control-plane snapshot shared by desktop and mobile.  `status`
 * remains the physical gateway observation; `desiredState` and `operation`
 * explain what the persistent supervisor is trying to make true. */
export interface OpenClawControlSnapshot {
  readonly schemaVersion: 1;
  /** Latest lifecycle intent this runtime snapshot has fully observed. */
  readonly intentId: string | null;
  readonly generation: number;
  readonly status: OpenClawStatus;
  readonly desiredState: OpenClawDesiredState;
  readonly supervisorState: OpenClawSupervisorState;
  readonly operation: OpenClawControlOperation | null;
  readonly issue: OpenClawControlIssue | null;
  readonly updatedAt: string;
}

export interface OpenClawChatSurfaceSnapshot {
  readonly surfaceId: 'openclaw-chat';
  /** New for each renderer JavaScript realm; revisions are local to it. */
  readonly instanceId: string;
  readonly revision: number;
  readonly mounted: boolean;
  /** `main` or Dockview's opaque auxiliary `window.name`. */
  readonly windowName: string;
  readonly bounds: OpenClawChatBounds;
  readonly visible: boolean;
}

function isFiniteBound(value: unknown, allowNegative: boolean): value is number {
  return Number.isInteger(value)
    && Number.isFinite(value)
    && (allowNegative ? (value as number) >= -32_768 : (value as number) >= 0)
    && (value as number) <= 32_768;
}

export function isOpenClawChatSurfaceSnapshot(
  value: unknown,
): value is OpenClawChatSurfaceSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<OpenClawChatSurfaceSnapshot>;
  const bounds = candidate.bounds;
  return candidate.surfaceId === 'openclaw-chat'
    && typeof candidate.instanceId === 'string'
    && /^[0-9a-f-]{36}$/iu.test(candidate.instanceId)
    && Number.isSafeInteger(candidate.revision)
    && (candidate.revision ?? 0) > 0
    && typeof candidate.mounted === 'boolean'
    && typeof candidate.visible === 'boolean'
    && typeof candidate.windowName === 'string'
    && candidate.windowName.length > 0
    && candidate.windowName.length <= 256
    && typeof bounds === 'object'
    && bounds !== null
    && isFiniteBound(bounds.x, true)
    && isFiniteBound(bounds.y, true)
    && isFiniteBound(bounds.width, false)
    && isFiniteBound(bounds.height, false)
    && (candidate.mounted || (!candidate.visible && bounds.width === 0 && bounds.height === 0));
}

/** Pushed by `OpenClawChatViewManager` on did-start-loading/did-fail-load/
 * did-finish-load — see openclaw-chat-view.ts's module doc for why the view
 * force-hides itself while `hasError` is true. `loading` (openclaw-
 * stabilization M6) is true from did-start-loading until the load settles
 * (did-finish-load or did-fail-load) — the placeholder shows a "불러오는
 * 중" line while it's true and the gateway is running, since the native
 * view paints nothing (and nothing else in the placeholder) during that
 * window. */
export interface OpenClawChatViewState {
  readonly hasError: boolean;
  readonly errorCode?: number;
  readonly loading: boolean;
}

/** Sentinel for "present in the allowlist but absent from openclaw.json" — M0
 * ①: `config get` exits 1 for an unset-but-schema-valid path (e.g. `gateway.port`
 * is normally resolved from the scheduled task's `--port` arg, not the config
 * file). This is the unset SIGNAL, not an error. */
export const OPENCLAW_CONFIG_UNSET = 'unset' as const;

export type OpenClawCoreConfig = Record<OpenClawConfigKey, string>;

/** Desktop OpenClaw visibility (openclaw-stabilization M2) — `mode` is the
 * persisted tri-state setting (LayoutStore.getOpenClawMode); `visible` is the
 * resolved effective visibility ('auto' resolves through
 * OpenClawService.isInstalled()). Returned by the one-shot `openclaw:get-
 * visibility` IPC call and pushed on every `settings:set-openclaw-mode` call
 * via `openclaw:visibility-changed`. */
export interface OpenClawVisibility {
  readonly mode: OpenClawMode;
  readonly visible: boolean;
}
