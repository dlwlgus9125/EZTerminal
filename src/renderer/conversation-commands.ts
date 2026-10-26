import type { ChatMessageContext } from '../shared/chat-message';
import {
  createDaemonCommand,
  type DaemonCommand,
  type DaemonCommandReceipt,
  type DaemonSnapshot,
  type PermissionPreset,
} from '../shared/daemon-protocol';
import type { ChatRecoveryController } from './chat-recovery';
import { retainChatRecovery } from './chat-recovery-registry';
import type { ConversationQueueAction, ConversationQueueItem } from './conversation-queue';
import type { StructuredAgentUiResult } from './StructuredAgentSession';

/**
 * The commands a conversation's message box sends, shared by the conversation
 * tab and any other place that types into the same conversation (a terminal's
 * AI input). Each reads the latest host snapshot for its expected revision and
 * reports a result the box can show; the send keeps its escrow in the shared
 * draft recovery so a message is never sent twice.
 */

export interface ConversationCommandAccess {
  /** The newest host snapshot (waits for a read already in flight). */
  readonly latestSnapshot: () => Promise<DaemonSnapshot | null>;
  /** Null when the host did not answer. */
  readonly sendCommand: (command: DaemonCommand) => Promise<DaemonCommandReceipt | null>;
}

const PRINCIPAL = { kind: 'desktop', id: 'renderer-agent-ui' } as const;
const UNAVAILABLE = 'The Agent daemon is unavailable.';

let fallbackId = 0;

export function opaqueId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `${prefix}-${random}`;
  fallbackId += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

export function resultOf(receipt: DaemonCommandReceipt): StructuredAgentUiResult {
  return receipt.ok ? { ok: true } : { ok: false, message: receipt.error.message, deliveryUncertain: false };
}

/**
 * Draft recoveries with a send or delivery check in flight. Two boxes on one
 * conversation (its tab and a terminal) share the recovery: the second send is
 * refused at once instead of passing the escrow check while the first still
 * awaits the host, which would send the same draft twice.
 */
const busy = new WeakSet<ChatRecoveryController>();

/** Run `transaction` as the recovery's only send, holding the shared draft until it settles. */
async function exclusively(recovery: ChatRecoveryController, transaction: () => Promise<StructuredAgentUiResult>): Promise<StructuredAgentUiResult> {
  if (busy.has(recovery)) return { ok: false, message: 'This message is already being sent. Wait for it before sending again.' };
  busy.add(recovery);
  // A box that closes mid-send must not let the registry forget the escrow the receipt settles.
  const hold = retainChatRecovery(recovery);
  try {
    return await transaction();
  } finally {
    busy.delete(recovery);
    hold?.();
  }
}

/** Send a message: escrow it in the draft recovery, send, then settle the escrow with the receipt. */
export async function submitConversationMessage(access: ConversationCommandAccess, input: {
  readonly sessionId: string;
  readonly recovery: ChatRecoveryController | null;
  readonly type: 'agent.submit' | 'agent.interrupt-and-submit';
  readonly prompt: string;
  readonly context?: ChatMessageContext;
  /** The host accepted it (before the escrow is settled), with the command id it was sent as. */
  readonly onAccepted?: (commandId: string) => void;
}): Promise<StructuredAgentUiResult> {
  const { recovery } = input;
  if (!recovery || recovery.getSnapshot().status !== 'ready') return { ok: false, message: 'Secure draft recovery must be ready before sending.' };
  if (recovery.getSnapshot().pendingSubmit) return { ok: false, message: 'Confirm the previous message delivery before sending again.', deliveryUncertain: true };
  return exclusively(recovery, () => submitNow(access, { ...input, recovery }));
}

async function submitNow(access: ConversationCommandAccess, input: {
  readonly sessionId: string;
  readonly recovery: ChatRecoveryController;
  readonly type: 'agent.submit' | 'agent.interrupt-and-submit';
  readonly prompt: string;
  readonly context?: ChatMessageContext;
  readonly onAccepted?: (commandId: string) => void;
}): Promise<StructuredAgentUiResult> {
  const { sessionId, recovery, type, prompt, context } = input;
  const authority = await access.latestSnapshot();
  if (!authority) return { ok: false, message: UNAVAILABLE };
  const commandId = opaqueId('command');
  const command = type === 'agent.submit'
    ? createDaemonCommand({
        commandId,
        idempotencyKey: commandId,
        expectedRevision: authority.revision,
        issuedAt: new Date().toISOString(),
        principal: PRINCIPAL,
        type,
        payload: { sessionId, prompt, ...(context ? { context } : {}) },
      })
    : createDaemonCommand({
        commandId,
        idempotencyKey: commandId,
        expectedRevision: authority.revision,
        issuedAt: new Date().toISOString(),
        principal: PRINCIPAL,
        type,
        payload: { sessionId, prompt, ...(context ? { context } : {}) },
      });
  const prepared = await recovery.prepare(command);
  if (!prepared.ok) return prepared;
  const receipt = await access.sendCommand(command);
  if (!receipt || (!receipt.ok && receipt.error.code === 'delivery-uncertain')) {
    return { ok: false, message: 'Message delivery could not be confirmed. Check delivery before sending again.', deliveryUncertain: true };
  }
  const stored = await recovery.complete(command.commandId, receipt.ok);
  const result = resultOf(receipt);
  if (result.ok) input.onAccepted?.(commandId);
  return stored.ok ? result : stored;
}

/** Resend the escrowed message once (idempotent on the host) and settle the escrow. */
export async function reconcileConversationSubmit(access: ConversationCommandAccess, input: {
  readonly recovery: ChatRecoveryController | null;
  readonly onAccepted?: (pending: Extract<DaemonCommand, { readonly type: 'agent.submit' | 'agent.interrupt-and-submit' }>) => void;
}): Promise<StructuredAgentUiResult> {
  const { recovery } = input;
  const pending = recovery?.getSnapshot().pendingSubmit?.command;
  if (!recovery || !pending) return { ok: true };
  if (recovery.getSnapshot().status !== 'ready') return { ok: false, message: 'Check stored recovery data before confirming delivery.', deliveryUncertain: true };
  return exclusively(recovery, async () => {
    const receipt = await access.sendCommand(pending);
    if (!receipt || (!receipt.ok && receipt.error.code === 'delivery-uncertain')) {
      return { ok: false, message: 'Message delivery is still unconfirmed.', deliveryUncertain: true };
    }
    if (receipt.ok) input.onAccepted?.(pending);
    const stored = await recovery.complete(pending.commandId, receipt.ok);
    return stored.ok ? resultOf(receipt) : stored;
  });
}

export async function changeConversationSettings(access: ConversationCommandAccess, sessionId: string, settings: {
  readonly model?: string;
  readonly permissionPreset?: PermissionPreset;
  readonly reasoningEffort?: string;
}): Promise<StructuredAgentUiResult> {
  const authority = await access.latestSnapshot();
  if (!authority) return { ok: false, message: UNAVAILABLE };
  const commandId = opaqueId('command');
  const receipt = await access.sendCommand(createDaemonCommand({
    commandId,
    idempotencyKey: commandId,
    expectedRevision: authority.revision,
    issuedAt: new Date().toISOString(),
    principal: PRINCIPAL,
    type: 'agent.set-settings',
    payload: {
      sessionId,
      ...(settings.permissionPreset ? { permissionPreset: settings.permissionPreset } : {}),
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.reasoningEffort && authority.capabilities?.includes('agent-effort-v1')
        ? { reasoningEffort: settings.reasoningEffort }
        : {}),
    },
  }));
  return receipt ? resultOf(receipt) : { ok: false, message: UNAVAILABLE };
}

export async function queueConversationTurn(
  access: ConversationCommandAccess,
  sessionId: string,
  item: ConversationQueueItem,
  action: ConversationQueueAction,
): Promise<StructuredAgentUiResult> {
  const authority = await access.latestSnapshot();
  if (!authority) return { ok: false, message: UNAVAILABLE };
  const commandId = opaqueId('command');
  const receipt = await access.sendCommand(createDaemonCommand({ commandId, idempotencyKey: commandId,
    expectedRevision: authority.revision, issuedAt: new Date().toISOString(), principal: PRINCIPAL,
    type: 'agent.queue', payload: { sessionId, turnId: item.turnId, turnRevision: item.revision, action } }));
  return receipt ? resultOf(receipt) : { ok: false, message: 'Queue result unknown. Refresh before trying again.' };
}

/** Stop, archive or detach a managed conversation, checked against the latest snapshot. */
export async function runConversationLifecycle(
  access: ConversationCommandAccess,
  sessionId: string,
  type: 'agent.cancel' | 'agent.archive' | 'agent.detach',
): Promise<StructuredAgentUiResult> {
  const authority = await access.latestSnapshot();
  if (!authority) return { ok: false, message: UNAVAILABLE };
  const currentSession = authority.sessions.find((candidate) => candidate.id === sessionId);
  const currentAgent = authority.agents.find((candidate) => candidate.sessionId === sessionId);
  const currentRelation = authority.agentRelations.find((relation) => (
    relation.childSessionId === sessionId && relation.detachedAt === undefined
  ));
  if (!currentSession || !currentAgent) {
    return { ok: false, message: 'This Agent session is no longer available.' };
  }
  if (currentRelation?.owner === 'provider-native') {
    return { ok: false, message: 'This provider-owned subagent is read-only.' };
  }
  if (type === 'agent.detach' && !currentRelation) {
    return { ok: false, message: 'This Agent is already a top-level session.' };
  }
  const commandId = opaqueId('command');
  const receipt = await access.sendCommand(createDaemonCommand({
    commandId,
    idempotencyKey: commandId,
    expectedRevision: authority.revision,
    issuedAt: new Date().toISOString(),
    principal: PRINCIPAL,
    type,
    payload: { sessionId },
  }));
  return receipt ? resultOf(receipt) : { ok: false, message: UNAVAILABLE };
}
