import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import {
  PLANNING_SCHEMA_VERSION,
  PlanningCommandSchema,
  PlanningSnapshotSchema,
  validatePlanningDraft,
  type PlanningDraft,
  type PlanningError,
  type PlanningMutationResult,
  type PlanningReadResult,
  type PlanningSnapshot,
} from '../shared/planning';
import { AsyncMutationGate } from './async-mutation-gate';

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
/** The hash a baseline records for its draft; restore (`importSnapshot`) checks it. */
export function planningDraftHash(draft: PlanningDraft): string { return digest(draft); }
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

  /**
   * Planning edits (patch, freeze, branch, undo, profile proposals) belonged to the old planning screen, removed in
   * I5; only an older phone still sends them. They are refused as forbidden (that app takes 'unavailable' for a save
   * whose result is unknown and offers to send it again); what flows need (reads, the restore/copy import and the run
   * baselines below) stays.
   */
  execute(value: unknown): Promise<PlanningMutationResult> {
    const parsed = PlanningCommandSchema.safeParse(value);
    if (!parsed.success) return Promise.resolve(failure('invalid', 'The planning command is invalid.', undefined,
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)));
    return Promise.resolve(failure('forbidden', 'Planning editing moved to flows in EZTerminal 2.0. Update the app on this device to work on this project.'));
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

  /**
   * 기획 기준본 정리 (I2-7f): removes workflow-run baselines (targets: id + the hash the run froze) that this host made
   * (createdBy workflow-runtime), unless something kept refers to them: the draft, any history 'before', any profile
   * proposal, a kept baseline (followed until closed), or `protectedIds` (other runs' own baselines). Same gate, hash
   * check and integrity rewrite as every planning write; any mismatch removes nothing. Never in the legacy root file.
   */
  pruneWorkflowBaselines(projectId: string, subprojectId: string, targets: readonly { readonly id: string; readonly hash: string }[], protectedIds: readonly string[], options: { readonly dryRun?: boolean } = {}): Promise<{ ok: true; removed: readonly string[] } | PlanningError> {
    if (subprojectId === 'legacy-default') return Promise.resolve({ ok: true, removed: [] });
    if (subprojectId !== this.options.subprojectId) {
      const service = this.scope(subprojectId);
      return service ? service.pruneWorkflowBaselines(projectId, subprojectId, targets, protectedIds, options) : Promise.resolve(failure('invalid', 'Invalid subproject identity.'));
    }
    return this.exclusive(projectId, async () => {
      const loaded = await this.load(projectId);
      if (!loaded.ok) return loaded;
      const snapshot = clone(loaded.file.snapshot);
      const owned = new Set(targets.filter(target => snapshot.baselines.some(baseline => baseline.id === target.id && baseline.hash === target.hash
        && baseline.createdBy.kind === 'user' && baseline.createdBy.id === 'workflow-runtime')).map(target => target.id));
      // Everything kept refers to: start from what is not a candidate, follow kept baselines until nothing new is reached.
      const kept = new Set(protectedIds);
      const referenced = (value: unknown): void => {
        if (Array.isArray(value)) { for (const entry of value) referenced(entry); return; }
        if (!value || typeof value !== 'object') return;
        for (const [key, entry] of Object.entries(value)) {
          if ((key === 'baselineId' || key === 'basedOnBaselineId') && typeof entry === 'string') kept.add(entry);
          else referenced(entry);
        }
      };
      referenced(snapshot.draft);
      for (const entry of snapshot.history) referenced(entry.before);
      referenced(snapshot.profileProposals);
      let grown = true;
      while (grown) {
        grown = false;
        for (const baseline of snapshot.baselines) {
          if (owned.has(baseline.id) && !kept.has(baseline.id)) continue;
          const before = kept.size;
          kept.add(baseline.id); referenced(baseline.draft);
          if (kept.size !== before) grown = true;
        }
      }
      const removed = [...owned].filter(id => !kept.has(id));
      // A dry run answers what would go, writing nothing (the cleanup list offers only those).
      if (!removed.length || options.dryRun) return { ok: true, removed };
      snapshot.baselines = snapshot.baselines.filter(baseline => !removed.includes(baseline.id));
      snapshot.revision += 1;
      const parsed = PlanningSnapshotSchema.safeParse(snapshot);
      if (!parsed.success) return failure('invalid', 'The planning file would not be valid after the cleanup.');
      await this.write(loaded.target, envelope(snapshot, loaded.file.receipts), loaded.bytesHash);
      return { ok: true, removed };
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
