import { createDaemonCommand, type DaemonCommand, type DaemonCommandReceipt, type DaemonPrincipal, type DaemonSnapshot, type PermissionPreset } from '../shared/daemon-protocol';
import type { ChatMessageContext } from '../shared/chat-message';
import { ChatMessageContextSchema } from '../shared/chat-message';
import type { ConversationHistoryClient } from '../shared/conversation-history';
import type { ConversationSettings, ConversationStart } from '../shared/conversation-start';
import { conversationOperationId } from '../shared/conversation-start';
import type { AccessLevel } from './agent-permission-copy';
import { ChatRecoveryController } from './chat-recovery';
import { structuredAgentSessionTitle } from './structured-agent-create';

export interface ConversationStartAccess {
  getSnapshot(): Promise<DaemonSnapshot | null>;
  sendCommand(command: DaemonCommand): Promise<DaemonCommandReceipt | null>;
  history: ConversationHistoryClient;
  principal: DaemonPrincipal;
}
/**
 * What the start form begins with. A previous conversation continues with what it last ran with —
 * the host's resume preparation (`source`) — never with another conversation's settings; a new
 * conversation starts with the AI and model of the most recent one in the project and the access
 * level the person last chose (`lastAccess`), never another conversation's plan mode; and one
 * `/clear` opened starts with exactly what the cleared conversation ran with (`seed`).
 */
/**
 * Why a previous conversation cannot be continued here, as the host prepared it (its work folder is gone, its
 * provider is not ready...): `null` when it can, or when the host could not say (sending then tries and reports).
 */
export function historyResumeBlock(prepared: { readonly ok: boolean; readonly canResume?: boolean; readonly message?: string }): { readonly message?: string } | null {
  if (!prepared.ok || prepared.canResume !== false) return null;
  return prepared.message ? { message: prepared.message } : {};
}

export function initialConversationSettings(input: {
  readonly entry?: { readonly providerId: string; readonly workspaceId?: string };
  readonly seed?: ConversationSettings;
  readonly recent?: { readonly providerId: string; readonly model?: string; readonly permissionPreset: PermissionPreset };
  readonly source?: { readonly model?: string; readonly permissionPreset: PermissionPreset } | null;
  readonly lastAccess?: AccessLevel;
  readonly fallbackProviderId?: string;
  readonly fallbackWorkspaceId?: string;
}): ConversationSettings {
  const { entry, seed, recent, source } = input;
  if (!entry && seed) return seed;
  if (entry) {
    return {
      providerId: entry.providerId,
      workspaceId: entry.workspaceId ?? input.fallbackWorkspaceId ?? '',
      ...(source?.model ? { model: source.model } : {}),
      permissionPreset: source?.permissionPreset ?? 'standard',
    };
  }
  return {
    providerId: recent?.providerId ?? input.fallbackProviderId ?? '',
    workspaceId: input.fallbackWorkspaceId ?? '',
    ...(recent?.model ? { model: recent.model } : {}),
    permissionPreset: input.lastAccess ?? (recent && recent.permissionPreset !== 'plan' ? recent.permissionPreset : 'standard'),
  };
}

export type ConversationStarted = { ok: true; sessionId: string; conversationId?: string } | { ok: false; message: string; deliveryUncertain?: boolean };
const newId = conversationOperationId;

/** Shared desktop/Android first-send transaction. All advancement requires an explicit user send/retry. */
export class ConversationStartController {
  private running = false;
  constructor(private readonly recovery: ChatRecoveryController, private readonly access: ConversationStartAccess) {}

  async send(settings: ConversationSettings, prompt: string, context?: ChatMessageContext, conversationId?: string): Promise<ConversationStarted> {
    if (this.running) return { ok: false, message: 'A message is already being prepared.' };
    this.running = true;
    try {
      await this.recovery.load();
      if (this.recovery.getSnapshot().status !== 'ready') return { ok: false, message: this.recovery.getSnapshot().message ?? 'Draft storage is unavailable.' };
      let pending: ConversationStart = this.recovery.getSnapshot().start ?? { id: newId(), settings, prompt, ...(context ? { context: ChatMessageContextSchema.parse(context) } : {}), ...(conversationId ? { conversationId } : {}) };
      const save = async (next: ConversationStart): Promise<void> => {
        const saved = await this.recovery.saveComposition({ start: next });
        if (!saved.ok) throw new Error(saved.message);
        pending = next;
      };
      await save(pending);
      const snapshot = await this.access.getSnapshot();
      if (!snapshot) return { ok: false, message: 'Reconnect to the PC to send. Your draft is saved.' };
      if (!pending.sessionId) {
        if (pending.conversationId) {
          if (!pending.resume) {
            const prepared = await this.access.history.prepareHistoryResume({ conversationId: pending.conversationId, model: pending.settings.model, permissionPreset: pending.settings.permissionPreset });
            if (!prepared.ok) return prepared;
            if (!prepared.canResume) return { ok: false, message: prepared.message ?? 'This conversation cannot currently continue.' };
            if (prepared.action === 'open' && prepared.linkedSessionId) await save({ ...pending, sessionId: prepared.linkedSessionId });
            else await save({ ...pending, resume: { conversationId: pending.conversationId, revision: prepared.revision,
              commandId: `continue-${newId()}`, workspaceId: prepared.workspaceId, model: pending.settings.model, permissionPreset: pending.settings.permissionPreset } });
          }
          if (!pending.sessionId && pending.resume) {
            const resumed = await this.access.history.resumeHistory(pending.resume);
            if (!resumed.ok) {
              if (resumed.reason === 'stale') await save({ ...pending, resume: undefined });
              return { ...resumed, deliveryUncertain: resumed.reason === 'unavailable' };
            }
            await save({ ...pending, sessionId: resumed.sessionId });
          }
        } else {
          for (let attempt = 0; attempt < 3 && !pending.sessionId; attempt++) {
          if (!pending.create) {
            const sessionId = `agent-${pending.id}`;
            const commandId = `create-${newId()}`;
            const fresh = attempt === 0 ? snapshot : await this.access.getSnapshot();
            if (!fresh) return { ok: false, message: 'Reconnect to continue. Your draft is saved.' };
            await save({ ...pending, create: createDaemonCommand({ commandId, idempotencyKey: commandId, expectedRevision: fresh.revision,
              issuedAt: new Date().toISOString(), principal: this.access.principal, type: 'agent.create',
              payload: { sessionId, title: structuredAgentSessionTitle(pending.prompt) || 'New conversation', ...pending.settings } }) });
          }
          const receipt = await this.access.sendCommand(pending.create!);
          if (!receipt || !receipt.ok && receipt.error.code === 'delivery-uncertain') return { ok: false, deliveryUncertain: true, message: 'Creation is unconfirmed. Check this same request before sending again.' };
          if (!receipt.ok) {
            await save({ ...pending, create: undefined });
            if (receipt.error.code === 'revision-conflict' && attempt < 2) continue;
            return { ok: false, message: receipt.error.message };
          }
          await save({ ...pending, sessionId: pending.create!.payload.sessionId });
          }
        }
      }
      if (!pending.sessionId) return { ok: false, message: 'The original conversation could not be opened.' };
      for (let attempt = 0; attempt < 3 && !pending.accepted; attempt++) {
        if (!pending.submit) {
          const fresh = await this.access.getSnapshot();
          if (!fresh) return { ok: false, message: 'The conversation is ready. Reconnect and retry this message.' };
          const commandId = `message-${newId()}`;
          await save({ ...pending, submit: createDaemonCommand({ commandId, idempotencyKey: commandId, expectedRevision: fresh.revision,
            issuedAt: new Date().toISOString(), principal: this.access.principal, type: 'agent.submit',
            payload: { sessionId: pending.sessionId, prompt: pending.prompt, ...(pending.context ? { context: pending.context } : {}) } }) });
        }
        const receipt = await this.access.sendCommand(pending.submit!);
        if (!receipt || !receipt.ok && receipt.error.code === 'delivery-uncertain') return { ok: false, deliveryUncertain: true, message: 'Delivery is unconfirmed. Check this same request; your draft is saved.' };
        if (!receipt.ok) {
          await save({ ...pending, submit: undefined });
          if (receipt.error.code === 'revision-conflict' && attempt < 2) continue;
          return { ok: false, message: receipt.error.message };
        }
        await save({ ...pending, accepted: true });
      }
      const draft = this.recovery.getSnapshot().draft;
      if (draft.text.trim() === pending.prompt && JSON.stringify(draft.attachments ?? []) === JSON.stringify(pending.context?.attachments ?? [])
        && JSON.stringify(draft.replyTo) === JSON.stringify(pending.context?.replyTo)
        && JSON.stringify(draft.skills ?? []) === JSON.stringify(pending.context?.skills ?? [])) this.recovery.updateDraft({ text: '' });
      return { ok: true, sessionId: pending.sessionId!, conversationId: pending.conversationId };
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'The message could not be prepared. Your draft was retained.', deliveryUncertain: !!this.recovery.getSnapshot().start }; }
    finally { this.running = false; }
  }
}
