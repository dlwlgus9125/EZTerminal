import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

import {
  AGENT_CLI_PACKAGES,
  type AgentCliBlocker, type AgentCliLocation, type AgentCliProviderId, type AgentCliStatus, type AgentCliUpdateResult,
} from '../shared/agent-cli';
import { createDaemonCommand, type DaemonCommand, type DaemonCommandReceipt, type DaemonProvider, type DaemonSnapshot } from '../shared/daemon-protocol';
import type { ProviderInspection, ProviderRegistryResult } from '../shared/daemon-provider';
import { daemonProviderMatchesProbe } from '../shared/provider-review';
import { compareSemanticVersions, semanticVersion } from './provider-version';
import { providerActiveAgents } from './daemon-agent-runtime';
import { sanitizeProviderDiagnostic } from './provider-process-security';

/** Output of one npm run; never shown raw (it can carry registry tokens). */
export interface NpmResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string }

export interface NpmRunner {
  /** Absolute path of the npm on PATH, or `undefined` when there is none. */
  locate(): Promise<string | undefined>;
  run(npm: string, argv: readonly string[], timeoutMs: number): Promise<NpmResult>;
}

export interface AgentCliUpdateServiceOptions {
  readonly inspect: (providerId: AgentCliProviderId) => Promise<ProviderRegistryResult<ProviderInspection>>;
  readonly getSnapshot: () => DaemonSnapshot;
  readonly sendCommand: (command: DaemonCommand) => Promise<DaemonCommandReceipt>;
  /** Releases every copy of the program the app holds (idle conversations, the Codex app-server). */
  readonly deactivate: (providerId: AgentCliProviderId) => Promise<void>;
  /** Terminal tabs running the program now. */
  readonly terminalRuns: () => readonly { readonly provider: string; readonly live: boolean; readonly cwd: string }[];
  /** Runs after queued extension changes and holds new ones off until it ends. */
  readonly exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly npm: NpmRunner;
  /** True when Windows reports the file as in use (it cannot be replaced). */
  readonly fileInUse: (file: string) => Promise<boolean>;
  readonly exists: (file: string) => Promise<boolean>;
  /** `env` block of `~/.claude/settings.json`; empty when unreadable. */
  readonly claudeSettingsEnvironment: () => Promise<Readonly<Record<string, unknown>>>;
  readonly environment: NodeJS.ProcessEnv;
  readonly compatible: (providerId: AgentCliProviderId, version: string) => boolean;
  readonly onChanged?: (providerId: AgentCliProviderId) => void;
  readonly now?: () => Date;
}

const LATEST_TTL_MS = 10 * 60_000;
const NPM_QUERY_TIMEOUT_MS = 30_000;
const NPM_INSTALL_TIMEOUT_MS = 5 * 60_000;
const UNAVAILABLE_VERSIONS = new Set(['unknown', 'unavailable']);

interface NpmInstall {
  /** The global npm prefix the program was installed into. */
  readonly prefix: string;
  /** The native executable a running copy holds open. */
  readonly executable: string;
}

const sameFolder = (left: string, right: string): boolean => (
  process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right)
);

/** Where a global npm install of the program lives, from the executable the app reviewed. */
export async function npmInstall(providerId: AgentCliProviderId, executablePath: string, exists: (file: string) => Promise<boolean>): Promise<NpmInstall | undefined> {
  if (!path.isAbsolute(executablePath)) return undefined;
  if (providerId === 'claude') {
    const match = /^(.*)[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]bin[\\/]claude(?:\.exe)?$/iu.exec(executablePath);
    if (!match?.[1]) return undefined;
    const prefix = match[1];
    return await exists(path.join(prefix, process.platform === 'win32' ? 'claude.cmd' : 'claude')) ? { prefix, executable: executablePath } : undefined;
  }
  let prefix: string | undefined;
  if (/^codex(?:\.cmd)?$/iu.test(path.basename(executablePath))) prefix = path.dirname(executablePath);
  else prefix = /^(.*)[\\/]node_modules[\\/]@openai[\\/]codex[\\/]/iu.exec(executablePath)?.[1];
  if (!prefix || !await exists(path.join(prefix, 'node_modules', '@openai', 'codex', 'package.json'))) return undefined;
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const executable = process.platform === 'win32'
    ? path.join(prefix, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${process.arch}`, 'vendor', `${arch}-pc-windows-msvc`, 'bin', 'codex.exe')
    : executablePath;
  return { prefix, executable };
}

function installedVersion(inspection: ProviderRegistryResult<ProviderInspection>): string | null {
  if (!inspection.ok) return null;
  const { probe } = inspection.value;
  if (UNAVAILABLE_VERSIONS.has(probe.executableVersion) || !path.isAbsolute(probe.executablePath)) return null;
  return semanticVersion(probe.executableVersion) ? probe.executableVersion : null;
}

function newer(candidate: string, current: string): boolean {
  const next = semanticVersion(candidate);
  const now = semanticVersion(current);
  return Boolean(next && now && compareSemanticVersions(next, now) > 0);
}

/** npm output can echo registry credentials (an auth token setting, a URL with a password). */
function redactNpmCredentials(text: string): string {
  return text
    .replace(/((?:_auth(?:Token)?|token|password|_password)\s*[=:]\s*)\S+/giu, '$1[redacted]')
    .replace(/\bnpm_[A-Za-z0-9]{16,}\b/gu, '[redacted]')
    .replace(/(\/\/[^/\s:@]+:)[^@\s]+@/gu, '$1[redacted]@');
}

function lastLines(text: string): string {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return sanitizeProviderDiagnostic(redactNpmCredentials(lines.slice(-4).join('\n')), { maxLength: 600 }).text;
}

/**
 * The provider program itself (Claude Code, Codex): installed and latest version, and an
 * in-place update through npm. Windows cannot replace a running executable, so the update
 * stops where the program still runs and never retries on its own.
 */
export class AgentCliUpdateService {
  private readonly updating = new Set<AgentCliProviderId>();
  private readonly latest = new Map<AgentCliProviderId, { readonly version: string | null; readonly at: number }>();
  private npmPrefix: Promise<string | undefined> | undefined;

  constructor(private readonly options: AgentCliUpdateServiceOptions) {}

  isUpdating(providerId: string): boolean {
    return this.updating.has(providerId as AgentCliProviderId);
  }

  async status(providerId: AgentCliProviderId, request: { readonly refreshLatest?: boolean } = {}): Promise<AgentCliStatus> {
    const inspection = await this.options.inspect(providerId);
    return this.describe(providerId, inspection, request.refreshLatest === true);
  }

  update(providerId: AgentCliProviderId): Promise<AgentCliUpdateResult> {
    if (this.updating.has(providerId)) return Promise.resolve({ ok: false, code: 'blocked' });
    return this.options.exclusive(() => this.runUpdate(providerId));
  }

  private async describe(providerId: AgentCliProviderId, inspection: ProviderRegistryResult<ProviderInspection>, refreshLatest: boolean): Promise<AgentCliStatus> {
    const packageName = AGENT_CLI_PACKAGES[providerId];
    const installed = installedVersion(inspection);
    const install = installed && inspection.ok ? await npmInstall(providerId, inspection.value.probe.executablePath, this.options.exists) : undefined;
    const latest = await this.latestVersion(providerId, refreshLatest);
    const blockers: AgentCliBlocker[] = [];
    if (installed) {
      if (!install) blockers.push({ kind: 'not-npm' });
      else {
        const prefix = await this.globalPrefix();
        if (!prefix || !sameFolder(prefix, install.prefix)) blockers.push({ kind: 'prefix-mismatch' });
      }
      if (providerId === 'claude' && await this.updatesDisabled()) blockers.push({ kind: 'policy' });
      if (latest && newer(latest, installed) && !this.options.compatible(providerId, latest)) blockers.push({ kind: 'incompatible', version: latest });
      const locations = await this.locations(providerId, install);
      if (locations.length) blockers.push({ kind: 'running', locations });
    }
    const updateAvailable = Boolean(installed && latest && newer(latest, installed));
    const manualCommand = !installed
      ? `npm install -g ${packageName}`
      : install ? `npm install -g ${packageName}@${latest ?? 'latest'}` : `${providerId} update`;
    return {
      providerId, installedVersion: installed, latestVersion: latest, updateAvailable,
      updating: this.updating.has(providerId), blockers, manualCommand,
      checkedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
  }

  /** Where the program runs that the app knows of; outside copies only show once the app holds none. */
  private async locations(providerId: AgentCliProviderId, install: NpmInstall | undefined): Promise<AgentCliLocation[]> {
    const snapshot = this.options.getSnapshot();
    const locations: AgentCliLocation[] = providerActiveAgents(snapshot, providerId).map((agent) => {
      const title = snapshot.sessions.find((session) => session.id === agent.sessionId)?.title;
      return { kind: 'conversation', ...(title ? { label: title } : {}) };
    });
    for (const run of this.options.terminalRuns()) {
      if (run.live && run.provider === providerId) locations.push({ kind: 'terminal', label: path.basename(run.cwd) || run.cwd });
    }
    const enabled = snapshot.providers.find((provider) => provider.id === providerId)?.enabled === true;
    if (!enabled && install && await this.options.fileInUse(install.executable)) locations.push({ kind: 'outside' });
    return locations;
  }

  private async runUpdate(providerId: AgentCliProviderId): Promise<AgentCliUpdateResult> {
    const before = await this.options.inspect(providerId);
    const status = await this.describe(providerId, before, false);
    if (!status.installedVersion || !before.ok) return { ok: false, code: 'unavailable', manualCommand: status.manualCommand };
    if (status.blockers.length) return { ok: false, code: 'blocked', blockers: status.blockers, manualCommand: status.manualCommand };
    if (!status.updateAvailable || !status.latestVersion) return { ok: false, code: 'unavailable' };
    const install = await npmInstall(providerId, before.value.probe.executablePath, this.options.exists);
    const npm = await this.options.npm.locate();
    if (!install || !npm) return { ok: false, code: 'blocked', blockers: [{ kind: 'not-npm' }], manualCommand: status.manualCommand };

    const previousVersion = status.installedVersion;
    const target = `${AGENT_CLI_PACKAGES[providerId]}@${status.latestVersion}`;
    const reviewed = this.options.getSnapshot().providers.find((provider) => provider.id === providerId);
    const wasEnabled = reviewed?.enabled === true;
    this.updating.add(providerId);
    this.options.onChanged?.(providerId);
    try {
      if (wasEnabled) {
        const disabled = await this.send((base) => createDaemonCommand({ ...base, type: 'provider.disable', payload: { providerId } }));
        // A conversation started between the check and now keeps the program in use.
        if (!disabled.ok) return { ok: false, code: 'blocked', blockers: [{ kind: 'running', locations: [{ kind: 'conversation' }] }] };
      }
      await this.options.deactivate(providerId);
      if (await this.options.fileInUse(install.executable)) {
        await this.restore(providerId, reviewed, wasEnabled);
        return { ok: false, code: 'blocked', blockers: [{ kind: 'running', locations: [{ kind: 'outside' }] }], manualCommand: `npm install -g ${target}` };
      }
      let result: NpmResult;
      try { result = await this.options.npm.run(npm, ['install', '-g', target], NPM_INSTALL_TIMEOUT_MS); }
      catch (error) { result = { exitCode: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }; }
      const after = await this.options.inspect(providerId);
      const version = installedVersion(after);
      if (result.exitCode !== 0 || !version || !newer(version, previousVersion)) {
        await this.restore(providerId, reviewed, wasEnabled, after);
        return { ok: false, code: 'failed', detail: lastLines(`${result.stderr}\n${result.stdout}`) || `npm exited with ${result.exitCode}`, manualCommand: `npm install -g ${target}` };
      }
      const provider = wasEnabled ? await this.restore(providerId, reviewed, true, after) : 'not-enabled';
      return { ok: true, previousVersion, version, provider };
    } finally {
      this.updating.delete(providerId);
      this.latest.delete(providerId);
      this.options.onChanged?.(providerId);
    }
  }

  /**
   * Turns the provider back on when the person's review still holds (only the version moved),
   * judged against the record from before the update turned it off.
   */
  private async restore(
    providerId: AgentCliProviderId,
    reviewed: DaemonProvider | undefined,
    wasEnabled: boolean,
    inspection?: ProviderRegistryResult<ProviderInspection>,
  ): Promise<'ready' | 'not-enabled' | 'needs-review'> {
    if (!wasEnabled || !reviewed) return 'not-enabled';
    const current = inspection ?? await this.options.inspect(providerId);
    if (!current.ok || !daemonProviderMatchesProbe(reviewed, current.value.probe, current.value.reviewDigest)) return 'needs-review';
    const { probe, reviewDigest } = current.value;
    const receipt = await this.send((base) => createDaemonCommand({ ...base, type: 'provider.update', payload: {
      providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol,
      executablePath: probe.executablePath, executableVersion: probe.executableVersion, argv: probe.argv,
      environmentVariableNames: probe.environmentVariableNames, capabilities: probe.capabilities, reviewDigest,
    } }));
    return receipt.ok ? 'ready' : 'needs-review';
  }

  /** Sends a provider command from the desktop, retrying a revision race like the settings card. */
  private async send(build: (base: { readonly commandId: string; readonly idempotencyKey: string; readonly expectedRevision: number; readonly issuedAt: string; readonly principal: { readonly kind: 'desktop'; readonly id: string } }) => DaemonCommand): Promise<DaemonCommandReceipt> {
    let receipt: DaemonCommandReceipt | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const commandId = `agent-cli-update-${Date.now().toString(36)}-${attempt}-${Math.random().toString(36).slice(2, 8)}`;
      receipt = await this.options.sendCommand(build({
        commandId, idempotencyKey: commandId, expectedRevision: this.options.getSnapshot().revision,
        issuedAt: (this.options.now?.() ?? new Date()).toISOString(),
        principal: { kind: 'desktop', id: 'agent-cli-update' },
      }));
      if (receipt.ok || receipt.error.code !== 'revision-conflict') return receipt;
    }
    return receipt!;
  }

  private async latestVersion(providerId: AgentCliProviderId, refresh: boolean): Promise<string | null> {
    const cached = this.latest.get(providerId);
    const now = Date.now();
    if (cached && !refresh && now - cached.at < LATEST_TTL_MS) return cached.version;
    let version: string | null = null;
    try {
      const npm = await this.options.npm.locate();
      if (npm) {
        const result = await this.options.npm.run(npm, ['view', AGENT_CLI_PACKAGES[providerId], 'version'], NPM_QUERY_TIMEOUT_MS);
        const candidate = result.exitCode === 0 ? result.stdout.trim().split(/\s+/u).pop() ?? '' : '';
        version = semanticVersion(candidate) ? candidate : null;
      }
    } catch { version = null; }
    this.latest.set(providerId, { version, at: now });
    return version;
  }

  private globalPrefix(): Promise<string | undefined> {
    this.npmPrefix ??= (async () => {
      const npm = await this.options.npm.locate();
      if (!npm) return undefined;
      const result = await this.options.npm.run(npm, ['prefix', '-g'], NPM_QUERY_TIMEOUT_MS);
      const prefix = result.exitCode === 0 ? result.stdout.trim().split(/\r?\n/u).pop()?.trim() : undefined;
      return prefix && path.isAbsolute(prefix) ? prefix : undefined;
    })().catch(() => undefined);
    const pending = this.npmPrefix;
    // A failed read is retried next time rather than remembered.
    void pending.then((prefix) => { if (!prefix && this.npmPrefix === pending) this.npmPrefix = undefined; });
    return pending;
  }

  private async updatesDisabled(): Promise<boolean> {
    const set = (value: unknown): boolean => value !== undefined && value !== null && value !== '' && value !== '0' && value !== 0 && value !== false && value !== 'false';
    if (set(this.options.environment.DISABLE_UPDATES)) return true;
    return set((await this.options.claudeSettingsEnvironment()).DISABLE_UPDATES);
  }
}

/** Real npm: the absolute `npm.cmd` from PATH, run with fixed argv through cross-spawn (no shell string). */
export function systemNpmRunner(environment: NodeJS.ProcessEnv = process.env): NpmRunner {
  let located: Promise<string | undefined> | undefined;
  const capture = (command: string, argv: readonly string[], timeoutMs: number, cwd?: string): Promise<NpmResult> => new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = crossSpawn(command, [...argv], { cwd: cwd ?? os.homedir(), env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer | string) => { if (stdout.length < 1_000_000) stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer | string) => { if (stderr.length < 1_000_000) stderr += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timer); resolve({ exitCode: -1, stdout, stderr: `${stderr}\n${error.message}` }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1, stdout, stderr }); });
  });
  return {
    locate() {
      located ??= (async () => {
        const result = await capture(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'npm.cmd' : 'npm'], NPM_QUERY_TIMEOUT_MS);
        const candidate = result.exitCode === 0 ? result.stdout.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) : undefined;
        return candidate && path.isAbsolute(candidate) ? candidate : undefined;
      })();
      return located;
    },
    run: (npm, argv, timeoutMs) => capture(npm, argv, timeoutMs),
  };
}

/** Windows refuses write access to an executable while any process runs it. */
export async function executableInUse(file: string): Promise<boolean> {
  try {
    const handle = await fs.open(file, 'r+');
    await handle.close();
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
  }
}

export async function fileExists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

export async function readClaudeSettingsEnvironment(home = os.homedir()): Promise<Readonly<Record<string, unknown>>> {
  try {
    const settings = JSON.parse(await fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf8')) as { env?: unknown };
    return settings.env && typeof settings.env === 'object' ? settings.env as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
