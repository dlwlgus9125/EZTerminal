import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AgentCapabilitiesRequestSchema, AgentExtensionCommandSchema,
  type AgentCapabilityCatalog, type AgentCapabilityResult, type AgentExtensionReceipt,
} from '../shared/agent-capabilities';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type { AgentProviderRegistry } from './agent-provider-registry';

export interface AgentCapabilityScope {
  readonly workspaceRoot: string;
  readonly canManage: boolean;
  readonly workflowToolsAvailable?: boolean;
  readonly authorityKey?: string;
}
interface StoredReceipt { readonly digest: string; readonly receipt: AgentExtensionReceipt; readonly scopeDigest?: string; readonly acknowledged?: boolean }
export class AgentCapabilityService {
  private serial: Promise<unknown> = Promise.resolve();
  private readonly receipts = new Map<string, StoredReceipt>();
  constructor(private readonly options: {
    readonly registry: Pick<AgentProviderRegistry, 'enabledAdapter'>;
    readonly getSnapshot: () => Pick<DaemonSnapshot, 'providers'>;
    readonly hostId: string;
    readonly receiptDirectory?: string;
  }) {}

  async list(value: unknown, scope: AgentCapabilityScope, signal?: AbortSignal): Promise<AgentCapabilityResult<AgentCapabilityCatalog>> {
    const parsed = AgentCapabilitiesRequestSchema.safeParse(value);
    if (!parsed.success || !path.isAbsolute(scope.workspaceRoot)) return { ok: false, code: 'invalid-input', message: 'Select an active workspace on the connected PC.' };
    const request = parsed.data;
    const selected = this.options.registry.enabledAdapter(this.options.getSnapshot(), request.providerId);
    if (!selected.ok) return { ok: false, code: 'unavailable', message: 'Review and enable this provider on the connected PC.' };
    if (!selected.value.listCapabilities) return { ok: false, code: 'unsupported', message: 'This provider cannot discover extensions before a message.' };
    try {
      const catalog = await selected.value.listCapabilities(scope.workspaceRoot, signal);
      const items = [...catalog.items];
      if (scope.workflowToolsAvailable) items.push({
        id: 'ezterminal-workflow', kind: 'app-skill', name: 'ezterminal-workflow',
        description: 'Read, validate and edit this project’s workflow drafts using the app tools. Running versions and approvals stay unchanged.',
        source: 'EZTerminal', scope: 'project', enabled: true,
        invocation: 'Use the EZTerminal workflow tools to ', actions: [],
      });
      const identity = {
        items: items.map(({ id, kind, source, scope: itemScope, version, enabled, actions }) => ({ id, kind, source, scope: itemScope, version, enabled, actions: [...actions].sort() })).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
        actions: [...catalog.actions].sort(), providerId: request.providerId, workspaceId: request.workspaceId,
        configurationRevision: catalog.configurationRevision,
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

  manage(value: unknown, scope: AgentCapabilityScope, signal?: AbortSignal): Promise<AgentCapabilityResult<AgentExtensionReceipt>> {
    const operation = this.serial.then(() => this.apply(value, scope, signal));
    this.serial = operation.catch(() => undefined);
    return operation;
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

  private async apply(value: unknown, scope: AgentCapabilityScope, signal?: AbortSignal): Promise<AgentCapabilityResult<AgentExtensionReceipt>> {
    if (!scope.canManage) return { ok: false, code: 'forbidden', message: 'Extension management requires permission on the connected PC.' };
    const parsed = AgentExtensionCommandSchema.safeParse(value);
    if (!parsed.success || !path.isAbsolute(scope.workspaceRoot)) return { ok: false, code: 'invalid-input', message: 'The extension request is invalid.' };
    const command = parsed.data;
    if (command.target.startsWith('-') || command.source?.startsWith('-')) return { ok: false, code: 'invalid-input', message: 'An extension source or identifier cannot be a command option.' };
    const digest = hash(JSON.stringify({ command, workspaceRoot: scope.workspaceRoot, hostId: this.options.hostId }));
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
    const catalog = await this.list({ providerId: command.providerId, workspaceId: command.workspaceId, ...(command.sessionId ? { sessionId: command.sessionId } : {}) }, scope, signal);
    if (!catalog.ok) return catalog;
    if (catalog.value.extensionReceipts?.some((receipt) => receipt.state === 'uncertain')) return { ok: false, code: 'stale', message: 'An earlier native change needs review. Inspect the saved receipt and PC settings before making another change.' };
    if (catalog.value.revision !== command.expectedRevision) return { ok: false, code: 'stale', message: 'Provider extensions changed. Refresh and review the current settings.' };
    if (!catalog.value.actions.includes(command.action)) return { ok: false, code: 'unsupported', message: 'The installed provider does not support this operation.' };
    if (!['plugin-install', 'marketplace-add', 'marketplace-remove', 'marketplace-update', 'mcp-add'].includes(command.action)
      && !catalog.value.items.some((item) => item.id === command.target && item.actions.includes(command.action)
        && (command.providerId === 'codex' || !item.scope || item.scope === command.scope))) {
      return { ok: false, code: 'invalid-input', message: 'Refresh and select an installed extension in the requested scope.' };
    }
    const selected = this.options.registry.enabledAdapter(this.options.getSnapshot(), command.providerId);
    if (!selected.ok || !selected.value.manageExtension) return { ok: false, code: 'unsupported', message: 'The installed provider cannot manage this extension.' };
    const pending: StoredReceipt = { digest, scopeDigest: this.scopeDigest(command, scope), receipt: { commandId: command.commandId, action: command.action, state: 'uncertain', application: 'new-session', observedAt: new Date().toISOString() } };
    const persist = (receipt: StoredReceipt): Promise<void> => this.persist(key, receipt);
    try { await persist(pending); }
    catch { return { ok: false, code: 'unavailable', message: 'The extension operation receipt could not be saved. No operation was started.' }; }
    try {
      await selected.value.manageExtension(scope.workspaceRoot, command, signal);
      const applied: StoredReceipt = { ...pending, receipt: { ...pending.receipt, state: 'applied' } };
      await persist(applied);
      return { ok: true, value: applied.receipt };
    } catch {
      return { ok: true, value: pending.receipt };
    }
  }
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
