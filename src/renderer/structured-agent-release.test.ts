import { describe, expect, it, vi } from 'vitest';

import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot } from '../shared/daemon-protocol';
import { releaseProviderAfterClear } from './structured-agent-release';

const snapshot = (revision: number) => ({ revision }) as DaemonSnapshot;
const conflict = { ok: false, error: { code: 'revision-conflict', message: 'stale' } } as unknown as DaemonCommandReceipt;
const applied = { ok: true } as unknown as DaemonCommandReceipt;

describe('releaseProviderAfterClear', () => {
  it('asks the host to release the cleared conversation, retrying a stale revision', async () => {
    let revision = 4;
    const commands: DaemonCommand[] = [];
    const daemon = {
      getSnapshot: vi.fn(async () => snapshot(revision++)),
      sendCommand: vi.fn(async (command: DaemonCommand) => { commands.push(command); return commands.length === 1 ? conflict : applied; }),
    };
    let id = 0;
    await releaseProviderAfterClear(daemon, 'old-session', () => `command-${++id}`);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toMatchObject({ type: 'agent.release', payload: { sessionId: 'old-session' }, expectedRevision: 5,
      principal: { kind: 'desktop', id: 'renderer-agent-ui' }, commandId: 'command-2' });
  });

  it('gives up quietly when the host refuses or is unavailable', async () => {
    const refused = { ok: false, error: { code: 'invalid-state', message: 'busy' } } as unknown as DaemonCommandReceipt;
    const daemon = { getSnapshot: vi.fn(async () => snapshot(1)), sendCommand: vi.fn(async () => refused) };
    await releaseProviderAfterClear(daemon, 'busy', () => 'command');
    expect(daemon.sendCommand).toHaveBeenCalledTimes(1);
    const offline = { getSnapshot: vi.fn(async () => null), sendCommand: vi.fn() };
    await releaseProviderAfterClear(offline, 'gone', () => 'command');
    expect(offline.sendCommand).not.toHaveBeenCalled();
  });
});
