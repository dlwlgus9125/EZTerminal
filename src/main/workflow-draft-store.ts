import { createHash } from 'node:crypto';
import { WorkflowDraftWriteSchema, WorkflowDraftResultSchema, type WorkflowDraftResult } from '../shared/workflow-draft';
import { WorkflowIdSchema } from '../shared/workflow';
import { SecureAtomicFile } from './secure-atomic-file';
import type { PlanningDraftStoreOptions } from './planning-draft-store';

/**
 * Device-local encrypted graph recovery, separate from both authoritative graphs and document drafts.
 * Recovery written by this version lives in `<id>.v2.bin`: it may hold flow fields of remote protocol
 * v17 that an older build's strict schema rejects, so an older build keeps reading its own `<id>.bin`.
 * A project with no v2 file yet reads the older file once and moves to v2 on the next save.
 */
export class WorkflowDraftStore {
  private readonly files = new Map<string, Promise<SecureAtomicFile>>();
  constructor(private readonly options: PlanningDraftStoreOptions & { hostId: string }) {}
  read(projectId: unknown): Promise<WorkflowDraftResult> { return this.access(projectId, (file, legacy, id) => this.readFile(file, id, legacy)); }
  write(projectId: unknown, value: unknown): Promise<WorkflowDraftResult> {
    const parsed = WorkflowDraftWriteSchema.safeParse(value);
    if (!parsed.success) return Promise.resolve({ ok: false, error: 'invalid', message: 'Invalid workflow recovery data.' });
    return this.access(projectId, async (file, legacy, id) => {
      if (parsed.data.state.projectId !== id || parsed.data.state.hostId !== this.options.hostId) return { ok: false, error: 'forbidden', message: 'Recovery belongs to another host or project.' };
      const current = await this.readFile(file, id, legacy); if (!current.ok) return current;
      if (current.snapshot.revision !== parsed.data.expectedRevision) return { ok: false, error: 'stale', message: 'Another window changed workflow recovery. Preserve local edits and compare the stored draft.' };
      const snapshot = { projectId: id, revision: current.snapshot.revision + 1, state: parsed.data.state };
      const plain = JSON.stringify(snapshot); if (Buffer.byteLength(plain) > 8 * 1024 * 1024) return { ok: false, error: 'invalid', message: 'Workflow recovery exceeds 8 MiB.' };
      const encrypted = await this.options.protector.encrypt(plain); if (!encrypted.length) throw new Error('Encryption failed.');
      await file.writeAtomic(JSON.stringify({ version: 1, protectedState: encrypted.toString('base64') })); return { ok: true, snapshot };
    });
  }
  private async access(projectId: unknown, operation: (file: SecureAtomicFile, legacy: SecureAtomicFile, id: string) => Promise<WorkflowDraftResult>): Promise<WorkflowDraftResult> {
    const parsed = WorkflowIdSchema.safeParse(projectId); if (!parsed.success) return { ok: false, error: 'invalid', message: 'Invalid project identity.' };
    try {
      if (!await this.options.resolveProject(parsed.data)) return { ok: false, error: 'forbidden', message: 'This project is unavailable.' };
      if (!this.options.protector.available()) throw new Error('Secure storage unavailable.');
      const identity = createHash('sha256').update(`${this.options.hostId}\0${parsed.data}`).digest('hex');
      const open = (name: string): Promise<SecureAtomicFile> => {
        let initialized = this.files.get(name);
        if (!initialized) {
          const file = new SecureAtomicFile(this.options.directory, name, { platform: this.options.platform, windowsAcl: this.options.windowsAcl, maxBytes: 12 * 1024 * 1024 });
          initialized = file.init().then(() => file); this.files.set(name, initialized);
        }
        return initialized;
      };
      const [file, legacy] = await Promise.all([open(`${identity}.v2.bin`), open(`${identity}.bin`)]);
      return await file.enqueue(async () => { if (!await this.options.resolveProject(parsed.data)) return { ok: false, error: 'forbidden', message: 'Project authorization changed.' }; return operation(file, legacy, parsed.data); });
    } catch { return { ok: false, error: 'unavailable', message: 'Encrypted workflow recovery is unavailable. Keep local edits and the exact pending command.' }; }
  }
  private async readFile(file: SecureAtomicFile, projectId: string, legacy?: SecureAtomicFile): Promise<WorkflowDraftResult> {
    const raw = await file.readText();
    if (raw === undefined) {
      if (!legacy) return { ok: true, snapshot: { projectId, revision: 0, state: null } };
      // What an older build kept: its graphs are a reduced view (see WorkflowDraftResultSchema).
      const older = await this.readFile(legacy, projectId);
      return older.ok && older.snapshot.state ? { ...older, snapshot: { ...older.snapshot, olderVersion: true } } : older;
    }
    try {
      const envelope = JSON.parse(raw) as { version: number; protectedState: string };
      if (envelope.version !== 1 || typeof envelope.protectedState !== 'string') throw new Error('Invalid envelope.');
      const encrypted = Buffer.from(envelope.protectedState, 'base64'); if (!encrypted.length || encrypted.toString('base64') !== envelope.protectedState) throw new Error('Invalid ciphertext.');
      const plain = await this.options.protector.decrypt(encrypted); if (Buffer.byteLength(plain) > 8 * 1024 * 1024) throw new Error('Oversized recovery.');
      const parsed = WorkflowDraftResultSchema.parse({ ok: true, snapshot: JSON.parse(plain) });
      if (!parsed.ok || parsed.snapshot.projectId !== projectId || parsed.snapshot.state && parsed.snapshot.state.hostId !== this.options.hostId) throw new Error('Recovery scope mismatch.');
      return parsed;
    } catch { return { ok: false, error: 'corrupt', message: 'Workflow recovery could not be verified. The encrypted file was preserved.' }; }
  }
}
