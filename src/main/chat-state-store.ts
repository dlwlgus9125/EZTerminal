import { createHash } from 'node:crypto';

import {
  ChatStateScopeSchema, ChatStateSnapshotSchema, ChatStateWriteSchema,
  type ChatStateResult, type ChatStateScope, type ChatStateSnapshot,
} from '../shared/chat-state';
import { SecureAtomicFile, type SecureAtomicFileOptions } from './secure-atomic-file';

const MAX_PROTECTED_STATE_BYTES = 4 * 1024 * 1024;
export interface ChatStateStoreOptions extends SecureAtomicFileOptions {
  readonly directory: string;
  readonly protector: {
    readonly available: () => boolean;
    readonly encrypt: (plaintext: string) => Buffer | Promise<Buffer>;
    readonly decrypt: (ciphertext: Buffer) => string | Promise<string>;
  };
  readonly resolveScope: (scope: ChatStateScope) => boolean | Promise<boolean>;
  readonly now?: () => Date;
}

/** Encrypted, device-local composition and exact-submit recovery; never a conversation authority. */
export class ChatStateStore {
  private readonly files = new Map<string, Promise<SecureAtomicFile>>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly options: ChatStateStoreOptions) {}

  read(scopeValue: unknown): Promise<ChatStateResult> {
    return this.access(scopeValue, async (file, scope) => this.readFile(file, scope));
  }

  write(scopeValue: unknown, value: unknown): Promise<ChatStateResult> {
    const parsed = ChatStateWriteSchema.safeParse(value);
    if (!parsed.success) return Promise.resolve({ ok: false, error: 'invalid', message: 'Invalid chat draft or pending submission.' });
    return this.access(scopeValue, async (file, scope) => {
      const current = await this.readFile(file, scope);
      if (!current.ok) return current;
      if (current.snapshot.revision !== parsed.data.expectedRevision) return {
        ok: false, error: 'stale', message: 'This conversation draft changed in another window. Read and compare it before saving.', revision: current.snapshot.revision,
      };
      const candidate = ChatStateSnapshotSchema.safeParse({
        version: scope.kind ? 2 : 1, scope, revision: current.snapshot.revision + 1, state: parsed.data.state,
        updatedAt: (this.options.now?.() ?? new Date()).toISOString(),
      });
      if (!candidate.success) return { ok: false, error: 'invalid', message: 'The draft or pending request belongs to a different conversation.' };
      const plaintext = JSON.stringify(candidate.data);
      const protectedState = Buffer.from(await this.options.protector.encrypt(plaintext));
      if (!protectedState.length) throw new Error('Encryption returned no data.');
      await file.writeAtomic(JSON.stringify({ version: 1, protectedState: protectedState.toString('base64') }));
      return { ok: true, snapshot: candidate.data };
    });
  }

  async flush(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); }

  private access(scopeValue: unknown, operation: (file: SecureAtomicFile, scope: ChatStateScope) => Promise<ChatStateResult>): Promise<ChatStateResult> {
    const scope = ChatStateScopeSchema.safeParse(scopeValue);
    if (!scope.success) return Promise.resolve({ ok: false, error: 'invalid', message: 'Invalid conversation identity.' });
    const result = (async (): Promise<ChatStateResult> => {
      try {
        if (!await this.options.resolveScope(scope.data)) return { ok: false, error: 'forbidden', message: 'This conversation is unavailable in the authorized project.' };
        if (!this.options.protector.available()) return { ok: false, error: 'unavailable', message: 'Secure draft storage is unavailable. Keep this window open to preserve the unsaved draft.' };
        const file = await this.file(scope.data);
        return await file.enqueue(async () => {
          // Recheck authority after waiting behind another window's disk write.
          if (!await this.options.resolveScope(scope.data)) return { ok: false, error: 'forbidden', message: 'The conversation identity changed before draft storage.' };
          return operation(file, scope.data);
        });
      } catch {
        return { ok: false, error: 'unavailable', message: 'The encrypted chat state could not be saved or read. Keep the unsaved draft and check stored state before retrying.' };
      }
    })();
    this.pending.add(result);
    void result.finally(() => this.pending.delete(result));
    return result;
  }

  private file(scope: ChatStateScope): Promise<SecureAtomicFile> {
    const identity = createHash('sha256').update(JSON.stringify(scope.kind ? [scope.projectId, scope.kind, scope.sessionId] : [scope.projectId, scope.sessionId])).digest('hex');
    let initialized = this.files.get(identity);
    if (!initialized) {
      const file = new SecureAtomicFile(this.options.directory, `${identity}.bin`, {
        platform: this.options.platform, windowsAcl: this.options.windowsAcl, maxBytes: MAX_PROTECTED_STATE_BYTES,
      });
      initialized = file.init().then(() => file).catch((error: unknown) => { this.files.delete(identity); throw error; });
      this.files.set(identity, initialized);
    }
    return initialized;
  }

  private async readFile(file: SecureAtomicFile, scope: ChatStateScope): Promise<ChatStateResult> {
    const stored = await file.readText();
    if (stored === undefined) return { ok: true, snapshot: { version: 1, scope, revision: 0, state: { draft: { text: '' } }, updatedAt: null } };
    try {
      const envelope = JSON.parse(stored) as { version?: unknown; protectedState?: unknown };
      if (envelope.version !== 1 || typeof envelope.protectedState !== 'string' || Object.keys(envelope).length !== 2) throw new Error('Invalid ciphertext.');
      const ciphertext = Buffer.from(envelope.protectedState, 'base64');
      if (!ciphertext.length || ciphertext.toString('base64') !== envelope.protectedState) throw new Error('Invalid ciphertext.');
      const snapshot: ChatStateSnapshot = ChatStateSnapshotSchema.parse(JSON.parse(await this.options.protector.decrypt(ciphertext)));
      if (snapshot.scope.projectId !== scope.projectId || snapshot.scope.sessionId !== scope.sessionId || snapshot.scope.kind !== scope.kind) throw new Error('Wrong conversation.');
      return { ok: true, snapshot };
    } catch {
      return { ok: false, error: 'corrupt', message: 'Encrypted chat recovery data could not be verified. The original file was preserved.' };
    }
  }
}
