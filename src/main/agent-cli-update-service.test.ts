import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { DaemonCommand, DaemonSnapshot } from '../shared/daemon-protocol';
import { CODEX_FIRST_LAUNCH_AUTHENTICATION_DETAIL, type ProviderInspection, type ProviderRegistryResult } from '../shared/daemon-provider';
import { AgentCliUpdateService, npmInstall, type NpmResult } from './agent-cli-update-service';

const PREFIX = path.resolve('npm-prefix');
const SHIM = path.join(PREFIX, 'codex.cmd');
const PACKAGE = path.join(PREFIX, 'node_modules', '@openai', 'codex', 'package.json');

interface Options {
  readonly enabled?: boolean;
  readonly latest?: string;
  readonly prefix?: string;
  readonly executablePath?: string;
  readonly inUse?: boolean[];
  readonly installExit?: number;
  readonly compatible?: boolean;
  readonly settingsEnvironment?: Record<string, unknown>;
  readonly agents?: readonly unknown[];
  readonly terminals?: readonly { provider: string; live: boolean; cwd: string }[];
  readonly pathAfterInstall?: string;
}

function harness(options: Options = {}) {
  let version = '0.163.0';
  let executablePath = options.executablePath ?? (process.platform === 'win32' ? SHIM : path.join(PREFIX, 'codex'));
  const order: string[] = [];
  const commands: DaemonCommand[] = [];
  const inUse = [...(options.inUse ?? [false])];
  const probe = () => ({
    providerId: 'codex', displayName: 'Codex', protocol: 'codex-app-server' as const, available: true, executablePath,
    executableVersion: version, argv: ['app-server'], environmentVariableNames: ['PATH'], capabilities: ['create'],
    authenticationState: 'first-launch' as const, authenticationDetail: CODEX_FIRST_LAUNCH_AUTHENTICATION_DETAIL,
  });
  const inspect = vi.fn(async (): Promise<ProviderRegistryResult<ProviderInspection>> => {
    order.push(`inspect ${version}`);
    return { ok: true, value: { probe: probe(), reviewDigest: `digest-${version}` } as unknown as ProviderInspection };
  });
  const reviewed = { ...probe(), id: 'codex', enabled: options.enabled ?? true, health: 'ready', reviewDigest: 'digest-0.163.0' };
  const snapshot = {
    revision: 7, providers: [reviewed], agents: options.agents ?? [], turns: [],
    sessions: [{ id: 'session-1', title: 'Release notes' }],
  } as unknown as DaemonSnapshot;
  const run = vi.fn(async (_npm: string, argv: readonly string[]): Promise<NpmResult> => {
    order.push(`npm ${argv.join(' ')}`);
    if (argv[0] === 'prefix') return { exitCode: 0, stdout: `${options.prefix ?? PREFIX}\n`, stderr: '' };
    if (argv[0] === 'view') return { exitCode: 0, stdout: `${options.latest ?? '0.165.0'}\n`, stderr: '' };
    if ((options.installExit ?? 0) !== 0) return { exitCode: options.installExit!, stdout: '', stderr: 'npm error code EBUSY\nnpm error path C:\\npm\\codex.exe\nnpm error token=npm_secret1234567890abcdef' };
    version = argv[2]!.split('@').pop()!;
    if (options.pathAfterInstall) executablePath = options.pathAfterInstall;
    return { exitCode: 0, stdout: 'changed 1 package', stderr: '' };
  });
  const changed = vi.fn();
  const service = new AgentCliUpdateService({
    inspect,
    getSnapshot: () => snapshot,
    sendCommand: vi.fn(async (command: DaemonCommand) => { order.push(command.type); commands.push(command); return { ok: true } as never; }),
    deactivate: vi.fn(async () => { order.push('deactivate'); }),
    terminalRuns: () => options.terminals ?? [],
    exclusive: (operation) => operation(),
    npm: { locate: async () => path.join(PREFIX, 'npm.cmd'), run },
    fileInUse: vi.fn(async () => { order.push('lock check'); return inUse.shift() ?? false; }),
    exists: async (file) => file === PACKAGE || file === path.join(PREFIX, 'claude.cmd'),
    claudeSettingsEnvironment: async () => options.settingsEnvironment ?? {},
    environment: {},
    compatible: () => options.compatible ?? true,
    onChanged: changed,
  });
  return { service, order, commands, run, changed, inspect, version: () => version };
}

describe('AgentCliUpdateService status', () => {
  it('reports an npm install with a newer version and the exact command to run by hand', async () => {
    const h = harness();
    expect(await h.service.status('codex')).toMatchObject({
      installedVersion: '0.163.0', latestVersion: '0.165.0', updateAvailable: true, blockers: [],
      manualCommand: 'npm install -g @openai/codex@0.165.0',
    });
    await h.service.status('codex');
    expect(h.run.mock.calls.filter(([, argv]) => argv[0] === 'view')).toHaveLength(1);
    await h.service.status('codex', { refreshLatest: true });
    expect(h.run.mock.calls.filter(([, argv]) => argv[0] === 'view')).toHaveLength(2);
  });

  it('explains installs the app cannot update', async () => {
    expect(await harness({ executablePath: path.resolve('elsewhere', 'codex.exe') }).service.status('codex'))
      .toMatchObject({ blockers: [{ kind: 'not-npm' }], manualCommand: 'codex update' });
    expect(await harness({ prefix: path.resolve('other-prefix') }).service.status('codex')).toMatchObject({ blockers: [{ kind: 'prefix-mismatch' }] });
    expect(await harness({ compatible: false }).service.status('codex')).toMatchObject({ blockers: [{ kind: 'incompatible', version: '0.165.0' }] });
  });

  it('lists where the program runs: busy conversations, terminal tabs, and outside copies when the app holds none', async () => {
    const busy = { sessionId: 'session-1', providerId: 'codex', state: 'working', queuedTurnCount: 0 };
    const idle = { sessionId: 'session-2', providerId: 'codex', state: 'idle', queuedTurnCount: 0 };
    const terminals = [{ provider: 'codex', live: true, cwd: path.resolve('work', 'EZTerminal') }, { provider: 'codex', live: false, cwd: 'x' }];
    expect(await harness({ agents: [busy, idle], terminals }).service.status('codex')).toMatchObject({ blockers: [{ kind: 'running', locations: [
      { kind: 'conversation', label: 'Release notes' }, { kind: 'terminal', label: 'EZTerminal' },
    ] }] });
    expect(await harness({ enabled: false, inUse: [true] }).service.status('codex')).toMatchObject({ blockers: [{ kind: 'running', locations: [{ kind: 'outside' }] }] });
  });

  it('honours Claude Code’s DISABLE_UPDATES but not DISABLE_AUTOUPDATER', async () => {
    const claudeExe = path.join(PREFIX, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    expect(await npmInstall('claude', claudeExe, async (file) => file === path.join(PREFIX, 'claude.cmd'))).toEqual({ prefix: PREFIX, executable: claudeExe });
    const blocked = harness({ executablePath: claudeExe, settingsEnvironment: { DISABLE_UPDATES: '1' } });
    expect((await blocked.service.status('claude')).blockers).toContainEqual({ kind: 'policy' });
    const allowed = harness({ executablePath: claudeExe, settingsEnvironment: { DISABLE_AUTOUPDATER: '1' } });
    expect((await allowed.service.status('claude')).blockers).not.toContainEqual({ kind: 'policy' });
  });
});

describe('AgentCliUpdateService update', () => {
  it('releases the app’s copies, checks the lock, installs, then turns the reviewed provider back on', async () => {
    const h = harness();
    let duringUpdate = false;
    h.changed.mockImplementation(() => { duringUpdate ||= h.service.isUpdating('codex'); });
    expect(await h.service.update('codex')).toEqual({ ok: true, previousVersion: '0.163.0', version: '0.165.0', provider: 'ready' });
    expect(h.order.filter((step) => !step.startsWith('inspect') && !step.startsWith('npm prefix') && !step.startsWith('npm view'))).toEqual([
      'provider.disable', 'deactivate', 'lock check', 'npm install -g @openai/codex@0.165.0', 'provider.update',
    ]);
    expect(h.commands.at(-1)).toMatchObject({ type: 'provider.update', principal: { kind: 'desktop' }, payload: { executableVersion: '0.165.0', reviewDigest: 'digest-0.165.0' } });
    expect(duringUpdate).toBe(true);
    expect(h.service.isUpdating('codex')).toBe(false);
  });

  it('stops before npm when a copy outside the app still runs, and turns the provider back on', async () => {
    const h = harness({ inUse: [true] });
    expect(await h.service.update('codex')).toMatchObject({ ok: false, code: 'blocked', blockers: [{ kind: 'running', locations: [{ kind: 'outside' }] }] });
    expect(h.order.some((step) => step.startsWith('npm install'))).toBe(false);
    expect(h.commands.map((command) => command.type)).toEqual(['provider.disable', 'provider.update']);
  });

  it('keeps the previous version working after a failed install and shows a cleaned cause', async () => {
    const h = harness({ installExit: 1 });
    const result = await h.service.update('codex');
    expect(result).toMatchObject({ ok: false, code: 'failed', manualCommand: 'npm install -g @openai/codex@0.165.0' });
    expect(result.ok ? '' : result.detail).toContain('EBUSY');
    expect(result.ok ? '' : result.detail).not.toContain('npm_secret1234567890abcdef');
    expect(h.commands.map((command) => command.type)).toEqual(['provider.disable', 'provider.update']);
  });

  it('leaves the provider off for a new review when more than the version changed', async () => {
    const h = harness({ pathAfterInstall: path.join(PREFIX, 'moved', 'codex.cmd') });
    expect(await h.service.update('codex')).toMatchObject({ ok: true, provider: 'needs-review' });
    expect(h.commands.map((command) => command.type)).toEqual(['provider.disable']);
  });

  it('updates a provider that is not in use without touching its settings', async () => {
    const h = harness({ enabled: false });
    expect(await h.service.update('codex')).toMatchObject({ ok: true, provider: 'not-enabled' });
    expect(h.commands).toEqual([]);
  });

  it('refuses while a conversation is working and when there is nothing newer', async () => {
    const busy = { sessionId: 'session-1', providerId: 'codex', state: 'working', queuedTurnCount: 0 };
    expect(await harness({ agents: [busy] }).service.update('codex')).toMatchObject({ ok: false, code: 'blocked' });
    expect(await harness({ latest: '0.163.0' }).service.update('codex')).toMatchObject({ ok: false, code: 'unavailable' });
  });
});
