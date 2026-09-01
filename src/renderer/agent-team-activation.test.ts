import { describe, expect, it, vi } from 'vitest';

import { activateAgentTeamMemberWhenObserved } from './agent-team-activation';

const input = {
  runId: '123e4567-e89b-12d3-a456-426614174000',
  personaId: '123e4567-e89b-12d3-a456-426614174001',
  sessionId: 'session-1',
};

describe('activateAgentTeamMemberWhenObserved', () => {
  it('waits for an activity edge after an initially unavailable activation', async () => {
    let listener: (() => void) | undefined;
    const activate = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'unavailable', message: 'waiting' })
      .mockResolvedValueOnce({ ok: true, value: { run: {}, brief: 'approved brief' } });
    const promise = activateAgentTeamMemberWhenObserved({
      activate,
      onActivitySnapshot: (next) => {
        listener = next;
        return () => { listener = undefined; };
      },
    }, input, new AbortController().signal, 1_000);
    listener?.();
    await expect(promise).resolves.toMatchObject({ ok: true, value: { brief: 'approved brief' } });
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it('does not retry a rejected activation', async () => {
    await expect(activateAgentTeamMemberWhenObserved({
      activate: async () => ({ ok: false, error: 'conflict', message: 'wrong worktree' }),
      onActivitySnapshot: () => () => undefined,
    }, input, new AbortController().signal)).rejects.toThrow('wrong worktree');
  });
});
