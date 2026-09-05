/**
 * Durable OpenClaw lifecycle control plane.
 *
 * Renderer/mobile requests end at `requestLifecycle`: the requested intent is
 * atomically persisted and the per-user Windows supervisor is woken.  The
 * supervisor is the sole long-running mutation engine and writes runtime.json;
 * this coordinator only merges that runtime with the latest physical status
 * for UI/remote observers.
 */
import { promises as fs } from 'node:fs';
import { randomUUID as createRandomUUID } from 'node:crypto';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

import { CommandResolver, envGet, type EnvLike } from '../interpreter/external/command-resolver';
import type {
  OpenClawControlIssue,
  OpenClawControlIssueCode,
  OpenClawControlSnapshot,
  OpenClawDesiredState,
  OpenClawLifecycleAction,
  OpenClawLifecycleReceipt,
  OpenClawStatus,
} from '../shared/openclaw';
import { JsonFile } from './json-file';

export const OPENCLAW_SUPERVISOR_TASK_NAME = 'EZTerminal OpenClaw Supervisor';
const CONTROL_SCHEMA_VERSION = 1 as const;
const CONTROL_POLL_MS = 1000;

interface OpenClawIntentRecord {
  readonly schemaVersion: 1;
  readonly intentId: string;
  readonly generation: number;
  readonly desiredState: OpenClawDesiredState;
  readonly action: OpenClawLifecycleAction;
  readonly requestedAt: string;
}

export interface OpenClawSupervisorInstallResult {
  readonly ok: boolean;
  readonly issue?: OpenClawControlIssue;
}

export interface OpenClawSupervisorAdapter {
  ensureInstalled(): Promise<OpenClawSupervisorInstallResult>;
  wake(): Promise<OpenClawSupervisorInstallResult>;
}

export interface OpenClawLifecycleCoordinatorDeps {
  readonly userDataDirectory: string;
  readonly supervisorAssetPath: string;
  readonly getPhysicalStatus: (force?: boolean) => Promise<OpenClawStatus>;
  readonly env?: EnvLike;
  readonly supervisor?: OpenClawSupervisorAdapter;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
  readonly pollMs?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is OpenClawLifecycleAction {
  return value === 'start' || value === 'stop' || value === 'restart';
}

function validateIntent(value: unknown): OpenClawIntentRecord | null {
  if (!isObject(value)) return null;
  if (
    value.schemaVersion !== CONTROL_SCHEMA_VERSION
    || typeof value.intentId !== 'string'
    || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 1
    || (value.desiredState !== 'running' && value.desiredState !== 'stopped')
    || !isAction(value.action)
    || typeof value.requestedAt !== 'string'
  ) return null;
  return value as unknown as OpenClawIntentRecord;
}

function isStatus(value: unknown): value is OpenClawStatus {
  if (!isObject(value)) return false;
  return (
    (value.state === 'not-installed'
      || value.state === 'stopped'
      || value.state === 'starting'
      || value.state === 'running'
      || value.state === 'unknown')
    && Number.isSafeInteger(value.port)
    && (value.port as number) >= 1
    && (value.port as number) <= 65_535
    && (value.version === undefined || typeof value.version === 'string')
  );
}

const ISSUE_CODES = new Set<OpenClawControlIssueCode>([
  'cli-missing',
  'cli-incompatible',
  'backup-failed',
  'permission-denied',
  'port-conflict',
  'watchdog-conflict',
  'unsafe-repair-required',
  'repair-exhausted',
  'supervisor-failed',
  'gateway-unhealthy',
]);

function isIssue(value: unknown): value is OpenClawControlIssue {
  if (!isObject(value)) return false;
  return ISSUE_CODES.has(value.code as OpenClawControlIssueCode)
    && typeof value.detail === 'string'
    && typeof value.remediation === 'string'
    && typeof value.diagnosticId === 'string';
}

function validateSnapshot(value: unknown): OpenClawControlSnapshot | null {
  if (!isObject(value) || value.schemaVersion !== CONTROL_SCHEMA_VERSION || !isStatus(value.status)) return null;
  if (
    (value.intentId !== null && typeof value.intentId !== 'string')
    || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 0
    || (value.desiredState !== 'running' && value.desiredState !== 'stopped')
    || (value.supervisorState !== 'unregistered'
      && value.supervisorState !== 'installing'
      && value.supervisorState !== 'ready'
      && value.supervisorState !== 'error')
    || (value.issue !== null && !isIssue(value.issue))
    || typeof value.updatedAt !== 'string'
  ) return null;
  if (value.operation !== null) {
    if (!isObject(value.operation)) return null;
    if (
      typeof value.operation.intentId !== 'string'
      || !Number.isSafeInteger(value.operation.generation)
      || !isAction(value.operation.action)
      || !['idle', 'starting', 'restarting', 'stopping', 'diagnosing', 'backing-up', 'repairing', 'verifying', 'blocked']
        .includes(String(value.operation.phase))
      || !Number.isInteger(value.operation.attempt)
      || value.operation.maxAttempts !== 3
      || typeof value.operation.requestedAt !== 'string'
    ) return null;
  }
  return value as unknown as OpenClawControlSnapshot;
}

function desiredStateFor(action: OpenClawLifecycleAction): OpenClawDesiredState {
  return action === 'stop' ? 'stopped' : 'running';
}

function phaseFor(action: OpenClawLifecycleAction): 'starting' | 'restarting' | 'stopping' {
  return action === 'start' ? 'starting' : action === 'restart' ? 'restarting' : 'stopping';
}

function defaultSnapshot(status: OpenClawStatus, now: Date): OpenClawControlSnapshot {
  return {
    schemaVersion: CONTROL_SCHEMA_VERSION,
    intentId: null,
    generation: 0,
    status,
    desiredState: 'stopped',
    supervisorState: 'unregistered',
    operation: null,
    issue: null,
    updatedAt: now.toISOString(),
  };
}

function bootstrapIssue(code: OpenClawControlIssueCode, detail: string, remediation: string): OpenClawControlIssue {
  return {
    code,
    detail,
    remediation,
    diagnosticId: `bootstrap-${Date.now().toString(36)}`,
  };
}

interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runProcess(file: string, args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof crossSpawn>;
    try {
      child = crossSpawn(file, [...args], { windowsHide: true, shell: false });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error) });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Process may have exited between the timer and kill.
      }
      finish(-1);
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (error) => {
      stderr.push(Buffer.from(String(error)));
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });
}

/** Real Windows adapter.  All arguments are fixed or resolved local paths;
 * user-provided config values never enter the PowerShell command line. */
export class PowerShellOpenClawSupervisor implements OpenClawSupervisorAdapter {
  private readonly stateDirectory: string;
  private readonly installedScriptPath: string;
  private readonly env: EnvLike;
  private installed = false;
  private installPromise: Promise<OpenClawSupervisorInstallResult> | null = null;

  constructor(
    private readonly assetPath: string,
    userDataDirectory: string,
    env: EnvLike = process.env as EnvLike,
  ) {
    this.stateDirectory = path.join(userDataDirectory, 'openclaw-control');
    this.installedScriptPath = path.join(this.stateDirectory, 'openclaw-supervisor.ps1');
    this.env = env;
  }

  private resolveCli(): string | null {
    const cliName = envGet(this.env, 'EZTERMINAL_OPENCLAW_CLI') ?? 'openclaw';
    return new CommandResolver(this.env).resolve(cliName, [])?.file ?? null;
  }

  private async installAsset(): Promise<void> {
    await fs.mkdir(this.stateDirectory, { recursive: true });
    const source = await fs.readFile(this.assetPath);
    let current: Buffer | null = null;
    try {
      current = await fs.readFile(this.installedScriptPath);
    } catch {
      current = null;
    }
    if (!current?.equals(source)) {
      const temporary = `${this.installedScriptPath}.tmp`;
      await fs.writeFile(temporary, source);
      await fs.rename(temporary, this.installedScriptPath).catch(async () => {
        await fs.rm(this.installedScriptPath, { force: true });
        await fs.rename(temporary, this.installedScriptPath);
      });
    }
  }

  private parseResult(result: ProcessResult): OpenClawSupervisorInstallResult {
    const line = result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
    if (line) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isObject(parsed) && parsed.ok === true) return { ok: true };
        if (isObject(parsed) && parsed.ok === false && isIssue(parsed.issue)) {
          return { ok: false, issue: parsed.issue };
        }
      } catch {
        // Fall through to a bounded generic issue; raw process output can hold paths.
      }
    }
    return {
      ok: false,
      issue: bootstrapIssue(
        result.code === 5 ? 'permission-denied' : 'supervisor-failed',
        'The OpenClaw supervisor could not be registered.',
        'Restart EZTerminal under the same Windows user and try Start again.',
      ),
    };
  }

  async ensureInstalled(): Promise<OpenClawSupervisorInstallResult> {
    if (this.installed) return { ok: true };
    if (this.installPromise) return this.installPromise;
    this.installPromise = this.install().finally(() => {
      this.installPromise = null;
    });
    const result = await this.installPromise;
    if (result.ok) this.installed = true;
    return result;
  }

  private async install(): Promise<OpenClawSupervisorInstallResult> {
    if (process.platform !== 'win32') {
      return {
        ok: false,
        issue: bootstrapIssue(
          'supervisor-failed',
          'Persistent OpenClaw supervision is currently supported on Windows only.',
          'Use EZTerminal on Windows for persistent lifecycle control.',
        ),
      };
    }
    const cliPath = this.resolveCli();
    if (!cliPath) {
      return {
        ok: false,
        issue: bootstrapIssue(
          'cli-missing',
          'The OpenClaw CLI is not installed or cannot be resolved.',
          'Install a compatible OpenClaw CLI, then press Start again.',
        ),
      };
    }
    const repair = await runProcess('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.assetPath,
      '-RepairStateAcl',
      '-StateDirectory',
      this.stateDirectory,
      '-CliPath',
      cliPath,
    ], 30_000);
    const repairResult = this.parseResult(repair);
    if (!repairResult.ok) return repairResult;
    try {
      await this.installAsset();
    } catch {
      return {
        ok: false,
        issue: bootstrapIssue(
          'permission-denied',
          'EZTerminal could not install the current-user OpenClaw supervisor files.',
          'Check access to the EZTerminal user-data directory and try again.',
        ),
      };
    }
    const result = await runProcess('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      this.installedScriptPath,
      '-InstallTask',
      '-StateDirectory',
      this.stateDirectory,
      '-CliPath',
      cliPath,
    ], 30_000);
    return this.parseResult(result);
  }

  async wake(): Promise<OpenClawSupervisorInstallResult> {
    const result = await runProcess('schtasks.exe', ['/Run', '/TN', OPENCLAW_SUPERVISOR_TASK_NAME], 15_000);
    if (result.code === 0) return { ok: true };
    return {
      ok: false,
      issue: bootstrapIssue(
        result.code === 5 ? 'permission-denied' : 'supervisor-failed',
        'The OpenClaw supervisor task could not be started.',
        'Open EZTerminal under the same Windows user and press Start again.',
      ),
    };
  }
}

export class OpenClawLifecycleCoordinator {
  private readonly controlDirectory: string;
  private readonly intentFile: JsonFile;
  private readonly runtimeFile: JsonFile;
  private readonly supervisor: OpenClawSupervisorAdapter;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;
  private readonly pollMs: number;
  private readonly getPhysicalStatus: (force?: boolean) => Promise<OpenClawStatus>;
  private initialized: Promise<void> | null = null;
  private requestChain: Promise<void> = Promise.resolve();
  private pendingIntent: OpenClawIntentRecord | null = null;
  private bootstrapControlIssue: OpenClawControlIssue | null = null;
  private physicalStatus: OpenClawStatus = { state: 'unknown', port: 18789 };
  private physicalStatusObservedAt = 0;
  private lastSnapshot: OpenClawControlSnapshot | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<(snapshot: OpenClawControlSnapshot) => void>();
  private bootstrapRecovery: Promise<void> | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(deps: OpenClawLifecycleCoordinatorDeps) {
    this.controlDirectory = path.join(deps.userDataDirectory, 'openclaw-control');
    this.intentFile = new JsonFile(this.controlDirectory, 'intent.json');
    this.runtimeFile = new JsonFile(this.controlDirectory, 'runtime.json');
    this.getPhysicalStatus = deps.getPhysicalStatus;
    this.now = deps.now ?? (() => new Date());
    this.randomUUID = deps.randomUUID ?? createRandomUUID;
    this.pollMs = Math.max(100, deps.pollMs ?? CONTROL_POLL_MS);
    this.supervisor = deps.supervisor ?? new PowerShellOpenClawSupervisor(
      deps.supervisorAssetPath,
      deps.userDataDirectory,
      deps.env,
    );
  }

  initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        // Start sequentially so a first-file failure cannot leave an unowned
        // sibling initializer writing after initialize() has rejected.
        await this.intentFile.init();
        await this.runtimeFile.init();
        try {
          this.physicalStatus = await this.getPhysicalStatus();
          this.physicalStatusObservedAt = this.now().getTime();
        } catch {
          this.physicalStatus = { state: 'unknown', port: 18789 };
        }
        const current = await this.readIntent();
        if (current && !this.disposed) {
          this.pendingIntent = current;
          this.bootstrapRecovery = this.recoverPendingIntent();
          void this.bootstrapRecovery.catch(() => undefined);
        }
        if (this.disposed) return;
        await this.refreshSnapshot();
        if (this.disposed) return;
        this.pollTimer = setInterval(() => {
          void this.refreshSnapshot();
        }, this.pollMs);
        this.pollTimer.unref?.();
      })();
    }
    return this.initialized;
  }

  private async readIntent(): Promise<OpenClawIntentRecord | null> {
    const raw = await this.intentFile.read();
    return raw === undefined ? null : validateIntent(raw);
  }

  private async readRuntime(): Promise<OpenClawControlSnapshot | null> {
    const raw = await this.runtimeFile.read();
    return raw === undefined ? null : validateSnapshot(raw);
  }

  private async recoverPendingIntent(): Promise<void> {
    const installed = await this.supervisor.ensureInstalled();
    // Installation may be a slow PowerShell operation. Once disposal closes
    // admission, a late completion must not wake the external supervisor.
    if (this.disposed) return;
    const result = installed.ok ? await this.supervisor.wake() : installed;
    if (this.disposed) return;
    if (!result.ok) this.bootstrapControlIssue = result.issue ?? null;
    await this.refreshSnapshot();
  }

  private mergeSnapshot(runtime: OpenClawControlSnapshot | null): OpenClawControlSnapshot {
    const now = this.now();
    const base = runtime ?? defaultSnapshot(this.physicalStatus, now);
    const runtimeUpdatedAt = runtime ? Date.parse(runtime.updatedAt) : Number.NaN;
    const status = runtime && Number.isFinite(runtimeUpdatedAt)
      && runtimeUpdatedAt > this.physicalStatusObservedAt
      ? runtime.status
      : this.physicalStatus;
    const pending = this.pendingIntent;
    if (pending && (!runtime || runtime.generation < pending.generation)) {
      return {
        schemaVersion: CONTROL_SCHEMA_VERSION,
        intentId: pending.intentId,
        generation: pending.generation,
        status,
        desiredState: pending.desiredState,
        supervisorState: this.bootstrapControlIssue ? 'error' : 'ready',
        operation: {
          intentId: pending.intentId,
          generation: pending.generation,
          action: pending.action,
          phase: phaseFor(pending.action),
          attempt: 0,
          maxAttempts: 3,
          requestedAt: pending.requestedAt,
        },
        issue: this.bootstrapControlIssue,
        updatedAt: pending.requestedAt,
      };
    }
    if (runtime && pending && runtime.generation >= pending.generation) {
      this.pendingIntent = null;
      if (runtime.supervisorState === 'ready') this.bootstrapControlIssue = null;
    }
    const merged = { ...base, status };
    return this.bootstrapControlIssue
      ? {
          ...merged,
          supervisorState: 'error',
          issue: this.bootstrapControlIssue,
        }
      : merged;
  }

  private emit(snapshot: OpenClawControlSnapshot): void {
    if (this.disposed) return;
    const serialized = JSON.stringify(snapshot);
    if (this.lastSnapshot && JSON.stringify(this.lastSnapshot) === serialized) return;
    this.lastSnapshot = snapshot;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('[OpenClawLifecycleCoordinator] listener failed:', error);
      }
    }
  }

  private async refreshSnapshot(): Promise<OpenClawControlSnapshot> {
    const snapshot = this.mergeSnapshot(await this.readRuntime());
    this.emit(snapshot);
    return snapshot;
  }

  updatePhysicalStatus(status: OpenClawStatus): void {
    this.physicalStatus = status;
    this.physicalStatusObservedAt = this.now().getTime();
    void this.refreshSnapshot();
  }

  async getSnapshot(force = false): Promise<OpenClawControlSnapshot> {
    await this.initialize();
    if (force) {
      try {
        this.physicalStatus = await this.getPhysicalStatus(true);
        this.physicalStatusObservedAt = this.now().getTime();
      } catch {
        this.physicalStatus = { ...this.physicalStatus, state: 'unknown' };
      }
    }
    return this.refreshSnapshot();
  }

  subscribe(listener: (snapshot: OpenClawControlSnapshot) => void): () => void {
    this.listeners.add(listener);
    if (this.lastSnapshot) {
      listener(this.lastSnapshot);
    } else {
      void this.getSnapshot().catch(() => undefined);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  requestLifecycle(action: OpenClawLifecycleAction): Promise<OpenClawLifecycleReceipt> {
    if (!isAction(action)) {
      return Promise.resolve({
        accepted: false,
        issue: bootstrapIssue(
          'supervisor-failed',
          'The requested OpenClaw lifecycle action is invalid.',
          'Retry with Start, Stop, or Restart.',
        ),
      });
    }
    let resolveRequest!: (value: OpenClawLifecycleReceipt) => void;
    const result = new Promise<OpenClawLifecycleReceipt>((resolve) => {
      resolveRequest = resolve;
    });
    const run = async (): Promise<void> => {
      await this.initialize();
      const [current, runtime] = await Promise.all([this.readIntent(), this.readRuntime()]);
      const desiredState = desiredStateFor(action);
      const activePending = current
        && this.pendingIntent?.generation === current.generation
        && this.pendingIntent.action === action;
      const activeSameAction = current
        && current.action === action
        && runtime?.operation !== null
        && runtime?.generation === current.generation
        && runtime.operation?.phase !== 'blocked';
      const terminalSameIntent = current
        && current.desiredState === desiredState
        && action !== 'restart'
        && runtime?.issue === null
        && ((desiredState === 'running' && runtime?.status.state === 'running')
          || (desiredState === 'stopped' && runtime?.status.state === 'stopped'));
      if (current && (activePending || activeSameAction || terminalSameIntent)) {
        resolveRequest({
          accepted: true,
          intentId: current.intentId,
          generation: current.generation,
          coalesced: true,
        });
        return;
      }

      const installed = await this.supervisor.ensureInstalled();
      if (!installed.ok) {
        resolveRequest({ accepted: false, issue: installed.issue });
        return;
      }
      this.bootstrapControlIssue = null;

      const next: OpenClawIntentRecord = {
        schemaVersion: CONTROL_SCHEMA_VERSION,
        intentId: this.randomUUID(),
        generation: (current?.generation ?? 0) + 1,
        desiredState,
        action,
        requestedAt: this.now().toISOString(),
      };
      await this.intentFile.enqueue(() => this.intentFile.writeAtomic(JSON.stringify(next)));
      this.pendingIntent = next;
      await this.refreshSnapshot();

      const wake = await this.supervisor.wake();
      if (!wake.ok) {
        this.bootstrapControlIssue = wake.issue ?? null;
        await this.refreshSnapshot();
        resolveRequest({
          accepted: true,
          intentId: next.intentId,
          generation: next.generation,
          coalesced: false,
          issue: wake.issue,
        });
        return;
      }
      resolveRequest({
        accepted: true,
        intentId: next.intentId,
        generation: next.generation,
        coalesced: false,
      });
    };
    const queued = this.requestChain.then(run);
    this.requestChain = queued.then(() => undefined, () => undefined);
    void queued.catch(() => {
      resolveRequest({
        accepted: false,
        issue: bootstrapIssue(
          'supervisor-failed',
          'EZTerminal could not persist the OpenClaw lifecycle intent.',
          'Check user-data permissions and press the requested action again.',
        ),
      });
    });
    return result;
  }

  async dispose(): Promise<void> {
    if (!this.disposePromise) {
      // Close recovery publication synchronously before awaiting its exact
      // admitted prefix. This keeps initialize() fast while making shutdown
      // own a pending supervisor installation attempt.
      this.disposed = true;
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.listeners.clear();
      this.disposePromise = (async () => {
        await this.initialized?.catch(() => undefined);
        await this.bootstrapRecovery?.catch(() => undefined);
        await Promise.all([this.intentFile.flush(), this.runtimeFile.flush()]);
      })();
    }
    return this.disposePromise;
  }
}
