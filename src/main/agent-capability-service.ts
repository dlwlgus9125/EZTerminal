import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AGENT_HOST_SCOPE_ID, AgentCapabilitiesRequestSchema, AgentExtensionCommandSchema, AgentHostCommandSchema, AgentHostRequestSchema,
  AgentPluginBrowseRequestSchema,
  type AgentCapabilitiesRequest, type AgentCapabilityCatalog, type AgentCapabilityItem, type AgentCapabilityResult,
  type AgentExtensionCommand, type AgentExtensionReceipt, type AgentPluginBrowsePage, type AgentPluginEntry,
} from '../shared/agent-capabilities';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type { AgentProviderRegistry } from './agent-provider-registry';

export interface AgentCapabilityScope {
  readonly workspaceRoot: string;
  readonly canManage: boolean;
  readonly workflowToolsAvailable?: boolean;
  readonly authorityKey?: string;
}

/** The PC user scope: settings for every project, read from a neutral folder. */
export interface AgentHostScope {
  /** An empty folder owned by the app, so no project settings load. */
  readonly hostRoot: string;
  readonly canManage: boolean;
  readonly authorityKey?: string;
  /** Folder of an active app workspace, for a Claude plugin installed into a project. */
  readonly workspaceRoot: (workspaceId: string) => string | undefined;
  /** Active app workspace at a project folder, which makes that project's installs manageable. */
  readonly workspaceForPath: (folder: string) => string | undefined;
}

type ProviderId = 'codex' | 'claude';
interface StoredReceipt { readonly digest: string; readonly receipt: AgentExtensionReceipt; readonly scopeDigest?: string; readonly acknowledged?: boolean }
interface HostContext { readonly scope: AgentHostScope }
const BROWSE_DESCRIPTION_LIMIT = 300;
const UPDATING = { ok: false, code: 'unavailable', message: 'The provider program is being updated. Try again when it finishes.' } as const;

export class AgentCapabilityService {
  private serial: Promise<unknown> = Promise.resolve();
  private readonly receipts = new Map<string, StoredReceipt>();
  private readonly available = new Map<ProviderId, { readonly entries: readonly AgentPluginEntry[]; readonly observedAt: string }>();
  private readonly changeListeners = new Set<(providerId: ProviderId) => void>();
  constructor(private readonly options: {
    readonly registry: Pick<AgentProviderRegistry, 'enabledAdapter'>;
    readonly getSnapshot: () => Pick<DaemonSnapshot, 'providers'>;
    readonly hostId: string;
    readonly receiptDirectory?: string;
    /** True while the provider's program is being replaced; nothing may launch it then. */
    readonly isUpdating?: (providerId: ProviderId) => boolean;
  }) {}

  list(value: unknown, scope: AgentCapabilityScope, signal?: AbortSignal): Promise<AgentCapabilityResult<AgentCapabilityCatalog>> {
    const parsed = AgentCapabilitiesRequestSchema.safeParse(value);
    if (!parsed.success || parsed.data.workspaceId === AGENT_HOST_SCOPE_ID) return Promise.resolve({ ok: false, code: 'invalid-input', message: 'Select an active workspace on the connected PC.' });
    return this.catalog(parsed.data, scope, signal);
  }

  /** The PC user scope catalog: user settings, every plugin install and the marketplaces. */
  listHost(value: unknown, scope: AgentHostScope, signal?: AbortSignal): Promise<AgentCapabilityResult<AgentCapabilityCatalog>> {
    const parsed = AgentHostRequestSchema.safeParse(value);
    if (!parsed.success) return Promise.resolve({ ok: false, code: 'invalid-input', message: 'Choose Claude or Codex.' });
    return this.catalog({ providerId: parsed.data.providerId, workspaceId: AGENT_HOST_SCOPE_ID }, hostCapabilityScope(scope), signal, { scope });
  }

  /** One page of the plugins the configured marketplaces offer. */
  async browse(value: unknown, scope: AgentHostScope, signal?: AbortSignal): Promise<AgentCapabilityResult<AgentPluginBrowsePage>> {
    const parsed = AgentPluginBrowseRequestSchema.safeParse(value);
    if (!parsed.success || !path.isAbsolute(scope.hostRoot)) return { ok: false, code: 'invalid-input', message: 'The plugin search is invalid.' };
    const request = parsed.data;
    if (this.options.isUpdating?.(request.providerId)) return UPDATING;
    const selected = this.options.registry.enabledAdapter(this.options.getSnapshot(), request.providerId);
    if (!selected.ok) return { ok: false, code: 'unavailable', message: 'Review and enable this provider on the connected PC.' };
    if (!selected.value.listAvailablePlugins) return { ok: false, code: 'unsupported', message: 'This provider cannot list marketplace plugins.' };
    let cached = request.refresh ? undefined : this.available.get(request.providerId);
    if (!cached) {
      try {
        cached = { entries: await selected.value.listAvailablePlugins(scope.hostRoot, signal), observedAt: new Date().toISOString() };
      } catch {
        return { ok: false, code: 'unavailable', message: 'The marketplaces could not be read. Retry, or refresh a marketplace.' };
      }
      this.available.set(request.providerId, cached);
    }
    const needle = request.query?.toLocaleLowerCase() ?? '';
    // A name match outranks a mention in another plugin's description.
    const rank = (entry: AgentPluginEntry): number => (needle && !`${entry.id} ${entry.name}`.toLocaleLowerCase().includes(needle) ? 1 : 0);
    const matches = cached.entries
      .filter((entry) => (!request.marketplace || entry.marketplace === request.marketplace)
        && (!needle || `${entry.id} ${entry.name} ${entry.description ?? ''}`.toLocaleLowerCase().includes(needle)))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.marketplace.localeCompare(b.marketplace));
    return { ok: true, value: {
      providerId: request.providerId,
      entries: matches.slice(request.offset, request.offset + request.limit).map((entry) => (
        entry.description && entry.description.length > BROWSE_DESCRIPTION_LIMIT
          ? { ...entry, description: `${entry.description.slice(0, BROWSE_DESCRIPTION_LIMIT - 1)}…` }
          : entry)),
      total: matches.length,
      offset: request.offset,
      marketplaces: [...new Set(cached.entries.map((entry) => entry.marketplace))].sort(),
      observedAt: cached.observedAt,
    } };
  }

  manage(value: unknown, scope: AgentCapabilityScope, signal?: AbortSignal): Promise<AgentCapabilityResult<AgentExtensionReceipt>> {
    return this.runExclusive(() => this.apply(value, scope, signal));
  }

  /** A change from the PC-wide screen; a Claude plugin may go into one app project. */
  manageHost(value: unknown, scope: AgentHostScope, signal?: AbortSignal): Promise<AgentCapabilityResult<AgentExtensionReceipt>> {
    return this.runExclusive(() => {
      const parsed = AgentHostCommandSchema.safeParse(value);
      if (!parsed.success) return Promise.resolve({ ok: false, code: 'invalid-input', message: 'The extension request is invalid.' } as const);
      const { workspaceId: projectWorkspaceId, ...command } = parsed.data;
      let executionRoot = scope.hostRoot;
      if (command.scope !== 'user' && !command.recovery) {
        const root = projectWorkspaceId ? scope.workspaceRoot(projectWorkspaceId) : undefined;
        if (!root) return Promise.resolve({ ok: false, code: 'forbidden', message: 'Choose an active project in this app.' } as const);
        executionRoot = root;
      }
      return this.apply({ ...command, workspaceId: AGENT_HOST_SCOPE_ID }, hostCapabilityScope(scope), signal,
        { scope, executionRoot, ...(projectWorkspaceId ? { projectWorkspaceId } : {}) });
    });
  }

  /** Called after any change, from any device, so open screens can refresh. */
  onChanged(listener: (providerId: ProviderId) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  /** Runs after every queued extension change and blocks new ones until it ends. */
  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation);
    this.serial = next.catch(() => undefined);
    return next;
  }

  private async catalog(request: AgentCapabilitiesRequest, scope: AgentCapabilityScope, signal?: AbortSignal, host?: HostContext): Promise<AgentCapabilityResult<AgentCapabilityCatalog>> {
    if (!path.isAbsolute(scope.workspaceRoot)) return { ok: false, code: 'invalid-input', message: 'Select an active workspace on the connected PC.' };
    if (this.options.isUpdating?.(request.providerId)) return UPDATING;
    const selected = this.options.registry.enabledAdapter(this.options.getSnapshot(), request.providerId);
    if (!selected.ok) return { ok: false, code: 'unavailable', message: 'Review and enable this provider on the connected PC.' };
    if (!selected.value.listCapabilities) return { ok: false, code: 'unsupported', message: 'This provider cannot discover extensions before a message.' };
    try {
      const catalog = await selected.value.listCapabilities(scope.workspaceRoot, signal, host ? { hostUser: true } : undefined);
      const items = host ? catalog.items.map((item) => hostItem(item, host.scope)) : [...catalog.items];
      if (scope.workflowToolsAvailable) items.push({
        id: 'ezterminal-workflow', kind: 'app-skill', name: 'ezterminal-workflow',
        description: 'Read, validate and edit this project’s workflow drafts using the app tools. Running versions and approvals stay unchanged.',
        source: 'EZTerminal', scope: 'project', enabled: true,
        invocation: 'Use the EZTerminal workflow tools to ', actions: [],
      });
      const identity = {
        items: items.map(({ id, kind, source, scope: itemScope, version, enabled, actions, projectPath, workspaceId }) => ({
          id, kind, source, scope: itemScope, version, enabled, actions: [...actions].sort(), projectPath, workspaceId,
        })).sort((a, b) => `${a.kind}:${a.id}:${a.projectPath ?? ''}`.localeCompare(`${b.kind}:${b.id}:${b.projectPath ?? ''}`)),
        actions: [...catalog.actions].sort(), providerId: request.providerId, workspaceId: request.workspaceId,
        configurationRevision: catalog.configurationRevision,
        marketplaces: catalog.marketplaces?.map(({ name, source, actions }) => ({ name, source, actions: [...actions].sort() })),
        workspaceRoot: scope.workspaceRoot, hostId: this.options.hostId,
        providerReview: this.options.getSnapshot().providers.find((provider) => provider.id === request.providerId)?.reviewDigest,
      };
      const revision = hash(JSON.stringify(identity));
      return { ok: true, value: {
        ...catalog, items, providerId: request.providerId, workspaceId: request.workspaceId,
        workspaceRoot: scope.workspaceRoot, hostId: this.options.hostId, revision,
        observedAt: new Date().toISOString(), canManage: scope.canManage, application: 'new-session',
        extensionReceipts: scope.canManage ? (await this.scopedReceipts(request, scope)).sort((a, b) => Number(b.receipt.state === 'uncertain') - Number(a.receipt.state === 'uncertain')).slice(0, 100).map((entry) => entry.receipt) : [],
      } };
    } catch {
      return { ok: false, code: 'unavailable', message: 'Extensions could not be read from this provider. Your conversation is unchanged; retry discovery.' };
    }
  }

  private scopeDigest(request: { providerId: string; workspaceId: string }, scope: AgentCapabilityScope): string {
    return hash(JSON.stringify({ providerId: request.providerId, workspaceId: request.workspaceId, workspaceRoot: scope.workspaceRoot, hostId: this.options.hostId, authorityKey: scope.authorityKey ?? 'host-owner' }));
  }

  private async scopedReceipts(request: { providerId: string; workspaceId: string }, scope: AgentCapabilityScope): Promise<StoredReceipt[]> {
    if (this.options.receiptDirectory) {
      let files: string[] = [];
      try { files = await fs.readdir(this.options.receiptDirectory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      for (const name of files.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))) {
        const entry = JSON.parse(await fs.readFile(path.join(this.options.receiptDirectory, name), 'utf8')) as StoredReceipt;
        if (!entry.receipt?.commandId || !entry.digest) throw new Error('Unreadable receipt');
        this.receipts.set(name.slice(0, -5), entry);
      }
    }
    const scopeDigest = this.scopeDigest(request, scope);
    return [...this.receipts.values()].filter((entry) => entry.scopeDigest === scopeDigest && !entry.acknowledged)
      .sort((a, b) => (b.receipt.observedAt ?? '').localeCompare(a.receipt.observedAt ?? ''));
  }

  private async persist(key: string, receipt: StoredReceipt): Promise<void> {
    if (this.options.receiptDirectory) {
      await fs.mkdir(this.options.receiptDirectory, { recursive: true });
      const file = path.join(this.options.receiptDirectory, `${key}.json`);
      await fs.writeFile(`${file}.tmp`, JSON.stringify(receipt), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
    }
    this.receipts.set(key, receipt);
  }

  private changed(providerId: ProviderId): void {
    this.available.delete(providerId);
    for (const listener of [...this.changeListeners]) {
      try { listener(providerId); } catch { /* A closed screen must not stop the others. */ }
    }
  }

  private async apply(value: unknown, scope: AgentCapabilityScope, signal?: AbortSignal,
    host?: HostContext & { readonly executionRoot: string; readonly projectWorkspaceId?: string }): Promise<AgentCapabilityResult<AgentExtensionReceipt>> {
    if (!scope.canManage) return { ok: false, code: 'forbidden', message: 'Extension management requires permission on the connected PC.' };
    const parsed = AgentExtensionCommandSchema.safeParse(value);
    if (!parsed.success || !path.isAbsolute(scope.workspaceRoot)) return { ok: false, code: 'invalid-input', message: 'The extension request is invalid.' };
    const command: AgentExtensionCommand = parsed.data;
    if (!host && command.workspaceId === AGENT_HOST_SCOPE_ID) return { ok: false, code: 'invalid-input', message: 'Select an active workspace on the connected PC.' };
    if (command.target.startsWith('-') || command.source?.startsWith('-')) return { ok: false, code: 'invalid-input', message: 'An extension source or identifier cannot be a command option.' };
    if (this.options.isUpdating?.(command.providerId)) return UPDATING;
    const executionRoot = host?.executionRoot ?? scope.workspaceRoot;
    const digest = hash(JSON.stringify({ command, workspaceRoot: scope.workspaceRoot, executionRoot, hostId: this.options.hostId }));
    const key = hash(`${this.options.hostId}\0${command.commandId}`);
    const file = this.options.receiptDirectory ? path.join(this.options.receiptDirectory, `${key}.json`) : undefined;
    let existing = this.receipts.get(key);
    if (!existing && file) {
      try { existing = JSON.parse(await fs.readFile(file, 'utf8')) as StoredReceipt; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, code: 'uncertain', message: 'The saved extension receipt cannot be read. Check native provider settings before retrying.' }; }
    }
    if (command.recovery) {
      if (!existing || existing.scopeDigest !== this.scopeDigest(command, scope) || existing.receipt.action !== command.action) return { ok: false, code: 'forbidden', message: 'This receipt is not available in the selected PC workspace.' };
      if (command.recovery === 'acknowledge') {
        try { await this.persist(key, { ...existing, acknowledged: true }); }
        catch { return { ok: false, code: 'unavailable', message: 'The receipt acknowledgement could not be saved.' }; }
      }
      return { ok: true, value: existing.receipt };
    }
    if (existing) return existing.digest === digest
      ? { ok: true, value: existing.receipt }
      : { ok: false, code: 'invalid-input', message: 'This command ID belongs to another request.' };
    const catalog = await this.catalog({ providerId: command.providerId, workspaceId: command.workspaceId, ...(command.sessionId ? { sessionId: command.sessionId } : {}) }, scope, signal, host);
    if (!catalog.ok) return catalog;
    if (catalog.value.extensionReceipts?.some((receipt) => receipt.state === 'uncertain')) return { ok: false, code: 'stale', message: 'An earlier native change needs review. Inspect the saved receipt and PC settings before making another change.' };
    if (catalog.value.revision !== command.expectedRevision) return { ok: false, code: 'stale', message: 'Provider extensions changed. Refresh and review the current settings.' };
    if (!catalog.value.actions.includes(command.action)) return { ok: false, code: 'unsupported', message: 'The installed provider does not support this operation.' };
    if (!['plugin-install', 'marketplace-add', 'mcp-add'].includes(command.action) && !targetExists(catalog.value, command, host?.projectWorkspaceId)) {
      return { ok: false, code: 'invalid-input', message: 'Refresh and select an installed extension in the requested scope.' };
    }
    const selected = this.options.registry.enabledAdapter(this.options.getSnapshot(), command.providerId);
    if (!selected.ok || !selected.value.manageExtension) return { ok: false, code: 'unsupported', message: 'The installed provider cannot manage this extension.' };
    const pending: StoredReceipt = { digest, scopeDigest: this.scopeDigest(command, scope), receipt: { commandId: command.commandId, action: command.action, state: 'uncertain', application: 'new-session', observedAt: new Date().toISOString() } };
    const persist = (receipt: StoredReceipt): Promise<void> => this.persist(key, receipt);
    try { await persist(pending); }
    catch { return { ok: false, code: 'unavailable', message: 'The extension operation receipt could not be saved. No operation was started.' }; }
    try {
      await selected.value.manageExtension(executionRoot, command, signal);
      const applied: StoredReceipt = { ...pending, receipt: { ...pending.receipt, state: 'applied' } };
      await persist(applied);
      return { ok: true, value: applied.receipt };
    } catch {
      return { ok: true, value: pending.receipt };
    } finally {
      this.changed(command.providerId);
    }
  }
}

function hostCapabilityScope(scope: AgentHostScope): AgentCapabilityScope {
  return { workspaceRoot: scope.hostRoot, canManage: scope.canManage, ...(scope.authorityKey ? { authorityKey: scope.authorityKey } : {}) };
}

/**
 * A project install is changed only through the app workspace at its folder; installs in
 * folders the app does not know stay visible but read-only.
 */
function hostItem(item: AgentCapabilityItem, scope: AgentHostScope): AgentCapabilityItem {
  if (item.kind !== 'plugin' || !item.projectPath) return item;
  const workspaceId = scope.workspaceForPath(item.projectPath);
  return workspaceId ? { ...item, workspaceId } : { ...item, actions: [] };
}

function targetExists(catalog: AgentCapabilityCatalog, command: AgentExtensionCommand, projectWorkspaceId: string | undefined): boolean {
  if (command.action.startsWith('marketplace-')) {
    return catalog.marketplaces === undefined
      || catalog.marketplaces.some((marketplace) => marketplace.name === command.target && (marketplace.actions as readonly string[]).includes(command.action));
  }
  return catalog.items.some((item) => item.id === command.target && item.actions.includes(command.action)
    && (command.providerId === 'codex' || !item.scope || item.scope === command.scope)
    && (projectWorkspaceId === undefined || item.workspaceId === projectWorkspaceId));
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
