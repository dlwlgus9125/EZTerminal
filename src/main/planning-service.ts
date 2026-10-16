import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import {
  PLANNING_SCHEMA_VERSION,
  PlanningCommandSchema,
  PlanningSnapshotSchema,
  validatePlanningDraft,
  type PlanningCommand,
  type PlanningDraft,
  type PlanningError,
  type PlanningMutationResult,
  type PlanningOperation,
  type PlanningReadResult,
  type PlanningSnapshot,
  type PlanningComponent,
  type ScreenScene,
} from '../shared/planning';
import { AsyncMutationGate } from './async-mutation-gate';
import { selectPlanningTasks } from '../shared/planning-selection';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const ReceiptSchema = z.object({
  commandId: z.string(), fingerprint: z.string(), revision: z.number().int(), changeId: z.string(),
}).strict();
const FileSchema = z.object({
  version: z.literal(1),
  snapshot: PlanningSnapshotSchema,
  receipts: z.array(ReceiptSchema),
  integrity: z.string(),
}).strict();
type PlanningFile = z.infer<typeof FileSchema>;
type Receipt = z.infer<typeof ReceiptSchema>;

export interface PlanningServiceOptions {
  /** Resolve from the host's authorized project registry, never a renderer-supplied path. */
  readonly resolveProjectRoot: (projectId: string) => string | null | undefined | Promise<string | null | undefined>;
  readonly now?: () => Date;
  /** Host-selected stable identity; never a file path from a client. */
  readonly subprojectId?: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function clone<T>(value: T): T { return structuredClone(value); }
function failure(error: PlanningError['error'], message: string, revision?: number, issues?: readonly string[]): PlanningError {
  return { ok: false, error, message, ...(revision !== undefined ? { revision } : {}), ...(issues ? { issues } : {}) };
}
function emptySnapshot(projectId: string): PlanningSnapshot {
  return {
    schemaVersion: PLANNING_SCHEMA_VERSION, projectId, revision: 0,
    draft: { id: 'draft-1', items: [], links: [], scenes: [], components: [], profiles: [], tasks: [], assets: [] },
    baselines: [], history: [], profileProposals: [],
  };
}
function envelope(snapshot: PlanningSnapshot, receipts: Receipt[]): PlanningFile {
  return { version: 1, snapshot, receipts, integrity: digest({ snapshot, receipts }) };
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

function referencesAreFrozen(snapshot: PlanningSnapshot): readonly string[] {
  const issues: string[] = [];
  for (const entity of [...snapshot.draft.profiles, ...snapshot.draft.tasks]) {
    const refs = 'contextRefs' in entity ? entity.contextRefs : [...entity.inputRefs, ...entity.interfaceRefs];
    for (const ref of refs) {
      if (!ref.baselineId) continue;
      const baseline = snapshot.baselines.find((entry) => entry.id === ref.baselineId);
      if (!baseline) { issues.push(`Reference ${ref.id}: baseline ${ref.baselineId} is missing.`); continue; }
      const entries = ref.kind === 'item' ? baseline.draft.items : ref.kind === 'scene' ? baseline.draft.scenes
        : ref.kind === 'component' ? baseline.draft.components : ref.kind === 'profile' ? baseline.draft.profiles
          : ref.kind === 'task' ? baseline.draft.tasks : ref.kind === 'asset' ? baseline.draft.assets : [];
      if (ref.kind !== 'file' && !entries.some((entry) => entry.id === ref.id && entry.revision === ref.revision)) {
        issues.push(`Reference ${ref.id}: frozen revision is missing.`);
      }
    }
  }
  return issues;
}

/** A single host-owned writer. Every durable mutation includes its retry receipt in the same rename. */
export class PlanningService {
  private readonly scoped = new Map<string, PlanningService>();
  private readonly gates = new Map<string, AsyncMutationGate>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly observed = new Map<string, string | null>();
  private readonly now: () => Date;

  constructor(private readonly options: PlanningServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  read(projectId: string, subprojectId?: string): Promise<PlanningReadResult> {
    if (subprojectId && subprojectId !== 'legacy-default' && subprojectId !== this.options.subprojectId) {
      const service = this.scope(subprojectId);
      return service ? service.read(projectId) : Promise.resolve(failure('invalid', 'Invalid subproject identity.'));
    }
    return this.exclusive(projectId, async () => {
      const loaded = await this.load(projectId);
      return loaded.ok ? { ok: true, snapshot: clone(loaded.file.snapshot) } : loaded;
    });
  }

  /** Host-only restore into a new empty project. Execution permissions and old retry receipts are not imported. */
  importSnapshot(projectId: string, source: unknown, subprojectId?: string): Promise<PlanningReadResult> {
    if (subprojectId && subprojectId !== 'legacy-default' && subprojectId !== this.options.subprojectId) {
      const service = this.scope(subprojectId);
      return service ? service.importSnapshot(projectId, source) : Promise.resolve(failure('invalid', 'Invalid subproject identity.'));
    }
    return this.exclusive(projectId, async () => {
      const parsed = PlanningSnapshotSchema.safeParse(source);
      if (!parsed.success) return failure('invalid', 'The archived planning snapshot is invalid.');
      const snapshot = { ...parsed.data, projectId };
      const issues = [...validatePlanningDraft(snapshot.draft), ...referencesAreFrozen(snapshot),
        ...snapshot.baselines.flatMap(baseline => [...validatePlanningDraft(baseline.draft), ...(baseline.hash !== digest(baseline.draft) ? ['Archived baseline integrity failed.'] : [])])];
      if (issues.length) return failure('invalid', 'The archived planning references are invalid.', undefined, issues);
      const loaded = await this.load(projectId);
      if (!loaded.ok) return loaded;
      if (loaded.bytesHash !== null) return failure('conflict', 'Restore requires a new project with no existing planning file.');
      await this.write(loaded.target, envelope(snapshot, []), null);
      return { ok: true, snapshot: clone(snapshot) };
    });
  }

  execute(value: unknown): Promise<PlanningMutationResult> {
    const parsed = PlanningCommandSchema.safeParse(value);
    if (!parsed.success) return Promise.resolve(failure('invalid', 'The planning command is invalid.', undefined,
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)));
    const command = parsed.data;
    if (command.subprojectId && command.subprojectId !== 'legacy-default' && command.subprojectId !== this.options.subprojectId) {
      return this.scope(command.subprojectId)!.execute(command);
    }
    return this.exclusive(command.projectId, async () => {
      const loaded = await this.load(command.projectId);
      if (!loaded.ok) return loaded;
      const { file, target, bytesHash } = loaded;
      const fingerprint = digest(command);
      const existing = file.receipts.find((entry) => entry.commandId === command.commandId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return failure('conflict', 'This command ID already belongs to another operation.', file.snapshot.revision);
        // Receipt identity is stable; callers receive the current read snapshot without replaying a mutation.
        return { ok: true, commandId: existing.commandId, revision: existing.revision, changeId: existing.changeId, duplicate: true, snapshot: clone(file.snapshot) };
      }
      if (command.expectedRevision !== file.snapshot.revision) return failure('stale', 'Planning changed. Read the current revision before applying this edit.', file.snapshot.revision);
      const next = this.apply(file.snapshot, command);
      if (!next.ok) return next;
      const receipt = { commandId: command.commandId, fingerprint, revision: next.snapshot.revision, changeId: command.commandId };
      const nextFile = envelope(next.snapshot, [...file.receipts, receipt]);
      try {
        await this.write(target, nextFile, bytesHash);
      } catch (error) {
        if (error instanceof ExternalPlanningChange) return failure('external-change', error.message, file.snapshot.revision);
        return failure('unavailable', 'Planning could not be saved. The previous file and unsaved edit were preserved.', file.snapshot.revision);
      }
      return { ok: true, commandId: command.commandId, revision: next.snapshot.revision, changeId: command.commandId, duplicate: false, snapshot: clone(next.snapshot) };
    });
  }

  /** Host-generated workflow baseline. Adds an immutable input without replacing the editable planning draft. */
  captureWorkflowBaseline(projectId: string, subprojectId: string, baselineId: string, title: string, draft: PlanningDraft): Promise<PlanningReadResult> {
    if (subprojectId !== 'legacy-default' && subprojectId !== this.options.subprojectId) {
      const service = this.scope(subprojectId);
      return service ? service.captureWorkflowBaseline(projectId, subprojectId, baselineId, title, draft) : Promise.resolve(failure('invalid', 'Invalid subproject identity.'));
    }
    return this.exclusive(projectId, async () => {
      const loaded = await this.load(projectId);
      if (!loaded.ok) return loaded;
      const existing = loaded.file.snapshot.baselines.find(entry => entry.id === baselineId);
      if (existing) return existing.hash === digest(draft) ? { ok: true, snapshot: clone(loaded.file.snapshot) }
        : failure('conflict', 'This workflow baseline ID belongs to different inputs.');
      const issues = validatePlanningDraft(draft, true);
      if (issues.length) return failure('invalid', 'Workflow inputs are invalid.', loaded.file.snapshot.revision, issues);
      const snapshot = clone(loaded.file.snapshot);
      snapshot.baselines.push({ id: baselineId, title, sourceRevision: snapshot.revision, createdAt: this.now().toISOString(),
        createdBy: { kind: 'user', id: 'workflow-runtime' }, hash: digest(draft), draft: clone(draft) });
      snapshot.revision += 1;
      const parsed = PlanningSnapshotSchema.safeParse(snapshot);
      if (!parsed.success) return failure('invalid', 'Workflow inputs exceed the planning limits.');
      await this.write(loaded.target, envelope(snapshot, loaded.file.receipts), loaded.bytesHash);
      return { ok: true, snapshot: clone(snapshot) };
    });
  }

  async flush(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); await Promise.all([...this.scoped.values()].map(service => service.flush())); }

  private scope(subprojectId: string): PlanningService | undefined {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(subprojectId)) return undefined;
    let service = this.scoped.get(subprojectId);
    if (!service) { service = new PlanningService({ ...this.options, subprojectId }); this.scoped.set(subprojectId, service); }
    return service;
  }

  private exclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    let gate = this.gates.get(projectId);
    if (!gate) { gate = new AsyncMutationGate(); this.gates.set(projectId, gate); }
    const result = gate.runExclusive(operation);
    this.pending.add(result);
    void result.finally(() => this.pending.delete(result)).catch(() => undefined);
    return result;
  }

  private async target(projectId: string): Promise<string | PlanningError> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(projectId)) return failure('invalid', 'Invalid project ID.');
    const registered = await this.options.resolveProjectRoot(projectId);
    if (!registered || !path.isAbsolute(registered)) return failure('not-found', 'The registered project is unavailable.');
    try {
      const root = await fs.realpath(registered);
      if (!(await fs.stat(root)).isDirectory()) return failure('not-found', 'The project root is not a directory.');
      const segments = [path.join(root, '.ezterminal'), path.join(root, '.ezterminal', 'planning')];
      for (const segment of segments) {
        try {
          const stat = await fs.lstat(segment);
          if (stat.isSymbolicLink() || !stat.isDirectory()) return failure('forbidden', 'The planning directory must be an ordinary project-owned directory.');
        } catch (error) { if (!isMissing(error)) throw error; }
      }
      // Hashing the identity also avoids Windows reserved names and colon semantics.
      const target = path.join(segments[1]!, this.options.subprojectId
        ? `subproject-${createHash('sha256').update(this.options.subprojectId).digest('hex')}.json` : 'project.json');
      try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink() || !stat.isFile()) return failure('forbidden', 'The planning file must be an ordinary project-owned file.');
        if (stat.size > MAX_FILE_BYTES) return failure('unavailable', 'The planning file is too large to edit safely. Preserve it and export or archive explicitly.');
      } catch (error) { if (!isMissing(error)) throw error; }
      return target;
    } catch { return failure('unavailable', 'The project directory could not be read.'); }
  }

  private async load(projectId: string): Promise<{ ok: true; file: PlanningFile; target: string; bytesHash: string | null } | PlanningError> {
    let target: string | PlanningError;
    try { target = await this.target(projectId); } catch { return failure('unavailable', 'The project registry could not resolve this project.'); }
    if (typeof target !== 'string') return target;
    let bytes: Buffer;
    try { bytes = await fs.readFile(target); } catch (error) {
      if (!isMissing(error)) return failure('unavailable', 'The planning file could not be read.');
      if (this.observed.get(target)) return failure('external-change', 'The planning file was removed outside EZTerminal. Review and restore the external file, preserve unsaved edits, then restart the application to reconcile it.');
      this.observed.set(target, null);
      return { ok: true, file: envelope(emptySnapshot(projectId), []), target, bytesHash: null };
    }
    if (bytes.byteLength > MAX_FILE_BYTES) return failure('unavailable', 'The planning file exceeds the safe editing limit.');
    const bytesHash = createHash('sha256').update(bytes).digest('hex');
    let file: PlanningFile;
    try { file = FileSchema.parse(JSON.parse(bytes.toString('utf8'))); } catch {
      return failure('corrupt', 'Planning data is invalid or uses an unsupported schema. The source file was preserved.');
    }
    if (file.snapshot.projectId !== projectId || file.integrity !== digest({ snapshot: file.snapshot, receipts: file.receipts })
      || file.snapshot.baselines.some((entry) => digest(entry.draft) !== entry.hash)) {
      return failure('corrupt', 'Planning integrity validation failed. The source file was preserved for recovery.');
    }
    const issues = [...validatePlanningDraft(file.snapshot.draft), ...referencesAreFrozen(file.snapshot)];
    if (issues.length) return failure('corrupt', 'Planning references are invalid. The source file was preserved.', file.snapshot.revision, issues);
    if (this.observed.has(target) && this.observed.get(target) !== bytesHash) {
      return failure('external-change', 'Planning was changed outside this host. Review the external changes, preserve unsaved edits, then restart the application before editing.', file.snapshot.revision);
    }
    this.observed.set(target, bytesHash);
    return { ok: true, file, target, bytesHash };
  }

  private apply(snapshot: PlanningSnapshot, command: PlanningCommand): PlanningReadResult {
    const next = clone(snapshot);
    const nextRevision = snapshot.revision + 1;
    const changed = new Set<string>();
    let summary = command.type as string;
    let undoOf: string | undefined;
    if (command.actor.kind === 'ai' && command.type !== 'planning.patch' && command.type !== 'profile.propose') {
      return failure('forbidden', 'Freezing, branching, undo and profile application require a user command.', snapshot.revision);
    }
    if (command.type === 'planning.patch') {
      summary = command.payload.summary;
      for (const operation of command.payload.operations) {
        if (command.actor.kind === 'ai' && (operation.op === 'profile.put' || (operation.op === 'entity.delete' && operation.kind === 'profile'))) {
          return failure('forbidden', 'AI profile changes must be proposed and explicitly applied.', snapshot.revision);
        }
        const error = this.applyOperation(next.draft, operation, nextRevision, changed);
        if (error) return { ...error, revision: snapshot.revision };
      }
      // Explicit edits and nested component propagation share one revision.
      const editedComponents = command.payload.operations.flatMap((operation) => operation.op === 'component.put' ? [operation.value.id] : []);
      for (const id of editedComponents) {
        const component = next.draft.components.find((entry) => entry.id === id);
        if (!component) continue;
        const error = this.propagateComponent(next.draft, component, changed, nextRevision);
        if (error) return { ...error, revision: snapshot.revision };
      }
      this.markImpacted(next.draft, changed, nextRevision);
    } else if (command.type === 'planning.quick-freeze') {
      const { task, baselineId, title, profileIds } = command.payload;
      if (next.baselines.some((entry) => entry.id === baselineId)) return failure('conflict', 'A baseline with this ID already exists.', snapshot.revision);
      if (task.status !== 'ready' || !task.objective.trim() || !task.acceptance.length || !task.validationPlan.length
        || task.dependencyIds.length || task.featureIds.length || task.screenIds.length) {
        return failure('invalid', 'A quick task needs a reviewed objective, scope, acceptance criteria and validation, with no unresolved task dependencies.', snapshot.revision);
      }
      const selected = new Set([...profileIds, ...(task.profileId ? [task.profileId] : [])]);
      for (const profileId of selected) {
        const profile = next.draft.profiles.find((entry) => entry.id === profileId);
        if (!profile) return failure('not-found', 'A selected quick-task profile is unavailable.', snapshot.revision);
        if (profile.parentProfileId) selected.add(profile.parentProfileId);
      }
      const draft = { ...emptySnapshot(snapshot.projectId).draft, id: baselineId,
        profiles: clone(next.draft.profiles.filter((entry) => selected.has(entry.id))), tasks: [{ ...clone(task), revision: nextRevision }] };
      const issues = validatePlanningDraft(draft, true);
      if (issues.length) return failure('invalid', 'Quick-task references must be self-contained or point to an existing frozen baseline.', snapshot.revision, issues);
      next.baselines.push({ id: baselineId, title, purpose: 'quick-task', sourceRevision: snapshot.revision,
        createdAt: this.now().toISOString(), createdBy: command.actor, hash: digest(draft), draft });
      summary = `Prepare quick task ${title}`;
    } else if (command.type === 'planning.freeze') {
      if (next.baselines.some((entry) => entry.id === command.payload.baselineId)) return failure('conflict', 'A baseline with this ID already exists.', snapshot.revision);
      let frozenDraft = next.draft;
      try { if (command.payload.taskIds) frozenDraft = selectPlanningTasks(next.draft, command.payload.taskIds); }
      catch (error) { return failure('invalid', error instanceof Error ? error.message : 'Invalid task selection.', snapshot.revision); }
      const reviewable = [...frozenDraft.items, ...frozenDraft.scenes, ...frozenDraft.tasks];
      if (reviewable.length === 0 || reviewable.some((entry) => entry.status !== 'ready')) return failure('invalid', 'Every planning item, scene and task must be reviewed before freezing.', snapshot.revision);
      const referenceIssues = validatePlanningDraft(frozenDraft, true);
      if (referenceIssues.length) return failure('invalid', 'Resolve stale references before freezing.', snapshot.revision, referenceIssues);
      next.baselines.push({ id: command.payload.baselineId, title: command.payload.title, sourceRevision: snapshot.revision,
        createdAt: this.now().toISOString(), createdBy: command.actor, hash: digest(frozenDraft), draft: clone(frozenDraft) });
      summary = `Freeze ${command.payload.title}`;
    } else if (command.type === 'planning.branch') {
      const baseline = next.baselines.find((entry) => entry.id === command.payload.baselineId);
      if (!baseline) return failure('not-found', 'The baseline does not exist.', snapshot.revision);
      next.draft = clone(baseline.draft);
      next.draft.id = command.payload.draftId;
      next.draft.basedOnBaselineId = baseline.id;
      this.reviseRestoredDraft(next.draft, nextRevision);
      summary = `Branch ${baseline.title}`;
    } else if (command.type === 'planning.undo') {
      const reversible = next.history.filter((entry) => ['planning.patch', 'planning.branch', 'planning.undo', 'profile.apply'].includes(entry.type));
      const last = reversible.at(-1);
      if (!last || last.id !== command.payload.changeId) return failure('conflict', 'Only the latest edit bundle can be undone. Later edits will not be overwritten.', snapshot.revision);
      next.draft = clone(last.before);
      this.reviseRestoredDraft(next.draft, nextRevision);
      undoOf = last.id;
      summary = `Undo ${last.summary}`;
    } else if (command.type === 'profile.propose') {
      const current = next.draft.profiles.find((entry) => entry.id === command.payload.profileId);
      if (!current) return failure('not-found', 'The profile does not exist.', snapshot.revision);
      if (current.revision !== command.payload.baseVersion || command.payload.proposed.id !== current.id
        || command.payload.proposed.revision !== current.revision) return failure('stale', 'The profile proposal must target the current version.', snapshot.revision);
      if (next.profileProposals.some((entry) => entry.id === command.payload.proposalId)) return failure('conflict', 'This proposal ID already exists.', snapshot.revision);
      const proposedDraft = clone(next.draft);
      proposedDraft.profiles = proposedDraft.profiles.map((entry) => entry.id === current.id ? command.payload.proposed : entry);
      const issues = validatePlanningDraft(proposedDraft);
      if (issues.length) return failure('invalid', 'The proposed profile violates planning constraints.', snapshot.revision, issues);
      next.profileProposals.push({ id: command.payload.proposalId, profileId: current.id, baseVersion: current.revision,
        proposed: command.payload.proposed, reason: command.payload.reason, status: 'pending', createdAt: this.now().toISOString() });
      summary = `Propose changes to ${current.title}`;
    } else {
      const proposal = next.profileProposals.find((entry) => entry.id === command.payload.proposalId);
      if (!proposal) return failure('not-found', 'The profile proposal does not exist.', snapshot.revision);
      const current = next.draft.profiles.find((entry) => entry.id === proposal.profileId);
      if (proposal.status !== 'pending' || !current || current.revision !== proposal.baseVersion) return failure('stale', 'The profile changed. Compare a new proposal before applying it.', snapshot.revision);
      const error = this.applyOperation(next.draft, { op: 'profile.put', value: proposal.proposed }, nextRevision, changed);
      if (error) return error;
      proposal.status = 'applied';
      this.markImpacted(next.draft, changed, nextRevision);
      summary = `Apply changes to ${current.title}`;
    }
    for (const proposal of next.profileProposals) {
      if (proposal.status === 'pending' && next.draft.profiles.find((entry) => entry.id === proposal.profileId)?.revision !== proposal.baseVersion) proposal.status = 'stale';
    }
    const issues = [...validatePlanningDraft(next.draft), ...referencesAreFrozen(next)];
    if (issues.length) return failure('invalid', 'The edit would leave invalid planning references.', snapshot.revision, issues);
    next.revision = nextRevision;
    next.history.push({ id: command.commandId, commandId: command.commandId, revision: nextRevision, type: command.type,
      actor: command.actor, createdAt: this.now().toISOString(), summary, changedIds: [...changed],
      ...(undoOf ? { undoOf } : {}), before: clone(snapshot.draft) });
    const validated = PlanningSnapshotSchema.safeParse(next);
    if (!validated.success) return failure('invalid', 'The resulting planning data exceeds supported limits.', snapshot.revision,
      validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
    return { ok: true, snapshot: next };
  }

  private applyOperation(draft: PlanningDraft, operation: PlanningOperation, nextRevision: number, changed: Set<string>): PlanningError | undefined {
    const put = <T extends { id: string; revision: number }>(entries: T[], value: T): PlanningError | undefined => {
      const index = entries.findIndex((entry) => entry.id === value.id);
      if ((index < 0 && value.revision !== 0) || (index >= 0 && entries[index]!.revision !== value.revision)) return failure('stale', `Entity ${value.id} changed. Read its current revision.`);
      const next = { ...clone(value), revision: nextRevision };
      if (index < 0) entries.push(next); else entries[index] = next;
      changed.add(value.id);
      return undefined;
    };
    switch (operation.op) {
      case 'item.put': return put(draft.items, operation.value);
      case 'link.put': return put(draft.links, operation.value);
      case 'scene.put': return put(draft.scenes, operation.value);
      case 'component.put': {
        return put(draft.components, operation.value);
      }
      case 'profile.put': return put(draft.profiles, operation.value);
      case 'task.put': return put(draft.tasks, operation.value);
      case 'asset.put': return put(draft.assets, operation.value);
      case 'entity.delete': {
        const key = { item: 'items', link: 'links', scene: 'scenes', component: 'components', profile: 'profiles', task: 'tasks', asset: 'assets' } as const;
        const entries = draft[key[operation.kind]] as Array<{ id: string }>;
        const index = entries.findIndex((entry) => entry.id === operation.id);
        if (index < 0) return failure('not-found', `Entity ${operation.id} does not exist.`);
        entries.splice(index, 1);
        changed.add(operation.id);
        return undefined;
      }
    }
  }

  private propagateComponent(draft: PlanningDraft, component: PlanningComponent, changed: Set<string>, nextRevision: number, ancestry = new Set<string>()): PlanningError | undefined {
    if (ancestry.has(component.id)) return failure('invalid', 'Reusable component references form a cycle.');
    const path = new Set([...ancestry, component.id]);
    const roots = component.elements.filter((entry) => !entry.parentId);
    const owners: Array<ScreenScene | PlanningComponent> = [...draft.components, ...draft.scenes];
    const instances = owners.flatMap((scene) => scene.elements.filter((element) => element.component?.componentId === component.id).map((element) => ({ scene, element })));
    const dependentComponents = new Set<string>();
    if (instances.length && roots.length !== 1) return failure('invalid', 'A reusable component must have exactly one root element.');
    for (const { scene, element } of instances) {
      const overrides = element.component!.overrides;
      if (Object.keys(overrides).some((key) => !component.allowedOverrides.includes(key as keyof typeof overrides))) {
        return failure('conflict', `Component ${component.id} removes an overridden property in scene ${scene.id}. Compare the instance before applying.`);
      }
      const descendants = new Set<string>([element.id]);
      let previousSize: number;
      do {
        previousSize = descendants.size;
        for (const child of scene.elements) if (child.parentId && descendants.has(child.parentId)) descendants.add(child.id);
      } while (previousSize !== descendants.size);
      const root = roots[0]!;
      const mapId = (id: string) => id === root.id ? element.id : `${element.id}:${id}`;
      const propagated = component.elements.map((template) => ({
        ...clone(template), id: mapId(template.id),
        parentId: template.parentId ? mapId(template.parentId) : element.parentId,
        ...(template.id === root.id ? {
          order: element.order,
          properties: { ...template.properties, ...overrides },
          component: { componentId: component.id, version: component.revision, overrides: clone(overrides) },
          stateIds: element.stateIds,
        } : {}),
      }));
      scene.elements = [...scene.elements.filter((entry) => !descendants.has(entry.id)), ...propagated];
      scene.revision = nextRevision;
      if ('status' in scene) scene.status = 'review-needed';
      else dependentComponents.add(scene.id);
      changed.add(scene.id);
    }
    for (const id of dependentComponents) {
      const error = this.propagateComponent(draft, draft.components.find((entry) => entry.id === id)!, changed, nextRevision, path);
      if (error) return error;
    }
    return undefined;
  }

  private markImpacted(draft: PlanningDraft, changed: Set<string>, nextRevision: number): void {
    const impacted = new Set(changed);
    let size: number;
    do {
      size = impacted.size;
      for (const link of draft.links) if (impacted.has(link.toId)) impacted.add(link.fromId);
      for (const scene of draft.scenes) if (scene.featureIds.some((id) => impacted.has(id))) impacted.add(scene.id);
      for (const task of draft.tasks) {
        if ([...task.featureIds, ...task.screenIds, ...task.dependencyIds, ...(task.profileId ? [task.profileId] : []),
          ...task.inputRefs.filter((ref) => !ref.baselineId).map((ref) => ref.id),
          ...task.interfaceRefs.filter((ref) => !ref.baselineId).map((ref) => ref.id)].some((id) => impacted.has(id))) impacted.add(task.id);
      }
    } while (size !== impacted.size);
    for (const entry of [...draft.items, ...draft.scenes, ...draft.tasks]) {
      if (impacted.has(entry.id) && !changed.has(entry.id)) {
        entry.status = 'review-needed'; entry.revision = nextRevision; changed.add(entry.id);
      }
    }
  }

  private reviseRestoredDraft(draft: PlanningDraft, nextRevision: number): void {
    for (const entries of [draft.items, draft.links, draft.scenes, draft.components, draft.profiles, draft.tasks, draft.assets]) {
      for (const entry of entries) entry.revision = nextRevision;
    }
    for (const entity of [...draft.profiles, ...draft.tasks]) {
      for (const ref of 'contextRefs' in entity ? entity.contextRefs : [...entity.inputRefs, ...entity.interfaceRefs]) {
        if (!ref.baselineId && ref.kind !== 'file') ref.revision = nextRevision;
      }
    }
    for (const owner of [...draft.scenes, ...draft.components]) for (const element of owner.elements) if (element.component) element.component.version = nextRevision;
  }

  private async write(target: string, file: PlanningFile, expectedHash: string | null): Promise<void> {
    const serialized = `${JSON.stringify(file, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) throw new Error('Planning data exceeds the safe write limit.');
    // The directory is resolved and checked before every operation, and checked again before rename.
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), `.project-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      const current = await fs.readFile(target).catch((error: unknown) => { if (isMissing(error)) return null; throw error; });
      const currentHash = current ? createHash('sha256').update(current).digest('hex') : null;
      if (currentHash !== expectedHash) throw new ExternalPlanningChange('Planning changed on disk while saving. The external file and unsaved edit were preserved.');
      const checked = await this.target(file.snapshot.projectId);
      if (typeof checked !== 'string' || checked !== target) throw new ExternalPlanningChange('The project directory changed while saving.');
      try { await fs.rename(temporary, target); } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        const retryBytes = await fs.readFile(target).catch((readError: unknown) => { if (isMissing(readError)) return null; throw readError; });
        if ((retryBytes ? createHash('sha256').update(retryBytes).digest('hex') : null) !== expectedHash) throw new ExternalPlanningChange('Planning changed before the atomic write retry.');
        await fs.rename(temporary, target);
      }
      this.observed.set(target, createHash('sha256').update(serialized).digest('hex'));
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  }
}

class ExternalPlanningChange extends Error {}
