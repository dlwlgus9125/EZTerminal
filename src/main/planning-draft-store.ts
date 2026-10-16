import { createHash } from 'node:crypto';
import {
  PlanningDraftProjectIdSchema, PlanningDraftSnapshotSchema, PlanningDraftWriteSchema,
  type PlanningDraftResult,
} from '../shared/planning-draft';
import { SecureAtomicFile, type SecureAtomicFileOptions } from './secure-atomic-file';

export interface PlanningDraftStoreOptions extends SecureAtomicFileOptions {
  readonly directory: string;
  readonly protector: {
    readonly available: () => boolean;
    readonly encrypt: (plaintext: string) => Buffer | Promise<Buffer>;
    readonly decrypt: (ciphertext: Buffer) => string | Promise<string>;
  };
  readonly resolveProject: (projectId: string) => boolean | Promise<boolean>;
  readonly resolveSubproject?: (projectId: string, subprojectId: string) => boolean | Promise<boolean>;
  readonly now?: () => Date;
}

/** Device recovery for unsaved edits; project.json remains the planning authority. */
export class PlanningDraftStore {
  private readonly files = new Map<string, Promise<SecureAtomicFile>>();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly options: PlanningDraftStoreOptions) {}

  read(projectId: unknown, subprojectId?: unknown): Promise<PlanningDraftResult> {
    return this.access(projectId, (file, id) => this.readFile(file, id, subprojectId as string | undefined), subprojectId);
  }

  write(projectId: unknown, request: unknown, subprojectId?: unknown): Promise<PlanningDraftResult> {
    const parsed = PlanningDraftWriteSchema.safeParse(request);
    if (!parsed.success) return Promise.resolve({ ok: false, error: 'invalid', message: 'Invalid planning recovery data.' });
    return this.access(projectId, async (file, id) => {
      if (parsed.data.state.projectId !== id) return { ok: false, error: 'invalid', message: 'Planning recovery belongs to another project.' };
      if (parsed.data.state.subprojectId !== subprojectId) return { ok: false, error: 'invalid', message: 'Planning recovery belongs to another subproject.' };
      const current = await this.readFile(file, id, subprojectId as string | undefined);
      if (!current.ok) return current;
      if (current.snapshot.revision !== parsed.data.expectedRevision) return { ok: false, error: 'stale', revision: current.snapshot.revision, message: 'Another window changed the planning draft. Your local edits are preserved; compare stored recovery before saving.' };
      const snapshot = PlanningDraftSnapshotSchema.parse({ version: 1, projectId: id, revision: current.snapshot.revision + 1,
        state: parsed.data.state, ...(subprojectId ? { subprojectId } : {}), updatedAt: (this.options.now?.() ?? new Date()).toISOString() });
      const plaintext = JSON.stringify(snapshot);
      if (Buffer.byteLength(plaintext, 'utf8') > 8 * 1024 * 1024) return { ok: false, error: 'invalid', message: 'Planning recovery exceeds the 8 MiB device storage limit.' };
      const ciphertext = Buffer.from(await this.options.protector.encrypt(plaintext));
      if (!ciphertext.length) throw new Error('Encryption failed.');
      await file.writeAtomic(JSON.stringify({ version: 1, protectedState: ciphertext.toString('base64') }));
      return { ok: true, snapshot };
    }, subprojectId);
  }

  async flush(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); }

  private access(projectValue: unknown, operation: (file: SecureAtomicFile, id: string) => Promise<PlanningDraftResult>, subprojectId?: unknown): Promise<PlanningDraftResult> {
    const project = PlanningDraftProjectIdSchema.safeParse(projectValue);
    if (!project.success) return Promise.resolve({ ok: false, error: 'invalid', message: 'Invalid planning project identity.' });
    if (subprojectId !== undefined && !PlanningDraftProjectIdSchema.safeParse(subprojectId).success) return Promise.resolve({ ok: false, error: 'invalid', message: 'Invalid subproject identity.' });
    const result = (async (): Promise<PlanningDraftResult> => {
      try {
        if (!await this.options.resolveProject(project.data)) return { ok: false, error: 'forbidden', message: 'Planning recovery is unavailable for this project.' };
        if (subprojectId && !await this.options.resolveSubproject?.(project.data, subprojectId as string)) return { ok: false, error: 'forbidden', message: 'The subproject is unavailable.' };
        if (!this.options.protector.available()) return { ok: false, error: 'unavailable', message: 'Secure planning storage is unavailable. Keep this window open to preserve unsaved edits.' };
        const file = await this.file(subprojectId && subprojectId !== 'legacy-default' ? `${project.data}\0${subprojectId}` : project.data);
        return await file.enqueue(async () => {
          if (!await this.options.resolveProject(project.data)) return { ok: false, error: 'forbidden', message: 'Project authorization changed before recovery storage.' };
          return operation(file, project.data);
        });
      } catch {
        return { ok: false, error: 'unavailable', message: 'Encrypted planning recovery could not be saved or read. Keep local edits and check stored state before retrying.' };
      }
    })();
    this.pending.add(result);
    void result.finally(() => this.pending.delete(result));
    return result;
  }

  private file(projectId: string): Promise<SecureAtomicFile> {
    const identity = createHash('sha256').update(projectId).digest('hex');
    let initialized = this.files.get(identity);
    if (!initialized) {
      const file = new SecureAtomicFile(this.options.directory, `${identity}.bin`, {
        platform: this.options.platform, windowsAcl: this.options.windowsAcl, maxBytes: 12 * 1024 * 1024,
      });
      initialized = file.init().then(() => file).catch((error: unknown) => { this.files.delete(identity); throw error; });
      this.files.set(identity, initialized);
    }
    return initialized;
  }

  private async readFile(file: SecureAtomicFile, projectId: string, subprojectId?: string): Promise<PlanningDraftResult> {
    const raw = await file.readText();
    if (raw === undefined) return { ok: true, snapshot: { version: 1, projectId, ...(subprojectId ? { subprojectId } : {}), revision: 0, state: null, updatedAt: null } };
    try {
      const envelope = JSON.parse(raw) as { version?: unknown; protectedState?: unknown };
      if (envelope.version !== 1 || typeof envelope.protectedState !== 'string' || Object.keys(envelope).length !== 2) throw new Error('Invalid ciphertext.');
      const ciphertext = Buffer.from(envelope.protectedState, 'base64');
      if (!ciphertext.length || ciphertext.toString('base64') !== envelope.protectedState) throw new Error('Invalid ciphertext.');
      const plain = await this.options.protector.decrypt(ciphertext);
      if (Buffer.byteLength(plain, 'utf8') > 8 * 1024 * 1024) throw new Error('Oversized recovery.');
      const snapshot = PlanningDraftSnapshotSchema.parse(JSON.parse(plain));
      if (snapshot.projectId !== projectId) throw new Error('Wrong project.');
      if (snapshot.subprojectId !== subprojectId && !(subprojectId === 'legacy-default' && snapshot.subprojectId === undefined)) throw new Error('Wrong subproject.');
      return { ok: true, snapshot };
    } catch { return { ok: false, error: 'corrupt', message: 'Encrypted planning recovery could not be verified. The original file was preserved.' }; }
  }
}
