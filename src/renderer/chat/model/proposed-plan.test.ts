import { describe, expect, it } from 'vitest';

import type { DaemonTurn } from '../../../shared/daemon-protocol';
import { proposedPlan, withoutRow } from './proposed-plan';
import type { ChatModel, ChatRow } from './types';

const user: ChatRow = { kind: 'user', id: 'user:1', turnId: 'turn-1', createdAt: '2026-10-19T00:00:00.000Z', text: 'Plan it', messageId: 'm1', sensitive: false } as ChatRow;
const plan: ChatRow = { kind: 'plan', id: 'plan:1', turnId: 'turn-1', createdAt: '2026-10-19T00:00:01.000Z', markdown: '- Add farewell' };
const status: ChatRow = { kind: 'turn-status', id: 'turn:turn-1', turnId: 'turn-1', createdAt: '2026-10-19T00:00:02.000Z', state: 'completed' };
const model = (rows: readonly ChatRow[], extra: Partial<ChatModel> = {}): ChatModel => ({ rows, pendingCount: 0, ...extra });
const turn = (state: DaemonTurn['state']): DaemonTurn => ({ id: 'turn-1', sessionId: 's', commandId: 'c', state, revision: 1, createdAt: '', updatedAt: '' });
const base = { providerId: 'codex', permissionPreset: 'plan' as const, state: 'idle' as const, turns: [turn('completed')] };

describe('proposedPlan', () => {
  it('asks about the plan a finished Codex plan turn ended with', () => {
    expect(proposedPlan(model([user, plan, status]), base)).toBe(plan);
  });

  it('stays quiet for Claude, outside plan mode, while busy, in history, or with an approval pending', () => {
    const rows = model([user, plan]);
    expect(proposedPlan(rows, { ...base, providerId: 'claude' })).toBeUndefined();
    expect(proposedPlan(rows, { ...base, permissionPreset: 'standard' })).toBeUndefined();
    expect(proposedPlan(rows, { ...base, state: 'working' })).toBeUndefined();
    expect(proposedPlan(rows, { ...base, historyOnly: true })).toBeUndefined();
    expect(proposedPlan(model([user, plan], { pending: { approval: {} as never }, pendingCount: 1 }), base)).toBeUndefined();
  });

  it('stays quiet once the person wrote after the plan, or when the turn did not finish', () => {
    const later: ChatRow = { ...user, id: 'user:2', turnId: 'turn-2' } as ChatRow;
    expect(proposedPlan(model([user, plan, later]), base)).toBeUndefined();
    expect(proposedPlan(model([user, plan]), { ...base, turns: [turn('interrupted')] })).toBeUndefined();
    expect(proposedPlan(model([user]), base)).toBeUndefined();
  });

  it('removes the proposal from the transcript while the dock shows it', () => {
    expect(withoutRow(model([user, plan, status]), plan).rows).toEqual([user, status]);
  });
});
