import { createDaemonCommand } from '../../../src/shared/daemon-protocol';
import type { WsEzTerminalTransport } from '../transport/ws-ezterminal';
import { PHONE_PRINCIPAL } from '../phone-conversation-access';
import type { FeedWaitingItem } from './feed-model';
import type { FeedDecisionResult } from './MobileFeedView';

type DecideTransport = Pick<WsEzTerminalTransport, 'getDaemonSnapshot' | 'sendDaemonCommand' | 'decideAgentApproval'>;

function commandId(): string {
  return `command-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

/**
 * A feed card's 허용/거부. A conversation approval is resolved like the desktop board does (a fresh snapshot's revision,
 * sent as the phone); a terminal agent's goes through its own approval channel.
 */
export async function decideFeedItem(transport: DecideTransport, item: FeedWaitingItem, decision: 'allow' | 'deny'): Promise<FeedDecisionResult> {
  const target = item.decide;
  if (!target) return { ok: false };
  try {
    if (target.target === 'terminal') {
      const result = await transport.decideAgentApproval(target.activityId, target.approvalId, decision);
      return result.ok ? { ok: true } : { ok: false };
    }
    const authority = await transport.getDaemonSnapshot();
    if (!authority) return { ok: false };
    const id = commandId();
    const receipt = await transport.sendDaemonCommand(createDaemonCommand({
      commandId: id, idempotencyKey: id, expectedRevision: authority.revision, issuedAt: new Date().toISOString(),
      principal: PHONE_PRINCIPAL, type: 'permission.resolve', payload: { approvalId: target.approvalId, decision },
    }));
    return receipt.ok ? { ok: true } : { ok: false, message: receipt.error.message };
  } catch {
    return { ok: false };
  }
}
