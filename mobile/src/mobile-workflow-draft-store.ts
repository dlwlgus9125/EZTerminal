import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';
import { WorkflowDraftStateSchema, WorkflowDraftWriteSchema, type WorkflowDraftAccess, type WorkflowDraftResult } from '../../src/shared/workflow-draft';
import { mobileAgentCreateAuthorityFingerprint, type SecureStorageLike } from './mobile-agent-create-recovery-store';

// All access objects in this WebView serialize CAS operations against the same native store.
const queues = new WeakMap<SecureStorageLike, Map<string, Promise<unknown>>>();
async function exclusive<T>(secure: SecureStorageLike, key: string, work: () => Promise<T>): Promise<T> {
  let store = queues.get(secure); if (!store) { store = new Map(); queues.set(secure, store); }
  const previous = store.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work); store.set(key, next);
  try { return await next; } finally { if (store.get(key) === next) store.delete(key); }
}

/**
 * Android owns its encrypted workflow recovery; it never writes a desktop window's draft.
 * This version saves under the `-v3` key: recovery may hold remote protocol v18 flow fields that an
 * older app's strict schema rejects, so an older app keeps its own `-v2` (or `-v1`) value. A project
 * with no v3 value yet reads the newest older value once and moves to v3 on the next save.
 */
export function mobileWorkflowDraftAccess(getToken: () => Promise<string>, secure: SecureStorageLike = SecureStoragePlugin): WorkflowDraftAccess {
  const capture = async (projectId: string) => {
    const token = await getToken();
    const authority = await mobileAgentCreateAuthorityFingerprint(token);
    const check = async (): Promise<void> => { if (await getToken() !== token) throw new Error('The connected authority changed. Reopen workflow recovery for this host.'); };
    await check();
    const storageKey = `ezterminal-workflow-draft-v3:${authority.slice(7)}:${encodeURIComponent(projectId)}`;
    const legacyKeys = ['v2', 'v1'].map(version => `ezterminal-workflow-draft-${version}:${authority.slice(7)}:${encodeURIComponent(projectId)}`);
    const platform = await secure.getPlatform(); await check();
    if (platform.value !== 'android') throw new Error('Android secure workflow storage is unavailable.');
    return { storageKey, legacyKeys, check };
  };
  type Scope = Awaited<ReturnType<typeof capture>>;
  const readCaptured = async (projectId: string, { storageKey, legacyKeys, check }: Scope): Promise<WorkflowDraftResult> => {
    await check(); const keys = await secure.keys(); await check();
    const key = [storageKey, ...legacyKeys].find(candidate => keys.value.includes(candidate)) ?? null;
    if (!key) return { ok: true, snapshot: { projectId, revision: 0, state: null } };
    const raw = (await secure.get({ key })).value; await check();
    if (new TextEncoder().encode(raw).byteLength > 16 * 1024 * 1024) throw new Error('Workflow recovery is too large.');
    const stored = JSON.parse(raw) as { scope: string; revision: number; state: unknown };
    const state = WorkflowDraftStateSchema.parse(stored.state);
    if (stored.scope !== key || state.projectId !== projectId || !Number.isSafeInteger(stored.revision) || stored.revision < 0) throw new Error('Workflow recovery scope mismatch.');
    return { ok: true, snapshot: { projectId, revision: stored.revision, state, ...(key !== storageKey ? { olderVersion: true as const } : {}) } };
  };
  const failure = (reason: unknown): WorkflowDraftResult => ({ ok: false, error: 'unavailable', message: String(reason) });
  return {
    async workflowDraftRead(projectId) {
      try { const scope = await capture(projectId); return await exclusive(secure, scope.storageKey, () => readCaptured(projectId, scope)); }
      catch (reason) { return failure(reason); }
    },
    async workflowDraftWrite(projectId, input) {
      try {
        const request = WorkflowDraftWriteSchema.parse(input);
        const scope = await capture(projectId);
        return await exclusive(secure, scope.storageKey, async () => {
          const prior = await readCaptured(projectId, scope); if (!prior.ok) return prior;
          if (prior.snapshot.revision !== request.expectedRevision) return { ok: false, error: 'stale', message: 'The workflow recovery changed. Read it again before saving.' };
          if (request.state.projectId !== projectId || prior.snapshot.state && prior.snapshot.state.hostId !== request.state.hostId) throw new Error('Workflow recovery host or project mismatch.');
          const revision = prior.snapshot.revision + 1;
          const value = JSON.stringify({ scope: scope.storageKey, revision, state: request.state });
          if (new TextEncoder().encode(value).byteLength > 16 * 1024 * 1024) throw new Error('Workflow recovery is too large.');
          await scope.check(); const saved = await secure.set({ key: scope.storageKey, value }); await scope.check();
          if (!saved.value) throw new Error('Secure workflow write could not be verified.');
          const verified = await secure.get({ key: scope.storageKey }); await scope.check();
          if (verified.value !== value) throw new Error('Secure workflow write could not be verified.');
          return { ok: true, snapshot: { projectId, revision, state: request.state } };
        });
      } catch (reason) { return failure(reason); }
    },
  };
}
