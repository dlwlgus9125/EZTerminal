import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  WorkflowCommandSchema, WorkflowRegistrySchema, WorkflowSubprojectSchema, createWorkflowGraph, validateWorkflowGraph, LEGACY_SUBPROJECT_ID,
  WorkflowPreviewRequestSchema, WorkflowGraphSchema, workflowPrincipalIdentity, type WorkflowPreview, type WorkflowPreviewResult,
  type WorkflowCommand, type WorkflowGraph, type WorkflowPrincipal, type WorkflowRegistry, type WorkflowResult, type WorkflowSubproject,
  type WorkflowNavigationResult, type WorkflowNavigationSnapshot, WorkflowReviewerSchema, type WorkflowRepeat, type WorkflowRepeatStatus, type WorkflowAgentCatalogEntry,
} from '../shared/workflow';
import type { ExecutionRun } from '../shared/planning-execution';
import type { WorkflowConversationContext } from '../shared/workflow-conversation';
import { PlanningSnapshotSchema } from '../shared/planning';
import { copyWorkflowPlanning } from './workflow-planning-copy';
import { flowV17Fields, legacyWorkflowGraph } from '../shared/workflow-protocol-projection';
import { blockingRunOf, changedStageSettings, stageWorking } from '../shared/planning-execution';
import type { CommittedSubproject } from './workflow-stage-binding';
import type { PlanningService } from './planning-service';
import { AsyncMutationGate } from './async-mutation-gate';
import { canonicalTimezone } from './automation-time';
import { repeatConfigDigest } from './workflow-repeat-time';

/**
 * Where a run's own agents belong in the project list: each attempt under the stage it ran,
 * each independent reviewer under the stage it reviewed. A person's links take precedence.
 */
function runSessionLinks(runs: readonly ExecutionRun[]): Array<{ readonly sessionId: string; readonly subprojectId: string; readonly nodeId?: string; readonly scope: 'stage' }> {
  return runs.flatMap(run => {
    const subprojectId = run.preparation.workflow?.subprojectId ?? run.preparation.subprojectId;
    if (!subprojectId) return [];
    const nodeOf = (taskId: string) => run.preparation.workflow?.graph.nodes.some(node => node.id === taskId) ? { nodeId: taskId } : {};
    return [
      ...run.attempts.map(attempt => ({ sessionId: attempt.sessionId, subprojectId, scope: 'stage' as const, ...nodeOf(attempt.taskId) })),
      ...run.reviews.map(review => {
        const attempt = run.attempts.find(entry => entry.attemptId === review.attemptId);
        return { sessionId: review.reviewerSessionId, subprojectId, scope: 'stage' as const, ...(attempt ? nodeOf(attempt.taskId) : {}) };
      }),
    ];
  });
}

/**
 * What a repeating flow runs, as a person confirmed it on this host: the saved subproject without its edit
 * history and bookkeeping, and with 반복 on or off alike. Anything else changed outside this host (a pull,
 * another tool) no longer matches, so the schedule waits for the person (WorkflowRepeatService).
 */
export function repeatContentDigest(subproject: WorkflowSubproject): string {
  const content: Partial<WorkflowSubproject> = { ...subproject, ...(subproject.repeat ? { repeat: { ...subproject.repeat, enabled: true } } : {}) };
  delete content.history; delete content.archivedNodes; delete content.revision; delete content.updatedAt; delete content.createdAt;
  return workflowDigest(content);
}
/** What a launch runs: the flow's content (repeatContentDigest) with its fixed run id and review AI. */
export function launchIntentDigest(contentDigest: string, launch: { readonly runId: string; readonly reviewer: { readonly providerId: string; readonly model: string } }): string {
  return workflowDigest({ contentDigest, runId: launch.runId, reviewer: { providerId: launch.reviewer.providerId, model: launch.reviewer.model } });
}
export type WorkflowLaunchReceipt = { readonly state: 'none' | 'settled' } | { readonly state: 'pending'; readonly intent?: string };
/** How a saved command moves this host's consent for a subproject's 반복 (WorkflowRepeatService.consent). */
export interface WorkflowRepeatConsentChange {
  /** A person saved 반복 itself: consent is `after` (or withdrawn). Otherwise consent follows only from `before`. */
  readonly set: boolean;
  readonly before?: string;
  /** Absent when 반복 is off after the command. */
  readonly after?: string;
  /** repeatConfigDigest of the saved 반복, and whether it can run now (on and active): it arms at this commit. */
  readonly config?: string;
  readonly runnable?: boolean;
  /** The flow the person confirmed (with `set`): what the schedule runs from now on. */
  readonly pinned?: WorkflowSubproject;
}
export function workflowDigest(value: unknown): string {
  const canonical = (entry: unknown): string => Array.isArray(entry) ? `[${entry.map(canonical).join(',')}]`
    : entry !== null && typeof entry === 'object' ? `{${Object.entries(entry).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
      : JSON.stringify(entry);
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export async function loadWorkflowHostId(directory: string): Promise<string> {
  const target = path.join(directory, 'workflow-host-id');
  await fs.mkdir(directory, { recursive: true });
  try { await fs.writeFile(target, randomUUID(), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const value = (await fs.readFile(target, 'utf8')).trim();
  if (!/^[a-f0-9-]{36}$/u.test(value)) throw new Error('The workflow host identity is invalid. Preserve it for recovery.');
  return value;
}
const receipt = z.object({ commandId: z.string(), fingerprint: z.string(), revision: z.number().int(), pending: z.boolean().optional(), runSubproject: WorkflowSubprojectSchema.optional(), copyPlanning: PlanningSnapshotSchema.optional(),
  /** run.launch: the run and review AI fixed when it was first received; a retry replays exactly this. */
  launch: z.object({ runId: z.string(), reviewer: WorkflowReviewerSchema }).strict().optional(),
  /** A request that failed for good (its retry answers the same). */
  failed: z.object({ error: z.string().max(100), message: z.string().max(4_000) }).strict().optional() }).strict();
const fileSchema = z.object({ version: z.literal(1), registry: WorkflowRegistrySchema, receipts: z.array(receipt), integrity: z.string() }).strict();
type WorkflowFile = z.infer<typeof fileSchema>;
const MAX_BYTES = 64 * 1024 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const failure = (error: string, message: string, revision?: number): Extract<WorkflowResult, { ok: false }> => ({ ok: false, error, message, ...(revision === undefined ? {} : { revision }) });
const wrap = (registry: WorkflowRegistry, receipts: WorkflowFile['receipts']): WorkflowFile => ({ version: 1, registry, receipts, integrity: workflowDigest({ registry, receipts }) });

/** A host with saved agents sends its list, empty too (phones tell "no agents" from an older PC by its absence). */
function agentCatalogOf(agents: readonly WorkflowAgentCatalogEntry[] | undefined): { agentCatalog?: WorkflowAgentCatalogEntry[] } {
  return agents ? { agentCatalog: agents.slice(0, 50).map(agent => ({ id: agent.id, name: agent.name, providerId: agent.providerId,
    ...(agent.model ? { model: agent.model } : {}), ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}), permissionPreset: agent.permissionPreset })) } : {};
}
function repeatStatusOf(status: Readonly<Record<string, WorkflowRepeatStatus>> | undefined): { repeatStatus?: Record<string, WorkflowRepeatStatus> } {
  return status && Object.keys(status).length ? { repeatStatus: structuredClone({ ...status }) } : {};
}
/** A subproject's saved 반복 and what decides whether it runs (WorkflowService.repeatSources). */
export interface WorkflowRepeatSource {
  readonly subprojectId: string;
  readonly revision: number;
  readonly status: WorkflowSubproject['status'];
  readonly repeat: WorkflowRepeat;
  readonly reviewer?: { readonly providerId: string; readonly model: string };
  /** repeatContentDigest of the saved subproject: what this host's consent must match. */
  readonly contentDigest: string;
  /** The saved flow as the schedule would pin it (no edit history). */
  readonly pinnable: WorkflowSubproject;
}
/** The flow a person confirmed for 반복 (decision 8): what the schedule runs until they confirm a newer one. */
export function repeatPin(subproject: WorkflowSubproject): WorkflowSubproject {
  return { ...structuredClone(subproject), history: [], archivedNodes: [] };
}
export interface WorkflowServiceOptions {
  readonly hostId: string;
  readonly resolveProjectRoot: (projectId: string) => string | null | undefined | Promise<string | null | undefined>;
  /** Read-only navigation may retain an archived project's recorded location. */
  readonly resolveNavigationRoot?: WorkflowServiceOptions['resolveProjectRoot'];
  readonly planning: Pick<PlanningService, 'read'> & Partial<Pick<PlanningService, 'importSnapshot'>>;
  readonly runs: (projectId: string) => readonly ExecutionRun[];
  readonly session: (sessionId: string) => { projectId: string; managed: boolean } | undefined;
  readonly managedSessions?: (projectId: string) => readonly string[];
  /** What the host's repeat schedule did and will do, per subproject with a repeat (protocol v17), for the registry being answered. */
  readonly repeatStatus?: (registry: WorkflowRegistry) => Readonly<Record<string, WorkflowRepeatStatus>> | undefined;
  /** The PC's saved agents (Settings › AI › 에이전트), sent with each reply so a phone can place them on stages. */
  readonly agentCatalog?: () => readonly WorkflowAgentCatalogEntry[];
  /** After a command or a restore saved a new registry (the repeat schedule arms from it at once). */
  readonly onCommitted?: (projectId: string) => void;
  /**
   * After a saved command changed a subproject with 반복 (under the project gate, so the schedule never reads
   * between the save and this): a person's own 반복 save sets this host's consent, any other edit made through
   * this host moves it along (see WorkflowRepeatService.consent). A failure leaves the flow saved and unconfirmed.
   */
  readonly repeatConsent?: (projectId: string, subprojectId: string, change: WorkflowRepeatConsentChange) => Promise<void>;
  readonly continuationSource?: (sessionId: string) => string | undefined;
  /**
   * `transient` marks a failure whose outcome is not settled (the host or a provider was unreachable, or
   * the reply was lost): the request stays pending and its retry replays it. Any other failure is final.
   */
  readonly executeRun?: (command: WorkflowCommand, subproject: WorkflowSubproject, principal: WorkflowPrincipal) => Promise<{ ok: true } | { ok: false; error: string; message: string; transient?: true }>;
  /**
   * Runs `work` under the execution gate. A flow edit checks which stages are working and saves inside
   * it, so a stage cannot start between that check and the save (the order is always workflow gate, then
   * execution gate; the execution side never waits for the workflow gate).
   */
  readonly executionGate?: <T>(work: () => Promise<T>) => Promise<T>;
  /** The provider and model a project conversation runs on: its default review AI for a launch it sends. */
  readonly conversationReviewer?: (sessionId: string) => { readonly providerId: string; readonly model: string } | undefined;
  readonly now?: () => Date;
}

/** One host-owned command boundary for UI and AI. It never derives scope from a selected screen. */
export class WorkflowService {
  private readonly previews = new Map<string, WorkflowPreview>();
  private readonly discardedPreviews = new Map<string, number>();
  private readonly previewReceipts = new Map<string, string>();
  private readonly gates = new Map<string, AsyncMutationGate>();
  private readonly observed = new Map<string, string | null>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly navigationCache = new Map<string, { signature: string; snapshot: WorkflowNavigationSnapshot }>();
  constructor(private readonly options: WorkflowServiceOptions) {}

  async preview(value: unknown): Promise<WorkflowPreviewResult> {
    const parsed = WorkflowPreviewRequestSchema.safeParse(value);
    if (!parsed.success) return { ok: false, message: 'Invalid workflow preview request.' };
    const request = parsed.data;
    return this.exclusive(request.projectId, async (): Promise<WorkflowPreviewResult> => {
    try { await this.target(request.projectId); } catch { return { ok: false, message: 'The project is unavailable.' }; }
    const previous = this.previews.get(request.previewId);
    if (previous && previous.projectId !== request.projectId) return { ok: false, message: 'This preview belongs to another project.' };
    if (request.action === 'open') {
      const session = this.options.session(request.sessionId);
      if (!session || session.projectId !== request.projectId || session.managed) return { ok: false, message: 'Select an ordinary conversation in this project.' };
      if (previous && previous.sessionId !== request.sessionId) return { ok: false, message: 'This preview is already bound to another conversation.' };
      if ([...this.previews.values()].some(entry => entry.sessionId === request.sessionId && entry.id !== request.previewId)) return { ok: false, message: 'This conversation already owns another creation preview.' };
      if (!previous) this.previews.set(request.previewId, { id: request.previewId, projectId: request.projectId, sessionId: request.sessionId, revision: this.discardedPreviews.get(request.previewId) ?? 0, graph: request.graph });
    }
    if (request.action === 'discard' && previous) { this.discardedPreviews.set(request.previewId, previous.revision + 1); this.previews.delete(request.previewId); }
    return { ok: true, preview: structuredClone(this.previews.get(request.previewId) ?? null) };
    });
  }
  previewForSession(sessionId: string): WorkflowPreview | undefined { return structuredClone([...this.previews.values()].find(entry => entry.sessionId === sessionId)); }
  async editPreview(sessionId: string, value: unknown): Promise<WorkflowPreviewResult> {
    const parsed = z.object({ commandId: z.string().min(1).max(160), previewId: z.string(), expectedRevision: z.number().int().nonnegative(), graph: WorkflowGraphSchema }).strict().safeParse(value);
    if (!parsed.success) return { ok: false, message: 'Invalid preview edit.' };
    const owner = this.options.session(sessionId); if (!owner) return { ok: false, message: 'The conversation is unavailable.' };
    return this.exclusive(owner.projectId, async (): Promise<WorkflowPreviewResult> => {
    try { await this.target(owner.projectId); } catch { return { ok: false, message: 'The project is unavailable.' }; }
    const preview = this.previews.get(parsed.data.previewId);
    const session = this.options.session(sessionId);
    if (!preview || preview.sessionId !== sessionId || !session || session.projectId !== preview.projectId || session.managed) return { ok: false, message: 'This conversation has no matching creation preview.' };
    if (parsed.data.expectedRevision < (this.discardedPreviews.get(preview.id) ?? 0)) return { ok: false, message: 'This edit belongs to a discarded preview. Read the newly bound draft.' };
    const key = `${preview.id}:${parsed.data.commandId}`; const fingerprint = workflowDigest({ sessionId, ...parsed.data }); const prior = this.previewReceipts.get(key);
    if (prior) return prior === fingerprint ? { ok: true, preview: structuredClone(preview) } : { ok: false, message: 'This preview command ID belongs to different contents.' };
    if (preview.revision !== parsed.data.expectedRevision) return { ok: false, message: 'The preview changed. Read it again before editing.' };
    const graph = parsed.data.graph;
    if (new Set(graph.nodes.map(node => node.id)).size !== graph.nodes.length || new Set(graph.edges.map(edge => edge.id)).size !== graph.edges.length) return { ok: false, message: 'Node and edge IDs must be unique.' };
    const next = { ...preview, revision: preview.revision + 1, graph }; this.previews.set(preview.id, next);
    this.previewReceipts.set(key, fingerprint);
    return { ok: true, preview: structuredClone(next) };
    });
  }

  read(projectId: string): Promise<WorkflowResult> {
    return this.exclusive(projectId, async () => {
      try { const loaded = await this.load(projectId); return this.result(loaded.file.registry); }
      catch (error) { return this.error(error); }
    });
  }

  navigation(projectId: string): Promise<WorkflowNavigationResult> {
    return this.exclusive(projectId, async () => {
      try {
        const target = await this.target(projectId, true);
        const stat = await fs.stat(target).catch(error => { if (missing(error)) return null; throw error; });
        // A run's stage and review agents fold under their stage; runs change without the registry file.
        const runs = this.options.runs(projectId);
        const runKey = runs.map(run => `${run.runId}:${run.attempts.length}:${run.reviews.length}`).join(',');
        const signature = stat ? `${stat.mtimeMs}:${stat.size}:${this.observed.get(target) ?? ''}:${runKey}` : 'missing';
        const cached = this.navigationCache.get(projectId);
        if (stat && cached?.signature === signature) return { ok: true, snapshot: structuredClone(cached.snapshot) };
        const loaded = await this.load(projectId, true); const registry = loaded.file.registry;
        const snapshot: WorkflowNavigationSnapshot = { projectId, registryRevision: registry.registryRevision,
          subprojects: registry.subprojects.map(owner => ({ id: owner.id, title: owner.title, status: owner.status, updatedAt: owner.updatedAt,
            stages: [...owner.graph.nodes.map(node => ({ id: node.id, title: node.title, archived: false })),
              ...owner.archivedNodes.map(node => ({ id: node.id, title: node.title, archived: true }))] })),
          sessionLinks: [...new Map([...runSessionLinks(runs), ...(registry.historicalSessionLinks ?? []), ...registry.sessionLinks].map(link => [link.sessionId, link])).values()].map(link => ({ sessionId: link.sessionId, subprojectId: link.subprojectId,
            scope: link.scope, ...(link.nodeId ? { nodeId: link.nodeId } : {}) })),
        };
        this.navigationCache.set(projectId, { signature, snapshot });
        return { ok: true, snapshot: structuredClone(snapshot) };
      } catch (error) { return this.error(error); }
    });
  }

  /** Explicit history continuation retains the exact saved stage reference; it is not a refresh. */
  continueConversation(projectId: string, sourceSessionId: string, sessionId: string): Promise<{ ok: true } | { ok: false; error: string; message: string }> {
    return this.exclusive(projectId, async () => {
      try {
        const loaded = await this.load(projectId); const registry = loaded.file.registry;
        const source = this.conversationLink(registry, sourceSessionId);
        if (!source) return { ok: true };
        const existing = registry.sessionLinks.find(link => link.sessionId === sessionId);
        if (existing) return existing.subprojectId === source.subprojectId && existing.nodeId === source.nodeId ? { ok: true }
          : { ok: false, error: 'conflict', message: 'The resumed conversation already belongs to another stage.' };
        const target = this.options.session(sessionId);
        const owner = registry.subprojects.find(item => item.id === source.subprojectId);
        if (!target || target.projectId !== projectId || target.managed || !owner || owner.status === 'archived'
          || (source.nodeId && !owner.graph.nodes.some(node => node.id === source.nodeId))) return { ok: false, error: 'not-found', message: 'Restore the original workflow and stage before continuing.' };
        registry.sessionLinks.push({ ...structuredClone(source), sessionId, linkedAt: (this.options.now?.() ?? new Date()).toISOString() });
        registry.registryRevision += 1;
        await this.write(loaded.target, wrap(registry, loaded.file.receipts), loaded.bytesHash);
        return { ok: true };
      } catch (error) { return this.error(error); }
    });
  }

  async owns(projectId: string, subprojectId: string, writing = false): Promise<boolean> {
    const result = await this.read(projectId);
    return result.ok && result.snapshot.subprojects.some(entry => entry.id === subprojectId && (!writing || entry.status !== 'archived'));
  }
  /** The last committed version of one subproject, for the execution side (no workflow gate). */
  async committedSubproject(projectId: string, subprojectId: string): Promise<CommittedSubproject> {
    try {
      const subproject = (await this.readCommitted(projectId)).subprojects.find(entry => entry.id === subprojectId);
      return subproject ? { ok: true, subproject } : { ok: false, reason: 'missing' };
    } catch { return { ok: false, reason: 'unreadable' }; }
  }
  /** `owns` for callers holding the execution gate: reads the committed file without this service's gate. */
  async ownsCommitted(projectId: string, subprojectId: string, writing = false): Promise<boolean> {
    try {
      const registry = await this.readCommitted(projectId);
      return registry.subprojects.some(entry => entry.id === subprojectId && (!writing || entry.status !== 'archived'));
    } catch { return false; }
  }
  // The daemon asks these two while a stage or review prompt is being submitted, which can happen under
  // the execution gate: they read the committed file and never wait for this service's gate.
  async conversationWritable(projectId: string, sessionId: string): Promise<boolean> {
    let registry: WorkflowRegistry;
    try { registry = await this.readCommitted(projectId); } catch { return false; }
    const link = this.conversationLink(registry, sessionId);
    if (!link) return true;
    const owner = registry.subprojects.find(entry => entry.id === link.subprojectId);
    return Boolean(owner && owner.status !== 'archived' && (!link.nodeId || owner.graph.nodes.some(node => node.id === link.nodeId)));
  }
  async conversationContext(projectId: string, sessionId: string): Promise<WorkflowConversationContext | undefined> {
    let registry: WorkflowRegistry;
    try { registry = await this.readCommitted(projectId); }
    catch (error) { throw new Error(error instanceof Error ? error.message : 'Workflow state is unavailable.'); }
    const link = this.conversationLink(registry, sessionId);
    if (!link || link.scope !== 'stage') return undefined;
    if (!link.referenceSnapshot) throw new Error('Refresh the saved stage references before sending.');
    return structuredClone(link.referenceSnapshot);
  }
  private conversationLink(registry: WorkflowRegistry, sessionId: string): WorkflowRegistry['sessionLinks'][number] | undefined {
    const seen = new Set<string>(); let candidate: string | undefined = sessionId;
    while (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      const link = registry.sessionLinks.find(entry => entry.sessionId === candidate);
      if (link) return link;
      candidate = this.options.continuationSource?.(candidate);
    }
    return undefined;
  }
  private stageReferences(projectId: string, owner: WorkflowSubproject, nodeId: string): WorkflowConversationContext {
    const node = owner.graph.nodes.find(entry => entry.id === nodeId)!;
    const references: WorkflowConversationContext['references'] = node.inputs.map(input => {
      const source = owner.graph.nodes.find(entry => entry.id === input.nodeId);
      if (!source) throw new Error('Resolve the missing stage reference before linking this conversation.');
      if (input.kind === 'document') return { nodeId: source.id, kind: 'document', title: source.title, text: source.document };
      const run = [...this.options.runs(projectId)].reverse().find(candidate => candidate.preparation.workflow?.subprojectId === owner.id
        && candidate.tasks.some(task => task.taskId === source.id && task.state === 'completed'));
      const task = run?.tasks.find(entry => entry.taskId === source.id);
      const attempt = run?.attempts.find(entry => entry.attemptId === task?.currentAttemptId);
      const review = run?.reviews.find(entry => entry.attemptId === attempt?.attemptId && entry.decision === 'approve');
      if (!attempt || !review) throw new Error('The selected result reference has no accepted execution result yet.');
      return { nodeId: source.id, kind: 'result', title: source.title, runId: run!.runId, attemptId: attempt.attemptId,
        text: JSON.stringify({ summary: attempt.summary, artifacts: attempt.artifacts, review: review.detail }) };
    });
    const content = { projectId, subprojectId: owner.id, nodeId, graphRevision: owner.revision, title: node.title, document: node.document, instructions: node.instructions, references };
    if (Buffer.byteLength(JSON.stringify(content)) > 600 * 1024) throw new Error('The stage references exceed the message context limit. Reduce the selected references.');
    return { ...content, fingerprint: workflowDigest(content) };
  }

  /**
   * `required.launchIntent` (the repeat schedule): a run.launch runs only if what it would run (the flow content and
   * the fixed run id and review AI, launchIntentDigest) is exactly that, checked here under the project gate right
   * before its receipt is written or replayed. Otherwise nothing is recorded or run ('flow-changed').
   */
  execute(value: unknown, principal: WorkflowPrincipal, required?: { readonly launchIntent?: string; readonly pinned?: WorkflowSubproject }): Promise<WorkflowResult> {
    const parsed = WorkflowCommandSchema.safeParse(value);
    if (!parsed.success) return Promise.resolve(failure('invalid-command', 'The workflow command is invalid.'));
    const command = parsed.data;
    return this.exclusive(command.projectId, async () => {
      try {
        if (command.hostId !== this.options.hostId) return failure('wrong-host', 'This command belongs to another execution host. Reconnect and read its state.');
        let loaded = await this.load(command.projectId);
        // A launch retried after reading newer state is still the same request.
        const fingerprint = workflowDigest({ command: command.type === 'run.launch' ? { ...command, expectedRevision: undefined } : command, principal: workflowPrincipalIdentity(principal) });
        const previous = loaded.file.receipts.find(entry => entry.commandId === command.commandId);
        if (previous && previous.fingerprint !== fingerprint) return failure('command-conflict', 'This command ID already belongs to a different edit.');
        if (previous?.failed) return failure(previous.failed.error, previous.failed.message);
        if (previous && !previous.pending) return this.result(loaded.file.registry, command.commandId, true);
        const registry = structuredClone(loaded.file.registry);
        const subproject = registry.subprojects.find(entry => entry.id === command.subprojectId);
        const expected = command.type === 'subproject.create' ? registry.registryRevision : subproject?.revision;
        if (expected === undefined) return failure('not-found', 'Choose an existing workflow explicitly.');
        if (!previous?.pending && command.expectedRevision !== expected) return failure('revision-conflict', 'The workflow changed. Read the latest changes before applying this edit.', expected);
        // The repeat schedule only runs the saved flow (under the host's own launch, see PlanningRunService).
        if (principal.kind === 'schedule' && command.type !== 'run.launch') return failure('user-required', 'A repeat schedule can only run a flow.');
        if (principal.kind === 'ai') {
          const source = principal.sessionId && this.options.session(principal.sessionId);
          if (!source || source.projectId !== command.projectId || source.managed) return failure('forbidden', 'An ordinary conversation in this project is required for flow editing.');
          if (this.previewForSession(principal.sessionId!)) return failure('preview-only', 'This conversation is editing a creation preview. Use preview_workflow; the user will explicitly create the workflow.');
          const linked = registry.sessionLinks.find(entry => entry.sessionId === principal.sessionId);
          if (linked && (linked.scope !== 'flow-edit' || linked.subprojectId !== command.subprojectId)) return failure('forbidden', 'Use a workflow editing conversation for this workflow. Stage discussions do not grant graph editing authority.');
          // An agent may also run the flow; approvals, integration, ownership and archive stay with the person.
          if (!['subproject.create', 'workflow.patch', 'workflow.undo', 'run.prepare', 'run.launch', 'run.start', 'run.pause', 'run.resume', 'run.cancel'].includes(command.type)) return failure('user-required', 'Approvals, integration, ownership and archive decisions require an explicit user command.');
        }
        if (subproject?.status === 'archived' && !(command.type === 'subproject.update' && command.payload.status === 'active') && command.type !== 'subproject.copy' && command.type !== 'session.unlink') return failure('archived', 'Restore the workflow before editing it.');
        const now = (this.options.now?.() ?? new Date()).toISOString();
        let lockedEdit: (() => WorkflowResult | null) | undefined;
        const actor = { kind: principal.kind === 'ai' ? 'ai' as const : 'user' as const, id: principal.id, ...(principal.sessionId ? { sessionId: principal.sessionId } : {}) };
        if (command.type === 'subproject.create') {
          let createdGraph = command.payload.graph;
          if (command.payload.previewId) {
            const preview = this.previews.get(command.payload.previewId);
            // A v16 reader saw the preview without its v17 fields: it confirms that reduced view, and the
            // flow is created from the host's own preview so nothing it could not see is lost.
            const confirmed = (graph: WorkflowGraph | undefined) => Boolean(preview && graph && (workflowDigest(preview.graph) === workflowDigest(graph)
              || principal.reducedFlowView && workflowDigest(legacyWorkflowGraph(preview.graph, principal.flowViewProtocol ?? 16)) === workflowDigest(graph)));
            if (!preview || preview.projectId !== command.projectId || preview.revision !== command.payload.previewRevision
              || !confirmed(command.payload.graph)) return failure('preview-conflict', 'The creation preview changed or was discarded. Review the current preview before creating.');
            createdGraph = structuredClone(preview.graph);
          }
          if (registry.subprojects.some(entry => entry.id === command.payload.id) || command.payload.id === LEGACY_SUBPROJECT_ID) return failure('conflict', 'This workflow ID is already reserved.');
          registry.subprojects.push({ id: command.payload.id, title: command.payload.title, goal: command.payload.goal, status: 'active', revision: 0,
            createdAt: now, updatedAt: now, presetId: command.payload.presetId,
            graph: createdGraph ?? createWorkflowGraph(command.payload.presetId, command.payload.id), history: [], archivedNodes: [] });
          registry.registryRevision += 1;
        } else if (command.type === 'subproject.copy') {
          if (registry.subprojects.some(entry => entry.id === command.payload.id) || command.payload.id === LEGACY_SUBPROJECT_ID) return failure('conflict', 'Choose a new workflow identity.');
          if (!this.options.planning.importSnapshot) return failure('unavailable', 'Planning copy storage is unavailable.');
          const source = previous?.runSubproject ?? subproject!;
          let copyPlanning = previous?.copyPlanning;
          if (!copyPlanning) {
            const planning = await this.options.planning.read(command.projectId, source.id); if (!planning.ok) return failure(planning.error, planning.message);
            copyPlanning = copyWorkflowPlanning(planning.snapshot, command.payload.id);
            await this.write(loaded.target, wrap(registry, [...loaded.file.receipts, { commandId: command.commandId, fingerprint, revision: source.revision, pending: true, runSubproject: source, copyPlanning }]), loaded.bytesHash);
            loaded = await this.load(command.projectId);
          }
          const copied = await this.options.planning.importSnapshot(command.projectId, copyPlanning, command.payload.id);
          if (!copied.ok) { const existing = await this.options.planning.read(command.projectId, command.payload.id); if (!existing.ok || workflowDigest(existing.snapshot) !== workflowDigest(copyPlanning)) return failure(copied.error, copied.message); }
          const nodeIds = new Map(source.graph.nodes.map(node => [node.id, `copy-${workflowDigest([command.payload.id, node.id]).slice(0, 32)}`]));
          const remapNode = (id: string) => nodeIds.get(id) ?? `copy-${workflowDigest([command.payload.id, id]).slice(0, 32)}`;
          const graph = { ...structuredClone(source.graph), entryNodeId: source.graph.entryNodeId ? remapNode(source.graph.entryNodeId) : null,
            nodes: source.graph.nodes.map(node => ({ ...structuredClone(node), id: remapNode(node.id), ...(node.condition ? { condition: { ...node.condition, sourceNodeId: remapNode(node.condition.sourceNodeId) } } : {}), inputs: node.inputs.map(input => ({ ...input, nodeId: remapNode(input.nodeId) })) })),
            edges: source.graph.edges.map(edge => ({ ...edge, id: `copy-${workflowDigest([command.payload.id, edge.id]).slice(0, 32)}`, from: remapNode(edge.from), to: remapNode(edge.to) })) };
          // A copy never starts repeating on its own: 반복 comes along off.
          registry.subprojects.push({ ...structuredClone(source), id: command.payload.id, title: command.payload.title, status: 'active', revision: 0, createdAt: now, updatedAt: now, graph, history: [], archivedNodes: [], legacyPlanning: undefined,
            ...(source.repeat ? { repeat: { ...source.repeat, enabled: false } } : {}) });
          registry.registryRevision += 1;
        } else if (command.type === 'subproject.update') {
          if (command.payload.status && command.payload.status !== 'active' && this.options.runs(command.projectId).some(run => (run.preparation.subprojectId ?? run.preparation.workflow?.subprojectId) === subproject!.id && !['completed', 'cancelled'].includes(run.state))) {
            return failure('active-run', 'Finish or resolve the active execution before completing or archiving this workflow.');
          }
          // 반복 names an IANA zone (kept canonical) and, to be on, the review AI it runs with.
          let repeat = command.payload.repeat;
          if (repeat) {
            try { repeat = { ...repeat, timezone: canonicalTimezone(repeat.timezone) }; } catch (error) { return failure('invalid-command', error instanceof Error ? error.message : String(error)); }
            if (repeat.enabled && !(command.payload.runSettings ?? subproject!.runSettings)?.reviewer) return failure('missing-reviewer', 'Choose the review AI for this flow before turning on 반복.');
            // Only a person saves 반복 (the schedule and agents cannot send subproject.update): their consent is this host's.
            if (repeat.enabled && !this.options.repeatConsent) return failure('unavailable', 'This host cannot run 반복.');
          }
          Object.assign(subproject!, command.payload, repeat ? { repeat } : {}); subproject!.revision += 1; subproject!.updatedAt = now; registry.registryRevision += 1;
        } else if (command.type === 'workflow.patch' || command.type === 'workflow.undo') {
          const before = structuredClone(subproject!.graph);
          // A stage that is working right now keeps its settings until it finishes (its run already uses
          // them); moving it on the canvas or changing other stages stays possible.
          lockedEdit = () => {
            const working = new Set(this.options.runs(command.projectId).filter(run => run.preparation.workflow?.subprojectId === subproject!.id
              && run.startedAt && !['completed', 'cancelled'].includes(run.state))
              .flatMap(run => run.tasks.filter(task => stageWorking(run, task.taskId)).map(task => task.taskId)));
            const locked = [...working].find(id => { const old = before.nodes.find(node => node.id === id); const next = subproject!.graph.nodes.find(node => node.id === id);
              return old && next && changedStageSettings(old, next).length > 0; });
            return locked ? failure('stage-locked', 'This stage is working now. Change its settings after it finishes; they apply from then on.') : null;
          };
          const v17Before = flowV17Fields(subproject!, principal.flowViewProtocol ?? 16);
          let graph; let undoOf: string | undefined; let summary: string;
          if (command.type === 'workflow.undo') {
            const change = subproject!.history.find(entry => entry.id === command.payload.changeId);
            if (!change) return failure('not-found', 'This graph change is unavailable.');
            graph = structuredClone(before);
            for (const key of ['nodes', 'edges'] as const) {
              const changedIds = new Set([...change.before[key], ...change.after[key]].filter(entry =>
                workflowDigest(change.before[key].find(old => old.id === entry.id) ?? null) !== workflowDigest(change.after[key].find(next => next.id === entry.id) ?? null)).map(entry => entry.id));
              for (const id of changedIds) {
                if (workflowDigest(graph[key].find(entry => entry.id === id) ?? null) !== workflowDigest(change.after[key].find(entry => entry.id === id) ?? null)) return failure('revision-conflict', 'A later edit changed the same stage or connection. Review it before undoing.', subproject!.revision);
              }
              if (key === 'nodes') graph.nodes = [...graph.nodes.filter(entry => !changedIds.has(entry.id)), ...structuredClone(change.before.nodes.filter(entry => changedIds.has(entry.id)))];
              else graph.edges = [...graph.edges.filter(entry => !changedIds.has(entry.id)), ...structuredClone(change.before.edges.filter(entry => changedIds.has(entry.id)))];
            }
            if (change.before.entryNodeId !== change.after.entryNodeId) {
              if (graph.entryNodeId !== change.after.entryNodeId) return failure('revision-conflict', 'A later edit changed the starting stage.', subproject!.revision);
              graph.entryNodeId = change.before.entryNodeId;
            }
            undoOf = change.id; summary = `Undo ${change.summary}`;
          } else { graph = command.payload.graph; summary = command.payload.summary; }
          if (new Set(graph.nodes.map(node => node.id)).size !== graph.nodes.length || new Set(graph.edges.map(edge => edge.id)).size !== graph.edges.length) return failure('invalid-command', 'Stable node and edge IDs must be unique.');
          const restoring = command.type === 'workflow.undo';
          if (!restoring && graph.nodes.some(node => !before.nodes.some(old => old.id === node.id) && subproject!.archivedNodes.some(old => old.id === node.id))) return failure('reserved-node', 'A removed stage ID cannot be reused for a different stage. Undo the deletion to restore it.');
          for (const removed of before.nodes.filter(node => !graph.nodes.some(next => next.id === node.id))) {
            subproject!.archivedNodes = [...subproject!.archivedNodes.filter(node => node.id !== removed.id), removed];
          }
          subproject!.archivedNodes = subproject!.archivedNodes.filter(node => !graph.nodes.some(active => active.id === node.id));
          subproject!.graph = structuredClone(graph);
          // An older reader sees a reduced view without the fields it cannot parse; its edit must not silently drop or change them.
          if (principal.reducedFlowView && flowV17Fields(subproject!, principal.flowViewProtocol ?? 16) !== v17Before) return failure('unsupported', 'Update the Android app to edit this flow: it uses settings this app version cannot show.');
          subproject!.revision += 1; subproject!.updatedAt = now;
          subproject!.history.push({ id: command.commandId, commandId: command.commandId, revision: subproject!.revision, createdAt: now, actor, summary, before, after: structuredClone(graph), ...(undoOf ? { undoOf } : {}) });
        } else if (command.type === 'session.link' || command.type === 'session.unlink' || command.type === 'session.refresh') {
          const session = this.options.session(command.payload.sessionId);
          if (!session || session.projectId !== command.projectId || session.managed) return failure('forbidden', 'Only ordinary conversations in this project can be linked. Execution and reviewer ownership is immutable.');
          const previousLink = registry.sessionLinks.find(link => link.sessionId === command.payload.sessionId);
          if (previousLink && previousLink.subprojectId !== subproject!.id) return failure('conflict', 'This conversation already belongs to another workflow. Reference it without moving its history.');
          if (command.type === 'session.refresh') {
            if (!previousLink?.nodeId || previousLink.scope !== 'stage' || !subproject!.graph.nodes.some(node => node.id === previousLink.nodeId)) return failure('not-found', 'This conversation has no active stage references to refresh.');
            previousLink.referenceSnapshot = this.stageReferences(command.projectId, subproject!, previousLink.nodeId); previousLink.graphRevision = subproject!.revision;
          } else if (command.type === 'session.link') {
            if (command.payload.scope === 'stage' && !subproject!.graph.nodes.some(node => node.id === command.payload.nodeId)) return failure('not-found', 'Select an existing stage.');
            if (command.payload.scope === 'flow-edit' && command.payload.nodeId) return failure('invalid-command', 'Workflow editing targets the whole workflow.');
            registry.sessionLinks = [...registry.sessionLinks.filter(link => link.sessionId !== command.payload.sessionId), {
              ...command.payload, subprojectId: subproject!.id, linkedAt: now, graphRevision: subproject!.revision,
              ...(command.payload.scope === 'stage' ? { referenceSnapshot: this.stageReferences(command.projectId, subproject!, command.payload.nodeId!) } : {}),
            }];
          } else registry.sessionLinks = registry.sessionLinks.filter(link => link.sessionId !== command.payload.sessionId);
          subproject!.revision += 1; subproject!.updatedAt = now;
        } else {
          if (!this.options.executeRun) return failure('unavailable', 'The execution authority is unavailable.');
          let launch = previous?.launch;
          // 반복 runs the flow a person confirmed (decision 8), not edits saved after it.
          const runSource = previous?.runSubproject ?? (command.type === 'run.launch' && principal.kind === 'schedule' && required?.pinned?.id === subproject!.id
            ? { ...repeatPin(required.pinned), revision: subproject!.revision, history: subproject!.history, archivedNodes: subproject!.archivedNodes, repeat: subproject!.repeat }
            : subproject!);
          if (command.type === 'run.prepare' || command.type === 'run.launch') {
            const issues = validateWorkflowGraph(runSource.graph, true);
            if (issues.length) return { ok: false, error: 'invalid-graph', message: 'Resolve the highlighted stages before preparing this execution.', issues };
          } else {
            const run = this.options.runs(command.projectId).find(entry => entry.runId === command.payload.runId);
            const ownerId = command.type === 'run.cancel' ? run?.preparation.subprojectId ?? run?.preparation.workflow?.subprojectId : run?.preparation.workflow?.subprojectId;
            if (ownerId !== subproject!.id) return failure('wrong-run', 'This execution belongs to another workflow.');
          }
          // One unfinished run per flow (checked again where the run starts). A retry of the same request
          // is answered by what it already did, so only new requests are checked here.
          if (!previous && (command.type === 'run.launch' || command.type === 'run.start')
            && blockingRunOf(this.options.runs(command.projectId), subproject!.id, command.payload.runId)) {
            return failure('active-run', 'This flow is still running. Finish or cancel that run before starting another.');
          }
          if (command.type === 'run.launch' && !launch) {
            // The request's own, else the flow's saved one, else (an agent's launch) its conversation's provider and model.
            // 반복 runs with the review AI of the flow the person confirmed (the pinned one), not one saved after it.
            const reviewer = command.payload.reviewer ?? runSource.runSettings?.reviewer
              ?? (principal.kind === 'ai' && principal.sessionId ? this.options.conversationReviewer?.(principal.sessionId) : undefined);
            if (!reviewer) return failure('missing-reviewer', 'Choose the review AI for this flow before running it.');
            launch = { runId: command.payload.runId, reviewer: structuredClone(reviewer) };
          }
          if (command.type === 'run.launch' && required?.launchIntent !== undefined
            && launchIntentDigest(repeatContentDigest(runSource), launch!) !== required.launchIntent) {
            return failure('flow-changed', 'The flow changed after this run was decided, so nothing was run.');
          }
          if (!previous?.pending) {
            // Persist exact intent before crossing the execution ledger boundary. A lost response
            // can only retry this fingerprint and frozen graph, even after another draft edit.
            await this.write(loaded.target, wrap(registry, [...loaded.file.receipts, { commandId: command.commandId, fingerprint, revision: subproject!.revision, pending: true, runSubproject: structuredClone(runSource), ...(launch ? { launch } : {}) }]), loaded.bytesHash);
            loaded = await this.load(command.projectId);
          }
          // A launch always carries its fixed intent: the same revision and review AI on every retry.
          const sent: WorkflowCommand = command.type === 'run.launch'
            ? { ...command, expectedRevision: previous?.revision ?? subproject!.revision, payload: { runId: launch!.runId, reviewer: launch!.reviewer } } : command;
          const result = await this.options.executeRun(sent, runSource, principal);
          if (!result.ok) {
            if (command.type === 'run.launch' && !result.transient) {
              const settled = await this.load(command.projectId);
              await this.write(settled.target, wrap(settled.file.registry, [...settled.file.receipts.filter(entry => entry.commandId !== command.commandId),
                { commandId: command.commandId, fingerprint, revision: previous?.revision ?? subproject!.revision, failed: { error: result.error.slice(0, 100), message: result.message.slice(0, 4_000) } }]), settled.bytesHash);
            }
            // Clients keep a request pending (and retry it as it was) on this one code.
            return result.transient ? failure('execution-unavailable', result.message) : failure(result.error, result.message);
          }
        }
        const file = wrap(registry, [...loaded.file.receipts.filter(entry => entry.commandId !== command.commandId), { commandId: command.commandId, fingerprint, revision: subproject?.revision ?? registry.registryRevision }]);
        const commit = async (): Promise<WorkflowResult | null> => {
          const refused = lockedEdit?.(); if (refused) return refused;
          await this.write(loaded.target, file, loaded.bytesHash); return null;
        };
        const refused = lockedEdit && this.options.executionGate ? await this.options.executionGate(commit) : await commit();
        if (refused) return refused;
        await this.moveRepeatConsent(command, loaded.file.registry, registry);
        this.committed(command.projectId);
        if (command.type === 'subproject.create' && command.payload.previewId) {
          const preview = this.previews.get(command.payload.previewId);
          if (preview) this.discardedPreviews.set(preview.id, preview.revision + 1);
          this.previews.delete(command.payload.previewId);
        }
        return this.result(registry, command.commandId, false);
      } catch (error) { return this.error(error); }
    });
  }

  /**
   * A command's receipt as the repeat schedule needs it before replaying one (it is written before any effect):
   * none, settled (a replay only answers from it), or pending, with the intent a replay would run. That intent is
   * read from the flow file in the project folder, so the schedule replays it only if it is what it claimed.
   */
  launchReceipt(projectId: string, commandId: string): Promise<WorkflowLaunchReceipt> {
    return this.exclusive(projectId, async () => {
      const receipt = (await this.load(projectId)).file.receipts.find(entry => entry.commandId === commandId);
      if (!receipt) return { state: 'none' as const };
      if (!receipt.pending) return { state: 'settled' as const };
      return { state: 'pending' as const, ...(receipt.runSubproject && receipt.launch ? { intent: launchIntentDigest(repeatContentDigest(receipt.runSubproject), receipt.launch) } : {}) };
    });
  }

  /** Portable registry only. Live attempts remain in the existing execution archive. */
  async exportRegistry(projectId: string): Promise<WorkflowRegistry> {
    return this.exclusive(projectId, async () => structuredClone((await this.load(projectId)).file.registry));
  }

  importRegistry(projectId: string, source: unknown): Promise<void> {
    return this.exclusive(projectId, async () => {
      const registry = WorkflowRegistrySchema.parse(source); registry.projectId = projectId;
      const target = await this.target(projectId);
      if (await fs.stat(target).then(() => true).catch(error => { if (missing(error)) return false; throw error; })) throw new Error('Restore requires an empty workflow registry.');
      this.validateRegistry(registry);
      await this.write(target, wrap(registry, []), null);
      this.committed(projectId);
    });
  }

  /**
   * Each subproject's 반복 with what decides whether it runs, from the saved flow (none while the project has
   * no flow file yet). Reads like navigation: no legacy planning read on every repeat check.
   */
  repeatSources(projectId: string): Promise<readonly WorkflowRepeatSource[]> {
    return this.exclusive(projectId, async () => {
      const target = await this.target(projectId);
      if (!await fs.stat(target).then(() => true, error => { if (missing(error)) return false; throw error; })) return [];
      return (await this.load(projectId, true)).file.registry.subprojects.flatMap(entry => entry.repeat ? [{
        subprojectId: entry.id, revision: entry.revision, status: entry.status, repeat: structuredClone(entry.repeat), contentDigest: repeatContentDigest(entry), pinnable: repeatPin(entry),
        ...(entry.runSettings?.reviewer ? { reviewer: structuredClone(entry.runSettings.reviewer) } : {}) }] : []);
    });
  }

  private async moveRepeatConsent(command: WorkflowCommand, before: WorkflowRegistry, after: WorkflowRegistry): Promise<void> {
    if (!this.options.repeatConsent || command.type === 'subproject.create' || !command.subprojectId) return;
    const previous = before.subprojects.find(entry => entry.id === command.subprojectId);
    const next = after.subprojects.find(entry => entry.id === command.subprojectId);
    const set = command.type === 'subproject.update' && !!command.payload.repeat;
    const beforeDigest = previous?.repeat ? repeatContentDigest(previous) : undefined;
    const afterDigest = next?.repeat ? repeatContentDigest(next) : undefined;
    if (!set && (!beforeDigest || beforeDigest === afterDigest)) return;
    try {
      await this.options.repeatConsent(command.projectId, command.subprojectId, { set, ...(beforeDigest ? { before: beforeDigest } : {}),
        ...(next?.repeat?.enabled && afterDigest ? { after: afterDigest, ...(set && next ? { pinned: repeatPin(next) } : {}) } : {}),
        ...(next?.repeat ? { config: repeatConfigDigest(next.repeat), runnable: next.repeat.enabled && next.status === 'active' } : {}) });
    } catch { /* The flow is saved; its 반복 shows as not confirmed on this host until turned on again. */ }
  }

  private committed(projectId: string): void {
    try { this.options.onCommitted?.(projectId); } catch { /* a listener never undoes a saved commit */ }
  }

  async flush(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); }

  private result(registry: WorkflowRegistry, commandId?: string, duplicate?: boolean): WorkflowResult {
    const snapshot = structuredClone(registry);
    snapshot.sessionLinks = snapshot.sessionLinks.map(link => {
      if (link.scope !== 'stage') return link;
      const owner = registry.subprojects.find(entry => entry.id === link.subprojectId);
      try {
        if (!owner || owner.status === 'archived' || !link.referenceSnapshot || !owner.graph.nodes.some(node => node.id === link.nodeId)) return { ...link, referenceStale: true };
        const current = this.stageReferences(registry.projectId, owner, link.nodeId!);
        return { ...link, referenceStale: workflowDigest({ ...current, graphRevision: 0, fingerprint: '' }) !== workflowDigest({ ...link.referenceSnapshot, graphRevision: 0, fingerprint: '' }) };
      } catch { return { ...link, referenceStale: true }; }
    });
    return { ok: true, snapshot: { ...snapshot, hostId: this.options.hostId, runs: structuredClone([...this.options.runs(registry.projectId)]), managedSessionIds: [...this.options.managedSessions?.(registry.projectId) ?? []], ...repeatStatusOf(this.options.repeatStatus?.(registry)), ...agentCatalogOf(this.options.agentCatalog?.()) }, ...(commandId ? { commandId, duplicate } : {}) };
  }
  private error(error: unknown): Extract<WorkflowResult, { ok: false }> { return failure(error instanceof WorkflowFailure ? error.code : 'unavailable', error instanceof Error ? error.message : 'Workflow state is unavailable. Preserve edits and reload before retrying.'); }
  private exclusive<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    let gate = this.gates.get(projectId); if (!gate) { gate = new AsyncMutationGate(); this.gates.set(projectId, gate); }
    const result = gate.runExclusive(action); this.pending.add(result); void result.finally(() => this.pending.delete(result)).catch(() => undefined); return result;
  }
  private async target(projectId: string, navigation = false): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(projectId)) throw new WorkflowFailure('invalid-command', 'Invalid project identity.');
    const registered = await (navigation ? this.options.resolveNavigationRoot ?? this.options.resolveProjectRoot : this.options.resolveProjectRoot)(projectId);
    if (!registered || !path.isAbsolute(registered)) throw new WorkflowFailure('not-found', 'The authorized project is unavailable.');
    const root = await fs.realpath(registered);
    for (const segment of [root, path.join(root, '.ezterminal'), path.join(root, '.ezterminal', 'planning')]) {
      try { const stat = await fs.lstat(segment); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new WorkflowFailure('forbidden', 'Workflow data must stay in an ordinary project directory.'); }
      catch (error) { if (!missing(error)) throw error; }
    }
    const target = path.join(root, '.ezterminal', 'planning', 'workflows.json');
    try { const stat = await fs.lstat(target); if (stat.isSymbolicLink() || !stat.isFile()) throw new WorkflowFailure('forbidden', 'Workflow data must be an ordinary project file.'); }
    catch (error) { if (!missing(error)) throw error; }
    return target;
  }
  private validateRegistry(registry: WorkflowRegistry): void {
    if (new Set(registry.subprojects.map(entry => entry.id)).size !== registry.subprojects.length || new Set(registry.sessionLinks.map(entry => entry.sessionId)).size !== registry.sessionLinks.length) throw new WorkflowFailure('corrupt', 'The registry contains duplicated identities.');
    for (const entry of registry.subprojects) {
      if (new Set(entry.graph.nodes.map(node => node.id)).size !== entry.graph.nodes.length || new Set(entry.graph.edges.map(edge => edge.id)).size !== entry.graph.edges.length) throw new WorkflowFailure('invalid-command', 'Stage and connection IDs must be unique.');
    }
    for (const link of registry.sessionLinks) {
      const owner = registry.subprojects.find(entry => entry.id === link.subprojectId);
      if (!owner || (link.nodeId && ![...owner.graph.nodes, ...owner.archivedNodes].some(node => node.id === link.nodeId))) throw new WorkflowFailure('corrupt', 'A conversation link points to a missing workflow or stage.');
    }
  }
  private async load(projectId: string, navigation = false): Promise<{ file: WorkflowFile; target: string; bytesHash: string | null }> {
    const target = await this.target(projectId, navigation);
    const bytes = await fs.readFile(target).catch(error => { if (missing(error)) return null; throw error; });
    const bytesHash = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
    if (this.observed.has(target) && this.observed.get(target) !== bytesHash) throw new WorkflowFailure('external-change', 'Workflow data changed outside this host. Preserve edits and restart to reconcile the external file.');
    this.observed.set(target, bytesHash);
    return { file: await this.parse(projectId, target, bytes, navigation), target, bytesHash };
  }
  /**
   * The last committed registry without the project gate. Writes replace the file atomically, so a
   * plain read sees one whole committed version. For callers that already hold the execution gate,
   * which a gated read could deadlock against (WorkflowService.execute holds this gate while it waits
   * for the execution gate).
   */
  private async readCommitted(projectId: string): Promise<WorkflowRegistry> {
    const target = await this.target(projectId);
    for (let attempt = 0; ; attempt += 1) {
      const bytes = await fs.readFile(target).catch(error => { if (missing(error)) return null; throw error; });
      const bytesHash = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
      // Same external-change rule as load(), without recording anything: a version this host never
      // wrote or read is refused. A commit that just replaced the file records its hash right after
      // the rename, so a mismatch is read once more before it counts.
      if (this.observed.has(target) && this.observed.get(target) !== bytesHash) {
        if (attempt === 0) { await new Promise(resolve => setImmediate(resolve)); continue; }
        throw new WorkflowFailure('external-change', 'Workflow data changed outside this host. Preserve edits and restart to reconcile the external file.');
      }
      return (await this.parse(projectId, target, bytes, false)).registry;
    }
  }
  private async parse(projectId: string, target: string, bytes: Buffer | null, navigation: boolean): Promise<WorkflowFile> {
    if (bytes) {
      if (bytes.length > MAX_BYTES) throw new WorkflowFailure('unavailable', 'The workflow registry exceeds the editing limit.');
      const parsed = fileSchema.safeParse(JSON.parse(bytes.toString('utf8')));
      if (!parsed.success || parsed.data.registry.projectId !== projectId || parsed.data.integrity !== workflowDigest({ registry: parsed.data.registry, receipts: parsed.data.receipts })) throw new WorkflowFailure('corrupt', 'Workflow integrity failed. The source file was preserved.');
      this.validateRegistry(parsed.data.registry);
      if (!navigation && parsed.data.registry.subprojects.some(entry => entry.legacyPlanning)) {
        const legacy = await this.options.planning.read(projectId);
        if (!legacy.ok) throw new WorkflowFailure(legacy.error, legacy.message);
        for (const baseline of legacy.snapshot.baselines) parsed.data.registry.legacyBaselineOwners[baseline.id] = baseline.purpose === 'quick-task' ? null : LEGACY_SUBPROJECT_ID;
      }
      return parsed.data;
    }
    const legacy = await this.options.planning.read(projectId);
    if (!legacy.ok && navigation) return wrap({ schemaVersion: 1, projectId, registryRevision: 0, subprojects: [], sessionLinks: [], legacyBaselineOwners: {} }, []);
    if (!legacy.ok) throw new WorkflowFailure(legacy.error, legacy.message);
    const hasLegacy = legacy.snapshot.revision > 0 || legacy.snapshot.baselines.length > 0 || Object.values(legacy.snapshot.draft).some(value => Array.isArray(value) && value.length > 0);
    const registry: WorkflowRegistry = { schemaVersion: 1, projectId, registryRevision: 0, subprojects: [], sessionLinks: [], legacyBaselineOwners: {} };
    if (hasLegacy) {
      // The source file, hashes and receipts are deliberately left byte-for-byte intact.
      // Until the first mutation persists the registry, reads must project the same identity.
      const recordedTimes = [...legacy.snapshot.history, ...legacy.snapshot.baselines, ...legacy.snapshot.profileProposals].map(entry => entry.createdAt).sort();
      const createdAt = recordedTimes[0] ?? (await fs.stat(path.join(path.dirname(target), 'project.json'))).mtime.toISOString();
      const updatedAt = recordedTimes.at(-1) ?? createdAt;
      registry.subprojects.push({ id: LEGACY_SUBPROJECT_ID, title: '기본 기획', goal: '', status: 'active', revision: 0,
        createdAt, updatedAt, presetId: 'feature', graph: createWorkflowGraph('feature', LEGACY_SUBPROJECT_ID), history: [], archivedNodes: [], legacyPlanning: true });
      registry.legacyBaselineOwners = Object.fromEntries(legacy.snapshot.baselines.map(baseline => [baseline.id, baseline.purpose === 'quick-task' ? null : LEGACY_SUBPROJECT_ID]));
    }
    return wrap(registry, []);
  }
  private async write(target: string, file: WorkflowFile, expectedHash: string | null): Promise<void> {
    this.validateRegistry(file.registry);
    const data = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(data) > MAX_BYTES) throw new WorkflowFailure('unavailable', 'The workflow registry exceeds the editing limit.');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), `.workflow-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(data, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      if (await this.target(file.registry.projectId) !== target) throw new WorkflowFailure('external-change', 'The project root changed while saving.');
      const current = await fs.readFile(target).catch(error => { if (missing(error)) return null; throw error; });
      if ((current ? createHash('sha256').update(current).digest('hex') : null) !== expectedHash) throw new WorkflowFailure('external-change', 'Another writer changed the workflow registry. Reload before retrying.');
      if (expectedHash === null && file.registry.subprojects.some(entry => entry.legacyPlanning)) {
        const legacyPath = path.join(path.dirname(target), 'project.json');
        // A recoverable backup is created before the first ownership mapping is committed.
        const source = await fs.readFile(legacyPath).catch(error => { if (missing(error)) return null; throw error; });
        if (source) {
          const backup = `${legacyPath}.workflow-backup-${createHash('sha256').update(source).digest('hex')}`;
          await fs.writeFile(backup, source, { flag: 'wx', mode: 0o600 }).catch(async error => {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const stat = await fs.lstat(backup);
            if (stat.isSymbolicLink() || !stat.isFile() || !(await fs.readFile(backup)).equals(source)) throw new WorkflowFailure('corrupt', 'The migration backup does not match the preserved source.');
          });
        }
      }
      await fs.rename(temporary, target); this.observed.set(target, createHash('sha256').update(data).digest('hex'));
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  }
}
class WorkflowFailure extends Error { constructor(readonly code: string, message: string) { super(message); } }
