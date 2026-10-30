import { describe, expect, it } from 'vitest';

import type { DaemonTranscriptItem, DaemonTurn } from '../shared/daemon-protocol';
import { conversationQueue } from './conversation-queue';

const AT = '2026-10-30T09:00:00.000Z';
const turn = (id: string, state: DaemonTurn['state']): DaemonTurn => ({ id, sessionId: 's', commandId: `c-${id}`, state, revision: 1, createdAt: AT, updatedAt: AT });
const message = (sequence: number, turnId: string, text: string, payload?: DaemonTranscriptItem['payload']): DaemonTranscriptItem => ({
  id: `i${String(sequence)}`, sessionId: 's', sequence, kind: 'user-message', text, turnId, isDelta: false, isSensitive: false, createdAt: AT, ...(payload ? { payload } : {}),
});

describe('the requests waiting in a conversation', () => {
  it('lists what the person sent, and marks a review fix with how many problems it carries', () => {
    const queue = conversationQueue('s', [turn('a', 'queued'), turn('b', 'queued'), turn('c', 'working')], [
      message(1, 'a', 'Run the tests'),
      message(2, 'b', 'Fix only the review findings below.', { v: 1, type: 'review-fix', reviewId: 'r1', findingIds: ['f-00000001', 'f-00000002'] }),
      message(3, 'c', 'Now running'),
    ]);
    expect(queue).toEqual([
      { turnId: 'a', revision: 1, text: 'Run the tests' },
      { turnId: 'b', revision: 1, text: 'Fix only the review findings below.', reviewFix: { findings: 2 } },
    ]);
  });
});
