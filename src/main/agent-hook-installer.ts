import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  AgentIntegrationMutationResult,
  AgentIntegrationProvider,
  AgentIntegrationStatus,
} from '../shared/agent';

const OWNED_STATUS_PREFIX = 'EZTerminal agent activity';
const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop'] as const;
const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function marker(provider: AgentIntegrationProvider): string {
  return `${OWNED_STATUS_PREFIX} (${provider}, v1)`;
}

function quoteWindowsCommandArgument(value: string): string {
  return `"${value.replace(/"/gu, '\\"')}"`;
}

function handlerFor(provider: AgentIntegrationProvider, scriptPath: string): JsonObject {
  if (provider === 'codex') {
    const command = [
      'powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy Bypass',
      '-File',
      quoteWindowsCommandArgument(scriptPath),
      '-Provider codex',
    ].join(' ');
    return {
      type: 'command',
      command,
      commandWindows: command,
      timeout: 5,
      statusMessage: marker(provider),
    };
  }
  return {
    type: 'command',
    command: 'powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Provider',
      'claude',
    ],
    timeout: 5,
    statusMessage: marker(provider),
  };
}

function groupFor(provider: AgentIntegrationProvider, event: string, scriptPath: string): JsonObject {
  const base: JsonObject = { hooks: [handlerFor(provider, scriptPath)] };
  if (provider === 'claude' && event === 'Notification') {
    // agent_needs_input/agent_completed describe Claude background sessions,
    // not the foreground CLI represented by this activity record. Mapping
    // either one to the top-level terminal would make follow-up target the
    // wrong conversation.
    return { matcher: 'permission_prompt|idle_prompt', ...base };
  }
  return base;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function groupLooksOwned(group: unknown, scriptPath: string): boolean {
  if (!isObject(group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.some(
    (hook) =>
      isObject(hook) &&
      ((typeof hook.statusMessage === 'string' && hook.statusMessage.startsWith(OWNED_STATUS_PREFIX)) ||
        (typeof hook.command === 'string' && hook.command.includes(scriptPath)) ||
        (Array.isArray(hook.args) && hook.args.includes(scriptPath))),
  );
}

function eventsFor(provider: AgentIntegrationProvider): readonly string[] {
  return provider === 'codex' ? CODEX_EVENTS : CLAUDE_EVENTS;
}

interface ConfigInspection {
  readonly raw: JsonObject;
  /** Exact bytes read from disk, or null when the file did not exist. */
  readonly sourceText: string | null;
  readonly enabled: boolean;
  readonly drift: boolean;
  readonly exactOwnedCount: number;
  readonly error?: 'invalid-json' | 'invalid-shape';
}

async function readJsonConfig(
  configPath: string,
  provider: AgentIntegrationProvider,
  scriptPath: string,
): Promise<ConfigInspection> {
  let text: string;
  try {
    text = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { raw: {}, sourceText: null, enabled: false, drift: false, exactOwnedCount: 0 };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { raw: {}, sourceText: text, enabled: false, drift: false, exactOwnedCount: 0, error: 'invalid-json' };
  }
  if (!isObject(parsed)) {
    return { raw: {}, sourceText: text, enabled: false, drift: false, exactOwnedCount: 0, error: 'invalid-shape' };
  }
  if (parsed.hooks !== undefined && !isObject(parsed.hooks)) {
    return {
      raw: parsed,
      sourceText: text,
      enabled: false,
      drift: false,
      exactOwnedCount: 0,
      error: 'invalid-shape',
    };
  }
  const hooks = (parsed.hooks ?? {}) as JsonObject;
  let exact = 0;
  let modifiedOwned = 0;
  let allEventsExact = true;
  for (const event of eventsFor(provider)) {
    const groups = hooks[event];
    if (groups !== undefined && !Array.isArray(groups)) {
      return {
        raw: parsed,
        sourceText: text,
        enabled: false,
        drift: false,
        exactOwnedCount: 0,
        error: 'invalid-shape',
      };
    }
    let exactForEvent = 0;
    for (const group of (groups ?? []) as unknown[]) {
      if (!groupLooksOwned(group, scriptPath)) continue;
      if (deepEqual(group, groupFor(provider, event, scriptPath))) {
        exact += 1;
        exactForEvent += 1;
      } else {
        modifiedOwned += 1;
      }
    }
    if (exactForEvent !== 1) allEventsExact = false;
  }
  // A marker under an event EZTerminal doesn't own is also drift. Scan all
  // groups rather than silently leaving a user-modified owned entry behind.
  for (const [event, groups] of Object.entries(hooks)) {
    if (eventsFor(provider).includes(event) || !Array.isArray(groups)) continue;
    for (const group of groups) if (groupLooksOwned(group, scriptPath)) modifiedOwned += 1;
  }
  return {
    raw: parsed,
    sourceText: text,
    enabled: allEventsExact && exact === eventsFor(provider).length && modifiedOwned === 0,
    // Exact partial/duplicate entries are safe to canonicalize. Only a
    // user-modified owned group is drift that requires manual resolution.
    drift: modifiedOwned > 0,
    exactOwnedCount: exact,
  };
}

async function readTextIfPresent(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function codexBlockers(configToml: string): string[] {
  const blockers: string[] = [];
  if (/^\s*hooks\s*=\s*false\s*(?:#.*)?$/imu.test(configToml)) blockers.push('hooks-disabled');
  if (/^\s*allow_managed_hooks_only\s*=\s*true\s*(?:#.*)?$/imu.test(configToml)) {
    blockers.push('managed-hooks-only');
  }
  if (
    /^\s*\[\[?hooks\.(?:SessionStart|UserPromptSubmit|PermissionRequest|Stop|PreToolUse|PostToolUse|PreCompact|PostCompact|SubagentStart|SubagentStop)\]?\]\s*$/gmu.test(
      configToml,
    )
  ) {
    blockers.push('inline-hooks-present');
  }
  return blockers;
}

function claudeBlockers(raw: JsonObject): string[] {
  return raw.allowManagedHooksOnly === true ? ['managed-hooks-only'] : [];
}

async function readSourceText(configPath: string): Promise<string | null> {
  try {
    return await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function assertConfigUnchanged(configPath: string, expectedSourceText: string | null): Promise<void> {
  const current = await readSourceText(configPath);
  if (current !== expectedSourceText) {
    throw new Error('Hook configuration changed while EZTerminal was updating it; no changes were applied.');
  }
}

async function writeConfigAtomic(
  configPath: string,
  raw: JsonObject,
  expectedSourceText: string | null,
): Promise<string | undefined> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  // The installer deliberately does not hold stale parsed state across an
  // external Claude/Codex settings edit.
  await assertConfigUnchanged(configPath, expectedSourceText);
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  let backupPath: string | undefined;
  if (expectedSourceText !== null) {
    backupPath = `${configPath}.${timestamp}.${randomUUID()}.ezterminal.bak`;
    // Back up the exact bytes we inspected. Any failure aborts the mutation;
    // only a genuinely missing source skips backup creation.
    await fs.writeFile(backupPath, expectedSourceText, { encoding: 'utf8', flag: 'wx' });
  }
  const tmp = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    // Re-check immediately before the atomic swap. This catches another
    // process editing settings after inspection or while the temp was built.
    await assertConfigUnchanged(configPath, expectedSourceText);
    await fs.rename(tmp, configPath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
  return backupPath;
}

export class AgentHookInstaller {
  private readonly homeDir: string;
  private readonly scriptPath: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(homeDir: string, scriptPath: string) {
    this.homeDir = homeDir;
    this.scriptPath = scriptPath;
  }

  configPath(provider: AgentIntegrationProvider): string {
    return provider === 'codex'
      ? path.join(this.homeDir, '.codex', 'hooks.json')
      : path.join(this.homeDir, '.claude', 'settings.json');
  }

  async list(): Promise<readonly AgentIntegrationStatus[]> {
    return Promise.all([this.status('codex'), this.status('claude')]);
  }

  async status(provider: AgentIntegrationProvider): Promise<AgentIntegrationStatus> {
    const configPath = this.configPath(provider);
    let inspection: ConfigInspection;
    try {
      inspection = await readJsonConfig(configPath, provider, this.scriptPath);
    } catch {
      return {
        provider,
        configPath,
        enabled: false,
        drift: false,
        needsTrust: false,
        blockers: ['config-unreadable'],
      };
    }
    const blockers: string[] = [];
    if (inspection.error) blockers.push(inspection.error === 'invalid-json' ? 'config-invalid-json' : 'config-invalid-shape');
    if (provider === 'codex') {
      blockers.push(...codexBlockers(await readTextIfPresent(path.join(this.homeDir, '.codex', 'config.toml'))));
    } else {
      blockers.push(...claudeBlockers(inspection.raw));
    }
    return {
      provider,
      configPath,
      enabled: inspection.enabled,
      drift: inspection.drift,
      needsTrust: provider === 'codex' && inspection.enabled,
      blockers,
    };
  }

  mutate(provider: AgentIntegrationProvider, enabled: boolean): Promise<AgentIntegrationMutationResult> {
    const run = this.chain.then(() => this.mutateNow(provider, enabled));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async mutateNow(
    provider: AgentIntegrationProvider,
    enabled: boolean,
  ): Promise<AgentIntegrationMutationResult> {
    const configPath = this.configPath(provider);
    let inspection: ConfigInspection;
    try {
      inspection = await readJsonConfig(configPath, provider, this.scriptPath);
    } catch (err) {
      return this.failure(provider, 'io-error', `Unable to read hook configuration: ${String(err)}`);
    }
    if (inspection.error) {
      return this.failure(
        provider,
        inspection.error,
        'The existing hook configuration is not valid JSON with an object-shaped hooks field; it was not changed.',
      );
    }
    if (inspection.drift) {
      return this.failure(
        provider,
        'drift',
        'An EZTerminal-owned hook was modified. Restore or remove that entry manually before retrying.',
      );
    }
    const currentStatus = await this.status(provider);
    if (enabled && currentStatus.blockers.length > 0) {
      return {
        ok: false,
        error: 'blocked',
        message: `Hook integration is blocked: ${currentStatus.blockers.join(', ')}`,
        status: currentStatus,
      };
    }
    if ((enabled && inspection.enabled) || (!enabled && inspection.exactOwnedCount === 0)) {
      return { ok: true, status: currentStatus };
    }

    const root = structuredClone(inspection.raw);
    const hooks = isObject(root.hooks) ? root.hooks : {};
    root.hooks = hooks;
    for (const event of eventsFor(provider)) {
      const groups = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
      const expected = groupFor(provider, event, this.scriptPath);
      // Canonicalize exact owned entries: this both fills a partial install
      // and deduplicates a prior interrupted/manual copy operation.
      const withoutOwnedExact = groups.filter((group) => !deepEqual(group, expected));
      hooks[event] = enabled ? [...withoutOwnedExact, expected] : withoutOwnedExact;
      if (!enabled && (hooks[event] as unknown[]).length === 0) delete hooks[event];
    }
    if (!enabled && Object.keys(hooks).length === 0) delete root.hooks;

    try {
      const backupPath = await writeConfigAtomic(configPath, root, inspection.sourceText);
      return { ok: true, status: await this.status(provider), ...(backupPath ? { backupPath } : {}) };
    } catch (err) {
      return this.failure(provider, 'io-error', `Unable to update hook configuration: ${String(err)}`);
    }
  }

  private async failure(
    provider: AgentIntegrationProvider,
    error: 'invalid-json' | 'invalid-shape' | 'drift' | 'io-error',
    message: string,
  ): Promise<AgentIntegrationMutationResult> {
    return { ok: false, error, message, status: await this.status(provider) };
  }
}
