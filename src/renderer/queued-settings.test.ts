import { describe, expect, it, vi } from 'vitest';

import type { DaemonAgent } from '../shared/daemon-protocol';
import { nextConversationSettings, planPhaseNote, queuedSettingsFor } from './queued-settings';

const AGENT: DaemonAgent = {
  sessionId: 'agent-1', providerId: 'codex', model: 'model-a', reasoningEffort: 'high', permissionPreset: 'standard',
  state: 'working', currentTurnId: 'turn-1', queuedTurnCount: 0, orchestrationEnabled: false,
  revision: 1, createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z',
};

describe('the input box line for queued settings', () => {
  it('shows the next request settings on the pills and the running ones on the line', () => {
    const pending = { model: 'model-b', reasoningEffort: 'medium', effortScope: 'once' as const };
    expect(nextConversationSettings(AGENT, pending)).toEqual({ model: 'model-b', permissionPreset: 'standard', reasoningEffort: 'medium' });
    const scope = vi.fn();
    const cancel = vi.fn();
    const line = queuedSettingsFor(AGENT, pending, { cancel, scope })!;
    expect(line.current).toEqual({ model: 'model-a', permissionPreset: 'standard', reasoningEffort: 'high' });
    expect(line.scope).toBe('once');
    line.onScope!('keep');
    expect(scope).toHaveBeenCalledWith('keep', 'medium');
    line.onCancel!();
    expect(cancel).toHaveBeenCalled();
  });

  it('says a one-request effort runs now, with nothing left to cancel', () => {
    const line = queuedSettingsFor(AGENT, { runningEffort: 'low', runningTurnId: 'turn-1' }, { cancel: vi.fn(), scope: vi.fn() })!;
    expect(line.current.reasoningEffort).toBe('low');
    expect(line.onCancel).toBeUndefined();
    expect(line.scope).toBeUndefined();
    // Once that turn is over, nothing differs.
    expect(queuedSettingsFor({ ...AGENT, currentTurnId: 'turn-2' }, { runningEffort: 'low', runningTurnId: 'turn-1' }, { cancel: vi.fn(), scope: vi.fn() })).toBeUndefined();
  });
});

describe('the plan approval note on who implements the plan', () => {
  const base = { korean: true, providerLabel: 'Codex', agentName: '구현 담당', currentModel: 'gpt-6-astra', currentEffort: 'xhigh', modelLabel: (model: string) => (model === 'gpt-6-astra' ? 'GPT-6-Astra' : model) };

  it('names the implement agent Codex starts with', () => {
    expect(planPhaseNote({ ...base, linkedEffort: 'medium' }))
      .toBe("구현은 '구현 담당'(Codex · GPT-6-Astra · 보통)으로 시작합니다 · 설정 › AI › 단계 연결");
  });

  it('names the implement agent Claude starts with, its plan turn ending at the approval', () => {
    expect(planPhaseNote({ ...base, providerLabel: 'Claude', agentName: 'Claude 구현', currentModel: 'claude-opus-5-5', currentEffort: 'high', linkedEffort: 'medium', modelLabel: () => 'Opus 5.5' }))
      .toBe("구현은 'Claude 구현'(Claude · Opus 5.5 · 보통)으로 시작합니다 · 설정 › AI › 단계 연결");
  });

  it('says nothing when the link changes nothing', () => {
    expect(planPhaseNote({ ...base, linkedEffort: 'xhigh' })).toBeUndefined();
  });
});
