import { describe, expect, it, vi } from 'vitest';
import type { EzTerminalApi } from '../shared/ipc';
import type { BlockController } from './block-controller';
import { retainTerminalBlocks, takeRetainedTerminalBlocks } from './retained-terminal-blocks';

function fixture() {
  let removed: (id: string) => void = () => undefined;
  let dead: () => void = () => undefined;
  const access = {
    listSessions: vi.fn(async () => [{ sessionId: 's1', cwd: '/work' }]),
    onSessionRemoved: (listener: (id: string) => void) => { removed = listener; return () => undefined; },
    onSessionDead: (listener: () => void) => { dead = listener; return () => undefined; },
  } satisfies Pick<EzTerminalApi, 'listSessions' | 'onSessionRemoved' | 'onSessionDead'>;
  const detach = vi.fn();
  const dispose = vi.fn();
  const blocks = [{ id: 'r1', command: 'gen-rows 1', controller: {
    detach, dispose, getSnapshot: () => ({ executionKind: 'structured' }),
  } as unknown as BlockController }];
  return { access, blocks, detach, dispose, remove: () => removed('s1'), die: () => dead() };
}

describe('closed terminal view descriptors', () => {
  it('detaches instead of disposing and restores only run descriptors on the same transport', async () => {
    const h = fixture();
    retainTerminalBlocks(h.access, 's1', h.blocks);
    await Promise.resolve();
    expect(h.detach).toHaveBeenCalledOnce();
    expect(h.dispose).not.toHaveBeenCalled();
    expect(takeRetainedTerminalBlocks(fixture().access, 's1')).toEqual([]);
    expect(takeRetainedTerminalBlocks(h.access, 's1')).toEqual([
      { sessionId: 's1', runId: 'r1', commandText: 'gen-rows 1', executionKind: 'structured' },
    ]);
  });

  it.each(['remove', 'die'] as const)('drops descriptors after host %s', (event) => {
    const h = fixture();
    retainTerminalBlocks(h.access, 's1', h.blocks);
    h[event]();
    expect(takeRetainedTerminalBlocks(h.access, 's1')).toEqual([]);
  });

  it('discards a view that unmounts after its host session was already ended', async () => {
    const h = fixture();
    h.access.listSessions.mockResolvedValue([]);
    retainTerminalBlocks(h.access, 's1', h.blocks);
    await Promise.resolve();
    expect(takeRetainedTerminalBlocks(h.access, 's1')).toEqual([]);
  });
});
