import type { ChatComposerDraft } from '../shared/chat-message';
import {
  ChatStateResultSchema, type ChatPendingCommand, type ChatSessionState, type ChatStateResult,
  type ChatStateScope, type ChatStateSnapshot, type ChatStateWrite,
} from '../shared/chat-state';

export interface ChatStateAccess {
  readonly chatStateRead: (scope: ChatStateScope) => Promise<ChatStateResult>;
  readonly chatStateWrite: (scope: ChatStateScope, request: ChatStateWrite) => Promise<ChatStateResult>;
}
export interface ChatRecoveryView extends ChatSessionState {
  readonly status: 'loading' | 'ready' | 'error' | 'conflict';
  readonly message?: string;
  readonly conflict?: ChatStateSnapshot;
  /** The draft shown is newer than the stored one (an autosave is still to finish). */
  readonly unsaved?: boolean;
}
export type ChatRecoveryResult = { readonly ok: true } | { readonly ok: false; readonly message: string; readonly deliveryUncertain?: boolean };
const unavailable = 'Secure draft storage is unavailable. Your current draft is still in this window.';
const conflictMessage = 'Another window changed this conversation draft. Compare both drafts before saving.';
const equalDraft = (left: ChatComposerDraft, right: ChatComposerDraft): boolean => JSON.stringify(left) === JSON.stringify(right);
/** The same message being written (the caret may have moved). */
const sameComposition = (left: ChatComposerDraft, right: ChatComposerDraft): boolean => left.text === right.text
  && JSON.stringify(left.attachments ?? []) === JSON.stringify(right.attachments ?? [])
  && JSON.stringify(left.skills ?? []) === JSON.stringify(right.skills ?? [])
  && JSON.stringify(left.replyTo) === JSON.stringify(right.replyTo);

/** Serializes autosave and submit escrow against the host revision without replaying commands. */
export class ChatRecoveryController {
  private view: ChatRecoveryView = { status: 'loading', draft: { text: '' } };
  private revision = 0;
  private edits = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private lastSaved = '';
  private initialLoad: Promise<void> | undefined;
  private autosaveScheduled = false;
  /** The composition as it was when this controller escrowed a message: an edit made while it is delivered stays. */
  private sentComposition: { readonly commandId: string; readonly draft: ChatComposerDraft } | undefined;

  constructor(readonly scope: ChatStateScope, private readonly access: ChatStateAccess) {}

  getSnapshot = (): ChatRecoveryView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  load(): Promise<void> {
    if (this.initialLoad) return this.initialLoad;
    const initialEdits = this.edits;
    const hasEarlyDraft = initialEdits > 0;
    this.initialLoad = this.enqueue(async () => {
      const result = await this.read();
      if (!result.ok) { this.set({ ...this.view, status: 'error', message: result.message }); return; }
      this.revision = result.snapshot.revision;
      this.lastSaved = JSON.stringify(result.snapshot.state);
      const draft = !hasEarlyDraft && this.edits === initialEdits ? result.snapshot.state.draft : this.view.draft;
      this.set({ ...result.snapshot.state, draft, status: 'ready' });
      if (hasEarlyDraft || this.edits !== initialEdits) await this.persist();
    });
    return this.initialLoad;
  }

  updateDraft = (draft: ChatComposerDraft): void => {
    if (equalDraft(draft, this.view.draft)) return;
    // Focusing the newly mounted empty textarea emits a caret update before
    // encrypted recovery returns. It is not a user edit and must not win over
    // the saved composition. Real text/context edits during loading still win.
    if (this.view.status === 'loading' && draft.text === this.view.draft.text
      && JSON.stringify(draft.attachments ?? []) === JSON.stringify(this.view.draft.attachments ?? [])
      && JSON.stringify(draft.replyTo) === JSON.stringify(this.view.draft.replyTo)
      && JSON.stringify(draft.skills ?? []) === JSON.stringify(this.view.draft.skills ?? [])) return;
    this.edits += 1;
    this.set({ ...this.view, draft, unsaved: true });
    if (this.view.status !== 'ready' || this.autosaveScheduled) return;
    this.autosaveScheduled = true;
    void this.enqueue(async () => {
      this.autosaveScheduled = false;
      if (this.view.status === 'ready') await this.persist();
    });
  };

  saveComposition(patch: Pick<ChatSessionState, 'start' | 'settings' | 'view' | 'history' | 'importedDraftSessionIds'>): Promise<ChatRecoveryResult> {
    return this.enqueue(async () => {
      if (this.view.status !== 'ready') return { ok: false, message: this.view.message ?? unavailable };
      this.set({ ...this.view, ...patch });
      return this.persist();
    });
  }

  prepare(command: ChatPendingCommand): Promise<ChatRecoveryResult> {
    return this.enqueue(async () => {
      if (this.view.status !== 'ready') return { ok: false, message: this.view.message ?? 'Secure draft recovery is still loading.' };
      if (this.view.pendingSubmit) return { ok: false, message: 'Check the previous message delivery before sending again.', deliveryUncertain: true };
      this.set({ ...this.view, pendingSubmit: { command, mode: command.type === 'agent.submit' ? 'send' : 'interrupt', recordedAt: new Date().toISOString() } });
      this.sentComposition = { commandId: command.commandId, draft: this.view.draft };
      const result = await this.persist();
      if (!result.ok) {
        // No command was dispatched. An ambiguous storage result must be read
        // before another envelope is allowed to replace this one.
        this.set({ ...this.view, pendingSubmit: undefined });
      }
      return result;
    });
  }

  complete(commandId: string, accepted: boolean): Promise<ChatRecoveryResult> {
    return this.enqueue(async () => {
      const pending = this.view.pendingSubmit;
      if (!pending || pending.command.commandId !== commandId) return { ok: false, message: 'The pending submission changed. Reload recovery data before continuing.', deliveryUncertain: true };
      if (this.view.status !== 'ready') return { ok: false, message: this.view.message ?? unavailable, deliveryUncertain: true };
      const { prompt, context } = pending.command.payload;
      const draft = this.view.draft;
      // Sent from here: only the exact composition sent is cleared. Settled after a restart: the stored draft
      // is compared with the message (the composition at send time is not kept across restarts).
      const sent = this.sentComposition?.commandId === commandId ? this.sentComposition.draft : undefined;
      this.sentComposition = undefined;
      const clear = accepted && (!sent || sameComposition(draft, sent)) && draft.text.trim() === prompt
        && JSON.stringify(draft.attachments ?? []) === JSON.stringify(context?.attachments ?? [])
        && JSON.stringify((draft.skills ?? []).filter((skill) => draft.text.includes(skill.invocation))) === JSON.stringify(context?.skills ?? [])
        && JSON.stringify(draft.replyTo) === JSON.stringify(context?.replyTo);
      this.set({ status: 'ready', draft: clear ? { text: '', selectionStart: 0, selectionEnd: 0 } : draft });
      const result = await this.persist();
      if (!result.ok) {
        this.set({ ...this.view, pendingSubmit: pending });
        return { ...result, deliveryUncertain: true };
      }
      return result;
    });
  }

  /** Explicit recovery never overwrites a local draft with a later host revision. */
  checkStored = (): Promise<void> => this.enqueue(async () => {
    const result = await this.read();
    if (!result.ok) { this.set({ ...this.view, status: 'error', message: result.message }); return; }
    if (!equalDraft(result.snapshot.state.draft, this.view.draft)) {
      this.set({ ...this.view, status: 'conflict', message: conflictMessage, conflict: result.snapshot });
      return;
    }
    this.revision = result.snapshot.revision;
    this.lastSaved = JSON.stringify(result.snapshot.state);
    this.set({ ...result.snapshot.state, status: 'ready' });
  });

  resolveConflict = (choice: 'local' | 'stored'): Promise<ChatRecoveryResult> => this.enqueue(async () => {
    const snapshot = this.view.conflict;
    if (!snapshot) return { ok: false, message: 'Read stored recovery data before choosing a draft.' };
    const draft = choice === 'local' ? this.view.draft : snapshot.state.draft;
    this.revision = snapshot.revision;
    this.lastSaved = JSON.stringify(snapshot.state);
    // Always retain the current host's pending envelope; a draft choice is
    // never permission to replace or resend another window's submission.
    this.set({ ...snapshot.state, draft, status: 'ready' });
    return this.persist();
  });

  async flush(): Promise<void> { for (;;) { const tail = this.chain; await tail; if (tail === this.chain) return; } }

  private async persist(): Promise<ChatRecoveryResult> {
    const state: ChatSessionState = { draft: this.view.draft, ...(this.view.pendingSubmit ? { pendingSubmit: this.view.pendingSubmit } : {}),
      ...(this.view.start ? { start: this.view.start } : {}), ...(this.view.settings ? { settings: this.view.settings } : {}), ...(this.view.view ? { view: this.view.view } : {}) };
    if (this.view.history) Object.assign(state, { history: this.view.history });
    if (this.view.importedDraftSessionIds) Object.assign(state, { importedDraftSessionIds: this.view.importedDraftSessionIds });
    const serialized = JSON.stringify(state);
    if (serialized === this.lastSaved) return { ok: true };
    let result: ChatStateResult;
    try { result = ChatStateResultSchema.parse(await this.access.chatStateWrite(this.scope, { expectedRevision: this.revision, state })); }
    catch { result = { ok: false, error: 'unavailable', message: unavailable }; }
    if (!result.ok) {
      if (result.error === 'stale') {
        const current = await this.read();
        this.set({ ...this.view, status: 'conflict', message: conflictMessage, ...(current.ok ? { conflict: current.snapshot } : {}) });
      } else this.set({ ...this.view, status: 'error', message: result.message });
      return { ok: false, message: this.view.message ?? unavailable };
    }
    if (result.snapshot.scope.projectId !== this.scope.projectId || result.snapshot.scope.sessionId !== this.scope.sessionId || result.snapshot.scope.kind !== this.scope.kind) {
      this.set({ ...this.view, status: 'error', message: 'Stored draft identity did not match this conversation.' });
      return { ok: false, message: this.view.message! };
    }
    this.revision = result.snapshot.revision;
    this.lastSaved = serialized;
    if (this.view.unsaved && equalDraft(this.view.draft, state.draft)) this.set({ ...this.view, unsaved: false });
    return { ok: true };
  }

  private async read(): Promise<ChatStateResult> {
    try {
      const result = ChatStateResultSchema.parse(await this.access.chatStateRead(this.scope));
      if (result.ok && (result.snapshot.scope.projectId !== this.scope.projectId || result.snapshot.scope.sessionId !== this.scope.sessionId || result.snapshot.scope.kind !== this.scope.kind)) throw new Error('Wrong conversation');
      return result;
    } catch { return { ok: false, error: 'unavailable', message: unavailable }; }
  }
  private set(view: ChatRecoveryView): void { this.view = view; for (const listener of this.listeners) listener(); }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }
}
