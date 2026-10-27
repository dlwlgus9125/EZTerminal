import { describe, expect, it, vi } from 'vitest';

import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot } from '../../../src/shared/daemon-protocol';
import { decideFeedItem } from './feed-actions';
import type { FeedWaitingItem } from './feed-model';

const item = (decide: FeedWaitingItem['decide']): FeedWaitingItem => ({
  key: 'k', kind: decide?.target === 'terminal' ? 'terminal-agent' : 'approval', at: '2026-10-27T00:00:00.000Z', title: 't', detail: 'd',
  ...(decide ? { decide } : {}),
});

function transport(revision = 41) {
  const send = vi.fn(async (command: DaemonCommand): Promise<DaemonCommandReceipt> => ({ ok: true, status: 'applied', commandId: command.commandId, revision: revision + 1, eventSequence: 1 }));
  return {
    send,
    decide: vi.fn(async () => ({ ok: true as const })),
    value: {
      getDaemonSnapshot: vi.fn(async () => ({ revision }) as DaemonSnapshot),
      sendDaemonCommand: send,
      decideAgentApproval: vi.fn(async () => ({ ok: true as const })),
    },
  };
}

describe('decideFeedItem', () => {
  it('resolves a conversation approval as the phone, against a fresh snapshot revision', async () => {
    const { value, send } = transport(41);
    expect(await decideFeedItem(value, item({ target: 'conversation', approvalId: 'a-1' }), 'allow')).toEqual({ ok: true });
    expect(send.mock.calls[0]![0]).toMatchObject({
      type: 'permission.resolve', expectedRevision: 41, principal: { kind: 'android', id: 'mobile-agent-ui' },
      payload: { approvalId: 'a-1', decision: 'allow' },
    });
    expect(send.mock.calls[0]![0].commandId).toBe(send.mock.calls[0]![0].idempotencyKey);
  });

  it('answers a terminal agent through its own approval channel', async () => {
    const { value, send } = transport();
    expect(await decideFeedItem(value, item({ target: 'terminal', activityId: 'act', approvalId: 'gate' }), 'deny')).toEqual({ ok: true });
    expect(value.decideAgentApproval).toHaveBeenCalledWith('act', 'gate', 'deny');
    expect(send).not.toHaveBeenCalled();
  });

  it('reports the PC\'s refusal and a missing connection without throwing', async () => {
    const { value, send } = transport();
    send.mockResolvedValueOnce({ ok: false, status: 'rejected', commandId: 'c', error: { code: 'not-found', message: 'The approval is gone.' } } as unknown as DaemonCommandReceipt);
    expect(await decideFeedItem(value, item({ target: 'conversation', approvalId: 'a-1' }), 'allow')).toEqual({ ok: false, message: 'The approval is gone.' });
    value.getDaemonSnapshot.mockResolvedValueOnce(null as unknown as DaemonSnapshot);
    expect(await decideFeedItem(value, item({ target: 'conversation', approvalId: 'a-1' }), 'allow')).toEqual({ ok: false });
    value.decideAgentApproval.mockResolvedValueOnce({ ok: false, error: 'expired' } as never);
    expect(await decideFeedItem(value, item({ target: 'terminal', activityId: 'act', approvalId: 'gate' }), 'allow')).toEqual({ ok: false });
    expect(await decideFeedItem(value, item(undefined), 'allow')).toEqual({ ok: false });
  });
});
