import { describe, expect, it } from 'vitest';

import type { DaemonSnapshot, TurnState } from '../shared/daemon-protocol';
import { hasActiveAgentTurn, PowerSaveGuard, type PowerSaveBlockerLike } from './power-save-guard';

function blocker(): PowerSaveBlockerLike & { readonly calls: string[]; started: Set<number> } {
  let next = 0;
  const started = new Set<number>();
  const calls: string[] = [];
  return {
    calls, started,
    start: (type) => { next += 1; started.add(next); calls.push(`start:${type}`); return next; },
    stop: (id) => { started.delete(id); calls.push(`stop:${id}`); },
    isStarted: (id) => started.has(id),
  };
}

const withTurns = (...states: TurnState[]): DaemonSnapshot => ({ turns: states.map((state, index) => ({ id: `t${index}`, state })) }) as unknown as DaemonSnapshot;

describe('hasActiveAgentTurn', () => {
  it('counts turns the AI is working on, not a turn waiting for the person', () => {
    for (const state of ['queued', 'submitting', 'working', 'delivery-uncertain'] as const) expect(hasActiveAgentTurn(withTurns(state))).toBe(true);
    for (const state of ['blocked', 'completed', 'interrupted', 'failed'] as const) expect(hasActiveAgentTurn(withTurns(state))).toBe(false);
    expect(hasActiveAgentTurn(null)).toBe(false);
  });
});

describe('PowerSaveGuard', () => {
  it('keeps the PC from sleeping while any source is working, and only once', () => {
    const fake = blocker();
    const guard = new PowerSaveGuard(fake);
    guard.set('agent-turns', true);
    guard.set('terminal-agents', true);
    guard.set('agent-turns', false);
    expect(fake.calls).toEqual(['start:prevent-app-suspension']);
    guard.set('terminal-agents', false);
    expect(fake.calls).toEqual(['start:prevent-app-suspension', 'stop:1']);
    guard.set('agent-turns', true);
    guard.dispose();
    expect(fake.calls).toEqual(['start:prevent-app-suspension', 'stop:1', 'start:prevent-app-suspension', 'stop:2']);
    expect(fake.started.size).toBe(0);
  });
});
