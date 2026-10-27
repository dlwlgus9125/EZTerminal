import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';
import { z } from 'zod';
import { ConversationEntrySchema, type ConversationEntry } from '../../src/shared/conversation-history';
import { ChatStateSnapshotSchema, type ChatStateScope, type ChatStateResult, type ChatPendingCommand } from '../../src/shared/chat-state';
import type { ChatStateAccess } from '../../src/renderer/chat-recovery';
import { mobileAgentCreateAuthorityFingerprint, type SecureStorageLike } from './mobile-agent-create-recovery-store';
import { MobileChatStateStore, type MobileChatStateStoreLike } from './mobile-chat-state-store';

/** Device-local encrypted drafts; the PC fingerprint prevents cross-host restoration. */
const NavigationSchema = z.object({ draftId: z.string().min(1).max(160), target: z.object({ workspaceId: z.string().optional() }).optional(), entry: ConversationEntrySchema.optional() }).strict();
export interface MobileConversationNavigation { readonly draftId: string; readonly target?: { readonly workspaceId?: string }; readonly entry?: ConversationEntry }
export function mobileConversationState(
  getToken: () => Promise<string>,
  secure: SecureStorageLike = SecureStoragePlugin,
  /** A live conversation's draft record (tests pass their own). */
  legacy: MobileChatStateStoreLike = new MobileChatStateStore(secure),
): ChatStateAccess & {
  loadNavigation(): Promise<{ scope: string; value: MobileConversationNavigation | null }>;
  saveNavigation(value: MobileConversationNavigation): Promise<void>;
} {
  // A live conversation's record (schema 1, read by older builds too) has no revision of its own:
  // count writes here so a draft controller's next write expects the revision the last one returned.
  const legacyRevisions = new Map<string, number>();
  const legacyKey = (fingerprint: string, scope: ChatStateScope) => `${fingerprint}|${scope.projectId}|${scope.sessionId}`;
  let tail: Promise<unknown> = Promise.resolve();
  const authority = () => getToken().then(mobileAgentCreateAuthorityFingerprint);
  const keyFor = (fingerprint: string, scope: ChatStateScope) => `ezterminal-conversation-v2:${fingerprint}:${[scope.kind, scope.projectId, scope.sessionId].map(value => encodeURIComponent(value ?? '')).join(':')}`;
  const read = async (scope: ChatStateScope): Promise<ChatStateResult> => {
    try {
      const fingerprint = await authority();
      if (!scope.kind) {
        const saved = await legacy.load({ authorityFingerprint: fingerprint, projectId: scope.projectId, sessionId: scope.sessionId });
        return { ok: true, snapshot: { version: 1, scope, revision: legacyRevisions.get(legacyKey(fingerprint, scope)) ?? 0, state: { draft: saved?.draft ?? { text: '' }, ...(saved?.pending ? {
          pendingSubmit: { command: saved.pending as ChatPendingCommand, mode: saved.pending.type === 'agent.submit' ? 'send' as const : 'interrupt' as const, recordedAt: saved.pending.issuedAt },
        } : {}) }, updatedAt: null } };
      }
      if ((await secure.getPlatform()).value !== 'android') throw new Error('Secure Android storage is unavailable.');
      const key = keyFor(fingerprint, scope);
      if (!(await secure.keys()).value.includes(key)) return { ok: true, snapshot: { version: 2, scope, revision: 0, state: { draft: { text: '' } }, updatedAt: null } };
      const value = (await secure.get({ key })).value;
      if (new TextEncoder().encode(value).length > 4 * 1024 * 1024) throw new Error('Draft exceeds the secure storage limit.');
      const snapshot = ChatStateSnapshotSchema.parse(JSON.parse(value));
      if (snapshot.scope.kind !== scope.kind || snapshot.scope.projectId !== scope.projectId || snapshot.scope.sessionId !== scope.sessionId) throw new Error('Wrong conversation scope.');
      return { ok: true, snapshot };
    } catch (error) { return { ok: false, error: 'unavailable', message: String(error) }; }
  };
  return {
    loadNavigation: async () => {
      const fingerprint = await authority();
      if ((await secure.getPlatform()).value !== 'android') throw new Error('Secure Android storage is unavailable.');
      const key = `ezterminal-conversation-navigation-v2:${fingerprint}`;
      const value = (await secure.keys()).value.includes(key) ? NavigationSchema.parse(JSON.parse((await secure.get({ key })).value)) : null;
      return { scope: `android:${fingerprint}`, value };
    },
    saveNavigation: value => {
      const write = tail.then(async () => {
        const fingerprint = await authority();
        if ((await secure.getPlatform()).value !== 'android') throw new Error('Secure Android storage is unavailable.');
        const result = await secure.set({ key: `ezterminal-conversation-navigation-v2:${fingerprint}`, value: JSON.stringify(NavigationSchema.parse(value)) });
        if (!result.value) throw new Error('The selected conversation could not be saved.');
      });
      tail = write.catch(() => undefined);
      return write;
    },
    chatStateRead: read, chatStateWrite: (scope, request) => {
    const write = tail.then(async (): Promise<ChatStateResult> => {
      const current = await read(scope); if (!current.ok) return current;
      if (current.snapshot.revision !== request.expectedRevision) return { ok: false, error: 'stale', message: 'This draft changed. Read stored state before retrying.' };
      try {
        const fingerprint = await authority();
        const snapshot = ChatStateSnapshotSchema.parse({ ...current.snapshot, revision: request.expectedRevision + 1, state: request.state, updatedAt: new Date().toISOString() });
        if (!scope.kind) {
          await legacy.save({ schemaVersion: 1, scope: { authorityFingerprint: fingerprint, projectId: scope.projectId, sessionId: scope.sessionId }, draft: request.state.draft, ...(request.state.pendingSubmit ? { pending: request.state.pendingSubmit.command } : {}) });
          legacyRevisions.set(legacyKey(fingerprint, scope), snapshot.revision);
        }
        else {
          const value = JSON.stringify(snapshot);
          if (new TextEncoder().encode(value).length > 4 * 1024 * 1024) throw new Error('Draft exceeds the secure storage limit.');
          const saved = await secure.set({ key: keyFor(fingerprint, scope), value });
          if (!saved.value) throw new Error('The draft could not be saved.');
        }
        return { ok: true, snapshot };
      } catch (error) { return { ok: false, error: 'unavailable', message: String(error) }; }
    });
    tail = write.catch(() => undefined);
    return write;
  } };
}
