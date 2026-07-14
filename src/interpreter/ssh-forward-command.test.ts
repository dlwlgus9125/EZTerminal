import { describe, expect, it } from 'vitest';

import type { InterpreterFrame } from '../shared/ipc';
import { sshForwardCommandData } from './core';
import { runSshForwardCommand } from './ssh-forward-command';

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('runSshForwardCommand', () => {
  it('adapts a successful service result into the ordinary pageable table contract', async () => {
    const frames: InterpreterFrame[] = [];
    const session = runSshForwardCommand(
      sshForwardCommandData({ action: 'list', connectionId: 'conn-1' }),
      (frame) => frames.push(frame),
      new AbortController().signal,
      async () => ({
        ok: true,
        forwards: [{
          forwardId: 'fwd-1', connectionId: 'conn-1', bindHost: '127.0.0.1', localPort: 15432,
          remoteHost: 'db.internal', remotePort: 5432, state: 'listening',
        }],
      }),
    );
    await flush();
    await flush();
    session.handleControl({ type: 'requestRows', start: 0, count: 10 });
    await flush();

    expect(frames.find((frame) => frame.type === 'schema')).toMatchObject({ shape: 'table' });
    expect(frames.find((frame) => frame.type === 'chunk')).toMatchObject({
      rows: [{ forwardId: 'fwd-1', connectionId: 'conn-1', bindHost: '127.0.0.1', localPort: 15432 }],
    });
    expect(frames.some((frame) => frame.type === 'end')).toBe(true);
  });

  it('surfaces stable backend error codes without leaking a partial table', async () => {
    const frames: InterpreterFrame[] = [];
    runSshForwardCommand(
      sshForwardCommandData({ action: 'list', connectionId: 'missing' }),
      (frame) => frames.push(frame),
      new AbortController().signal,
      async () => ({ ok: false, error: { code: 'CONNECTION_NOT_FOUND', message: 'not active' } }),
    );
    await flush();
    expect(frames).toEqual([{ type: 'error', message: 'ssh-forward: [CONNECTION_NOT_FOUND] not active' }]);
  });
});
