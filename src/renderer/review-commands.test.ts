import { describe, expect, it, vi } from 'vitest';

import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot, DaemonTranscriptItem } from '../shared/daemon-protocol';
import { otherAiReview, OTHER_REVIEW_ID } from './chat/review/review-fixtures';
import type { ConversationCommandAccess } from './conversation-commands';
import { reviewHost, runReviewCommand } from './review-commands';

const NOW = '2026-10-30T09:00:00.000Z';
const SESSION = 'chat-prices';

function snapshot(patch: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
  return {
    protocolVersion: 12, revision: 7, eventSequence: 3, generatedAt: NOW, capabilities: ['review-loop-v1'],
    runtime: { keepRunning: true, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
    projects: [{ id: 'project-1', name: 'cart-kit', source: 'native', revision: 1, createdAt: NOW, updatedAt: NOW }],
    workspaces: [{ id: 'ws-1', projectId: 'project-1', name: 'review/cart-kit', kind: 'worktree', rootPath: 'C:\\Working\\cart-kit', revision: 1, createdAt: NOW, updatedAt: NOW }],
    sessions: [{ id: SESSION, projectId: 'project-1', workspaceId: 'ws-1', kind: 'agent', title: 'Prices', state: 'running', source: 'structured', revision: 1, createdAt: NOW, updatedAt: NOW }],
    agents: [{
      sessionId: SESSION, providerId: 'claude', providerSessionId: 'claude-session', model: 'claude-opus-5-5', reasoningEffort: 'high', permissionPreset: 'standard',
      state: 'idle', queuedTurnCount: 0, orchestrationEnabled: true, revision: 1, createdAt: NOW, updatedAt: NOW,
    }],
    agentRelations: [], turns: [], transcriptHeads: [], approvals: [], schedules: [], heartbeats: [],
    providers: ['claude', 'codex', 'gemini'].map((id) => ({
      id, displayName: id, protocol: id === 'codex' ? 'codex-app-server' as const : 'claude-agent-sdk' as const, executablePath: id, executableVersion: '1.0.0', argv: [],
      environmentVariableNames: [], capabilities: [], enabled: true, health: 'ready' as const, revision: 1, createdAt: NOW, updatedAt: NOW,
    })),
    reviewSupport: { claude: { self: true, reviewer: true }, codex: { self: true, reviewer: true } },
    ...patch,
  };
}

function access(receipts: readonly (DaemonCommandReceipt | null)[], current = snapshot()): ConversationCommandAccess & { readonly sent: DaemonCommand[] } {
  const sent: DaemonCommand[] = [];
  let next = 0;
  return {
    sent,
    latestSnapshot: vi.fn(async () => current),
    sendCommand: vi.fn(async (command: DaemonCommand) => {
      sent.push(command);
      const receipt = receipts[Math.min(next, receipts.length - 1)];
      next += 1;
      return receipt === null || receipt === undefined ? null : { ...receipt, commandId: command.commandId };
    }),
  };
}
const OK: DaemonCommandReceipt = { ok: true, status: 'applied', commandId: '', revision: 8, eventSequence: 4 };
const CONFLICT: DaemonCommandReceipt = { ok: false, status: 'rejected', commandId: '', revision: 8, error: { code: 'revision-conflict', message: 'stale', retryable: true } };

describe('review commands', () => {
  it('reads the snapshot again once after a revision race, with the same payload (one card)', async () => {
    const host = access([CONFLICT, OK]);
    const result = await runReviewCommand(host, 'review.start', { sessionId: SESSION, reviewId: 'rv-1', reviewer: { kind: 'self' }, target: { kind: 'uncommitted' } });
    expect(result).toEqual({ ok: true });
    expect(host.sent).toHaveLength(2);
    expect(host.sent.map((command) => command.payload)).toEqual([host.sent[0]!.payload, host.sent[0]!.payload]);
    expect(host.sent.map((command) => command.expectedRevision)).toEqual([7, 7]);
    expect(host.sent[0]!.commandId).not.toBe(host.sent[1]!.commandId);
  });

  it('passes a refusal on, with how many findings would fit', async () => {
    const tooLong: DaemonCommandReceipt = { ok: false, status: 'rejected', commandId: '', revision: 8,
      error: { code: 'invalid-command', message: 'These findings do not fit in one message.', retryable: false, details: { fits: 26 } } };
    expect(await runReviewCommand(access([tooLong]), 'review.fix', { sessionId: SESSION, reviewId: 'rv-1', findingIds: ['f-1'] }))
      .toEqual({ ok: false, message: 'These findings do not fit in one message.', fits: 26 });
    expect((await runReviewCommand(access([null]), 'review.cancel', { sessionId: SESSION, reviewId: 'rv-1' })).ok).toBe(false);
  });
});

describe('what a conversation offers for reviews', () => {
  const host = (patch: Partial<DaemonSnapshot> = {}, items: readonly DaemonTranscriptItem[] = [], extra = {}) => reviewHost({
    snapshot: snapshot(patch), sessionId: SESSION, items, access: access([OK]), locale: 'ko', ...extra,
  });

  it('offers nothing on a host without review-loop-v1 (the older 검토 맡기기 stays)', () => {
    expect(host({ capabilities: [] })).toBeUndefined();
  });

  it('lists this AI with its conversation settings and every other AI the host can review with', () => {
    const offer = host({}, [], {
      baseRef: 'main',
      modelLabel: (_provider: string, model: string) => (model === 'claude-opus-5-5' ? 'Opus 5.5' : model),
      reviewAgent: (providerId: string) => (providerId === 'codex' ? { name: '코드 리뷰어', model: 'gpt-6.1-sol', reasoningEffort: 'high' } : undefined),
    })!;
    expect(offer.reviewStart.options).toEqual({
      self: { providerId: 'claude', settingsText: 'Opus 5.5 · 높음' },
      // Gemini has no review support entry: it is not offered.
      others: [{ providerId: 'codex', settingsText: '검토 에이전트 코드 리뷰어 · gpt-6.1-sol · 높음' }],
      baseRef: 'main',
      worktree: true,
      busy: false,
    });
  });

  it('says the review waits only while a turn runs, as the host does (not for one still queued)', () => {
    const agent = snapshot().agents[0]!;
    expect(host({ agents: [{ ...agent, state: 'queued', queuedTurnCount: 1 }] })!.reviewStart.options.busy).toBe(false);
    expect(host({ agents: [{ ...agent, state: 'working', currentTurnId: 'turn-1' }] })!.reviewStart.options.busy).toBe(true);
  });

  it('says why an AI cannot review, and that this one needs a first message to fork', () => {
    const blocked = host({
      reviewSupport: { claude: { self: false, reviewer: true, reason: 'provider-too-old' }, codex: { self: true, reviewer: false, reason: 'provider-unavailable' } },
    })!;
    expect(blocked.reviewStart.options.self.unavailableReason).toContain('Claude');
    expect(blocked.reviewStart.options.others[0]!.unavailableReason).toBeTruthy();
    const fresh = host({ agents: [{ ...snapshot().agents[0]!, providerSessionId: undefined }] })!;
    expect(fresh.reviewStart.options.self.unavailableReason).toBe('첫 메시지를 보낸 뒤 검토할 수 있습니다. 아직 분기할 대화가 없습니다.');
  });

  it('starts this AI in a fork, or another AI in a new reviewer conversation', async () => {
    const commands = access([OK]);
    const offer = reviewHost({ snapshot: snapshot(), sessionId: SESSION, items: [], access: commands, locale: 'ko' })!;
    await offer.reviewStart.onStart({ reviewer: { mode: 'self', providerId: 'claude' }, target: { kind: 'base-branch' }, focus: '금액' });
    await offer.reviewStart.onStart({ reviewer: { mode: 'other', providerId: 'codex' }, target: { kind: 'uncommitted' } });
    const [self, other] = commands.sent;
    expect(self).toMatchObject({ type: 'review.start', payload: { sessionId: SESSION, reviewer: { kind: 'self' }, target: { kind: 'base-branch' }, focus: '금액' } });
    expect(other).toMatchObject({ type: 'review.start', payload: { reviewer: { kind: 'other', providerId: 'codex', reviewerSessionId: expect.stringMatching(/^review-/u) } } });
    expect(self!.payload).not.toHaveProperty('reviewer.model');
    expect((self!.payload as { reviewId: string }).reviewId).not.toBe((other!.payload as { reviewId: string }).reviewId);
  });

  it('turns card buttons into review commands', async () => {
    const commands = access([OK]);
    const fixture = otherAiReview();
    const openSession = vi.fn();
    const offer = reviewHost({ snapshot: snapshot(), sessionId: SESSION, items: fixture.items, access: commands, locale: 'ko', openSession })!;
    await offer.onReviewAction({ kind: 'fix-all', reviewId: OTHER_REVIEW_ID, findingIds: ['f-1', 'f-2'] });
    await offer.onReviewAction({ kind: 'dismiss', reviewId: OTHER_REVIEW_ID, findingIds: ['f-1'] });
    await offer.onReviewAction({ kind: 'reopen', reviewId: OTHER_REVIEW_ID, findingIds: ['f-1'] });
    await offer.onReviewAction({ kind: 'cancel', reviewId: OTHER_REVIEW_ID });
    await offer.onReviewAction({ kind: 'retry', reviewId: OTHER_REVIEW_ID });
    expect(commands.sent.map((command) => [command.type, command.payload])).toEqual([
      ['review.fix', { sessionId: SESSION, reviewId: OTHER_REVIEW_ID, findingIds: ['f-1', 'f-2'] }],
      ['review.resolve', { sessionId: SESSION, reviewId: OTHER_REVIEW_ID, findingIds: ['f-1'], state: 'dismissed' }],
      ['review.resolve', { sessionId: SESSION, reviewId: OTHER_REVIEW_ID, findingIds: ['f-1'], state: 'open' }],
      ['review.cancel', { sessionId: SESSION, reviewId: OTHER_REVIEW_ID }],
      // 다시 검토: a new card, the same reviewer AI (a new reviewer conversation), scope and focus.
      ['review.start', {
        sessionId: SESSION, reviewId: expect.stringMatching(/^rv-/u), reviewer: { kind: 'other', providerId: 'codex', reviewerSessionId: expect.stringMatching(/^review-/u) },
        target: { kind: 'base-branch', baseRef: 'main' }, focus: '금액 계산과 권한 검사',
      }],
    ]);
    await offer.onReviewAction({ kind: 'open-reviewer', reviewId: OTHER_REVIEW_ID });
    expect(openSession).toHaveBeenCalledWith(expect.stringMatching(/^review-/u));
  });

  it('says how many fit when a batch is over the message budget', async () => {
    const tooLong: DaemonCommandReceipt = { ok: false, status: 'rejected', commandId: '', revision: 8,
      error: { code: 'invalid-command', message: 'too long', retryable: false, details: { fits: 3 } } };
    const offer = reviewHost({ snapshot: snapshot(), sessionId: SESSION, items: [], access: access([tooLong]), locale: 'ko' })!;
    expect(await offer.onReviewAction({ kind: 'fix-all', reviewId: 'rv-1', findingIds: ['f-1', 'f-2', 'f-3', 'f-4'] }))
      .toEqual({ ok: false, message: '한 메시지에 다 들어가지 않습니다. 처음 3개를 먼저 고치세요.' });
  });
});
