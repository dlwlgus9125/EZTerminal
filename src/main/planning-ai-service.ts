import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createDaemonCommand, type DaemonCommand, type DaemonTurn } from '../shared/daemon-protocol';
import {
  PlanningAiJobSchema, PlanningAiRequestSchema, planningAiProviderSupported, planningAiProfileChain,
  type PlanningAiResult,
} from '../shared/planning-ai';
import type { PlanningMutationResult, PlanningReference } from '../shared/planning';
import type { AgentProviderRegistry } from './agent-provider-registry';
import type { DaemonCommandRouter } from './daemon-command-router';
import type { DaemonStore } from './daemon-store';
import type { PlanningService } from './planning-service';
import type { ChatStateStoreOptions } from './chat-state-store';
import { SecureAtomicFile } from './secure-atomic-file';
import { AsyncMutationGate } from './async-mutation-gate';
import { planningAiBefore, planningAiFrozenContext, planningAiPrompt, validatePlanningAiProposal } from './planning-ai-scope';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recordSchema = z.object({ job: PlanningAiJobSchema, fingerprint: z.string(), principalId: z.string(), prompt: z.string().max(700_000) }).strict();
const journalSchema = z.object({ version: z.literal(1), records: z.array(recordSchema).max(500) }).strict();
type RecordEntry = z.infer<typeof recordSchema>;
const prefix = 'planning-ai-';

export interface PlanningAiServiceOptions {
  readonly directory: string;
  readonly protector: ChatStateStoreOptions['protector'];
  readonly windowsAcl?: ChatStateStoreOptions['windowsAcl'];
  readonly platform?: NodeJS.Platform;
  readonly planning: Pick<PlanningService, 'read' | 'execute'>;
  readonly daemon: DaemonCommandRouter;
  readonly store: Pick<DaemonStore, 'findCommand'>;
  readonly providers: Pick<AgentProviderRegistry, 'listModels'>;
  readonly resolveProjectRoot: (projectId: string) => string | null | Promise<string | null>;
  readonly wakeQueuedTurns: () => void;
  readonly onChanged?: (projectId: string) => Promise<void>;
  readonly ownsSubproject?: (projectId: string, subprojectId: string, writing: boolean) => Promise<boolean>;
  readonly readFileReference?: (projectId: string, reference: PlanningReference) => Promise<string>;
}

/** Encrypted proposal journal, with generation/receipts owned by the existing daemon. */
export class PlanningAiService {
  private readonly file: SecureAtomicFile;
  private readonly gate = new AsyncMutationGate();
  private records: RecordEntry[] = [];
  private loaded = false;
  private stopped = false;
  private readonly launches = new Map<string, Promise<void>>();
  constructor(private readonly options: PlanningAiServiceOptions) {
    this.file = new SecureAtomicFile(options.directory, 'proposals.bin', { platform: options.platform, windowsAcl: options.windowsAcl, maxBytes: 24 * 1024 * 1024 });
  }
  async init(): Promise<void> {
    if (!this.options.protector.available()) throw new Error('Secure planning proposal storage is unavailable.');
    await this.file.init();
    const text = await this.file.readText();
    if (text !== undefined) {
      const envelope = z.object({ version: z.literal(1), protectedState: z.string() }).strict().parse(JSON.parse(text));
      const bytes = Buffer.from(envelope.protectedState, 'base64');
      if (!bytes.length || bytes.toString('base64') !== envelope.protectedState) throw new Error('Invalid planning proposal ciphertext.');
      this.records = journalSchema.parse(JSON.parse(await this.options.protector.decrypt(bytes))).records;
      const identities = this.records.map(entry => `${entry.job.request.projectId}:${entry.job.request.requestId}`);
      if (new Set(identities).size !== identities.length) throw new Error('Duplicate planning proposal recovery identity.');
    }
    this.loaded = true;
    // Never resubmit on startup. Existing daemon commands/turns reconcile normally.
    this.options.wakeQueuedTurns();
  }
  preparedSessionSettings(sessionId: string) {
    if (!sessionId.startsWith(prefix)) return undefined;
    const entry = this.records.find(record => record.job.sessionId === sessionId);
    return { toolsDisabled: true as const, managedExecution: true as const, ...(entry?.job.request.reasoningEffort ? { reasoningEffort: entry.job.request.reasoningEffort } : {}) };
  }
  canDispatchTurn(turn: DaemonTurn): boolean {
    if (!turn.sessionId.startsWith(prefix)) return true;
    return this.loaded && !this.stopped && this.records.some(entry => entry.job.sessionId === turn.sessionId && ['prepared', 'generating'].includes(entry.job.state));
  }
  async dispose(): Promise<void> { this.stopped = true; await Promise.allSettled([...this.launches.values()]); await this.gate.runExclusive(async () => undefined); }

  async request(value: unknown, principalId: string): Promise<PlanningAiResult> {
    const parsed = PlanningAiRequestSchema.safeParse(value);
    if (!parsed.success) return { ok: false, message: 'Invalid planning AI request.' };
    try {
      return await this.gate.runExclusive(async (): Promise<PlanningAiResult> => {
        if (!this.loaded || this.stopped) throw new Error('Planning AI recovery is unavailable.');
        const query = parsed.data;
        const projectId = query.type === 'start' ? query.request.projectId : query.projectId;
        const subprojectId = query.type === 'start' ? query.request.subprojectId : query.subprojectId;
        if (subprojectId && !await this.options.ownsSubproject?.(projectId, subprojectId, query.type !== 'read')) throw new Error('The subproject is unavailable.');
        if (!await this.options.resolveProjectRoot(projectId)) throw new Error('The requested project is unavailable.');
        if (query.type === 'start') return this.start(query, principalId);
        const entries = this.records.filter(entry => entry.job.request.projectId === projectId && entry.job.request.subprojectId === subprojectId && (!query.requestId || entry.job.request.requestId === query.requestId));
        if (query.requestId && !entries.length) throw new Error('The requested AI proposal is unavailable.');
        if (query.type === 'read') {
          for (const entry of entries) await this.refresh(entry);
          return { ok: true, jobs: entries.map(entry => entry.job) };
        }
        const entry = entries[0];
        await this.refresh(entry);
        return this.apply(entry, principalId);
      });
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'Planning AI request failed.' }; }
  }
  private async persist(): Promise<void> {
    if (!this.options.protector.available()) throw new Error('Secure proposal storage is unavailable.');
    const plaintext = JSON.stringify(journalSchema.parse({ version: 1, records: this.records }));
    if (Buffer.byteLength(plaintext) > 16 * 1024 * 1024) throw new Error('Planning proposal recovery storage is full. Existing records were preserved.');
    const encrypted = Buffer.from(await this.options.protector.encrypt(plaintext));
    if (!encrypted.length) throw new Error('Proposal encryption returned no data.');
    await this.file.writeAtomic(JSON.stringify({ version: 1, protectedState: encrypted.toString('base64') }));
  }
  private async start(query: Extract<z.output<typeof PlanningAiRequestSchema>, { type: 'start' }>, principalId: string): Promise<PlanningAiResult> {
    const request = query.request;
    const fingerprint = hash({ request, principalId });
    const previous = this.records.find(entry => entry.job.request.projectId === request.projectId && entry.job.request.requestId === request.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('This AI request ID already has different contents.');
      await this.refresh(previous);
      // An explicit replay resumes the exact already-persisted daemon commands.
      if (previous.job.state === 'prepared') this.launch(previous);
      return { ok: true, jobs: [previous.job] };
    }
    const provider = this.options.daemon.getSnapshot().providers.find(entry => entry.id === request.providerId && entry.enabled && entry.health === 'ready');
    if (!provider || !planningAiProviderSupported(provider.protocol)) throw new Error('This provider has no verified tool-free planning mode. Select a supported Claude provider. General conversations remain available.');
    const catalog = await this.options.providers.listModels(this.options.daemon.getSnapshot(), provider.id);
    if (!catalog.ok) throw new Error(catalog.message);
    const model = catalog.value.find(entry => entry.id === request.model);
    if (!model || (request.reasoningEffort && !model.reasoningEfforts?.includes(request.reasoningEffort))) throw new Error('The selected model or reasoning setting is unavailable. Choose explicitly; no fallback was used.');
    const planning = await this.options.planning.read(request.projectId, request.subprojectId);
    if (!planning.ok) throw new Error(planning.message);
    if (planning.snapshot.revision !== request.expectedRevision) throw new Error('Planning changed before generation. Refresh before requesting a proposal.');
    const before = planningAiBefore(planning.snapshot, request.target);
    const profileSnapshots = planningAiProfileChain(planning.snapshot, request.target, request.profileId, request.profileVersion);
    const contextSnapshots = await planningAiFrozenContext(planning.snapshot, profileSnapshots, request.contextIds,
      this.options.readFileReference ? reference => this.options.readFileReference!(request.projectId, reference) : undefined);
    const record: RecordEntry = { fingerprint, principalId,
      prompt: planningAiPrompt(planning.snapshot, request.target, before, request.instruction, request.contextIds, profileSnapshots, contextSnapshots),
      job: { request, before, profileSnapshots, contextSnapshots, sessionId: `${prefix}${hash([request.projectId, request.requestId]).slice(0, 32)}`, state: 'prepared', createdAt: new Date().toISOString() } };
    this.records.push(record);
    try { await this.persist(); } catch (error) { this.records.pop(); throw error; }
    this.launch(record);
    return { ok: true, jobs: [record.job] };
  }
  private launch(entry: RecordEntry): void {
    if (this.launches.has(entry.job.sessionId) || this.stopped) return;
    const work = this.dispatch(entry).catch(async error => {
      await this.gate.runExclusive(async () => {
        entry.job = { ...entry.job, state: 'uncertain', message: `Generation delivery is unconfirmed. Read its existing session before creating a new request. ${error instanceof Error ? error.message : ''}`.slice(0, 4000) };
        await this.persist();
      });
    }).finally(() => this.launches.delete(entry.job.sessionId));
    this.launches.set(entry.job.sessionId, work);
    void work.catch(() => undefined);
  }
  private async dispatch(entry: RecordEntry): Promise<void> {
    const { request, sessionId } = entry.job;
    const root = await this.options.resolveProjectRoot(request.projectId);
    if (!root || this.stopped) throw new Error('Project authority is unavailable.');
    const workspaceId = `${sessionId}-workspace`;
    await this.daemonCommand(`${sessionId}-workspace`, 'workspace.create', { workspaceId, projectId: request.projectId, name: 'Planning proposals', kind: 'local', rootPath: root });
    await this.daemonCommand(`${sessionId}-create`, 'agent.create', { sessionId, workspaceId, title: `Planning proposal · ${request.target.id}`, providerId: request.providerId, model: request.model, permissionPreset: 'plan' });
    const receipt = await this.daemonCommand(`${sessionId}-submit`, 'agent.submit', { sessionId, prompt: entry.prompt });
    await this.gate.runExclusive(async () => {
      const turn = this.options.daemon.getSnapshot().turns.find(value => value.sessionId === sessionId && value.commandId === receipt.commandId);
      if (!turn) throw new Error('The proposal turn is not durably registered.');
      entry.job = { ...entry.job, turnId: turn.id, state: 'generating' }; await this.persist();
    });
    this.options.wakeQueuedTurns();
  }
  private async refresh(entry: RecordEntry): Promise<void> {
    if (['ready', 'failed', 'applied'].includes(entry.job.state)) return;
    const turn = this.options.daemon.getSnapshot().turns.find(value => value.sessionId === entry.job.sessionId && (!entry.job.turnId || value.id === entry.job.turnId));
    if (!turn) return;
    if (['failed', 'interrupted'].includes(turn.state)) { entry.job = { ...entry.job, turnId: turn.id, state: 'failed', message: `Generation ${turn.state}. Existing planning was preserved.` }; await this.persist(); return; }
    if (turn.state === 'delivery-uncertain') { entry.job = { ...entry.job, turnId: turn.id, state: 'uncertain', message: 'Provider delivery is uncertain. Reconcile the existing conversation before retrying.' }; await this.persist(); return; }
    if (turn.state !== 'completed') { entry.job = { ...entry.job, turnId: turn.id, state: 'generating' }; return; }
    try {
      const texts = new Map<string, string>(); let cursor = 0; let bytes = 0;
      for (let page = 0; page < 100; page++) {
        const items = this.options.daemon.readTranscript(turn.sessionId, cursor, 500);
        for (const item of items) if (item.turnId === turn.id && item.kind === 'assistant-message' && !item.isSensitive) {
          const key = item.messageId ?? item.id;
          texts.set(key, item.isDelta ? (texts.get(key) ?? '') + item.text : item.text);
          bytes += Buffer.byteLength(item.text); if (bytes > 2 * 1024 * 1024) throw new Error('AI proposal output exceeds the verifiable size limit.');
        }
        if (items.length < 500) break;
        cursor = items.at(-1)!.sequence;
        if (page === 99) throw new Error('AI proposal output exceeded the transcript limit.');
      }
      const output = [...texts.values()].join('\n').trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
      const planning = await this.options.planning.read(entry.job.request.projectId, entry.job.request.subprojectId);
      if (!planning.ok) throw new Error(planning.message);
      if (planning.snapshot.revision !== entry.job.request.expectedRevision) throw new Error('Planning changed during generation. The original remains unchanged; create a fresh proposal.');
      const proposal = validatePlanningAiProposal(planning.snapshot, entry.job.request.target, entry.job.before, JSON.parse(output));
      entry.job = { ...entry.job, turnId: turn.id, proposal, state: 'ready', message: undefined };
    } catch (error) { entry.job = { ...entry.job, turnId: turn.id, state: 'failed', message: (error instanceof Error ? error.message : 'Invalid AI proposal.').slice(0, 4000) }; }
    await this.persist();
  }
  private async apply(entry: RecordEntry, principalId: string): Promise<PlanningAiResult> {
    const { request, proposal } = entry.job;
    if (!proposal || !['ready', 'applied'].includes(entry.job.state)) throw new Error('Only a completed, validated proposal can be applied.');
    const commandId = `${entry.job.sessionId}-apply`;
    let mutation: PlanningMutationResult;
    if (proposal.operation.op === 'profile.put') {
      const proposed = await this.options.planning.execute({ commandId: `${commandId}-propose`, projectId: request.projectId, subprojectId: request.subprojectId, expectedRevision: request.expectedRevision,
        actor: { kind: 'ai', id: entry.job.sessionId }, type: 'profile.propose', payload: { proposalId: `${entry.job.sessionId}-profile`, profileId: request.target.id,
          baseVersion: request.target.revision, proposed: proposal.operation.value, reason: proposal.summary } });
      if (!proposed.ok) return { ok: true, jobs: [entry.job], mutation: proposed };
      mutation = await this.options.planning.execute({ commandId, projectId: request.projectId, subprojectId: request.subprojectId, expectedRevision: proposed.revision, actor: { kind: 'user', id: principalId }, type: 'profile.apply', payload: { proposalId: `${entry.job.sessionId}-profile` } });
    } else {
      mutation = await this.options.planning.execute({ commandId, projectId: request.projectId, subprojectId: request.subprojectId, expectedRevision: request.expectedRevision,
        actor: { kind: 'ai', id: entry.job.sessionId }, type: 'planning.patch', payload: { operations: [proposal.operation], summary: proposal.summary } });
    }
    if (mutation.ok) { entry.job = { ...entry.job, state: 'applied' }; await this.persist(); await this.options.onChanged?.(request.projectId); }
    return { ok: true, jobs: [entry.job], mutation };
  }
  private async daemonCommand(id: string, type: DaemonCommand['type'], payload: unknown) {
    if (this.stopped) throw new Error('Planning AI is stopping.');
    for (let retry = 0; retry < 5; retry++) {
      const commandId = `${id}-${retry}`; const previous = this.options.store.findCommand(commandId);
      if (previous?.receipt && !previous.receipt.ok && previous.receipt.error.code === 'revision-conflict') continue;
      const command = previous?.command ?? createDaemonCommand({ commandId, idempotencyKey: commandId, expectedRevision: this.options.daemon.getSnapshot().revision,
        issuedAt: new Date().toISOString(), principal: { kind: 'desktop', id: 'planning-ai-runtime' }, type, payload } as Parameters<typeof createDaemonCommand>[0]);
      const receipt = previous?.receipt ?? await this.options.daemon.execute(command);
      if (receipt.ok) return receipt;
      if (receipt.error.code !== 'revision-conflict') throw new Error(receipt.error.message);
    }
    throw new Error('Planning AI daemon command could not be reconciled.');
  }
}
