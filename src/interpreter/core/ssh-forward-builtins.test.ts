import { describe, expect, it } from 'vitest';

import { evaluate, parse } from './index';
import { ShellSession } from '../shell-session';

function command(text: string) {
  return evaluate(
    parse(text),
    new ShellSession(process.cwd()).createContext(new AbortController().signal),
  );
}

describe('ssh-forward builtin markers', () => {
  it('requires an explicit connection id for start/list/stop', () => {
    expect(command('ssh-forward-start conn-1 db.internal 5432 --local-port 15432')).toEqual({
      kind: 'ssh-forward-command',
      request: {
        action: 'start',
        connectionId: 'conn-1',
        remoteHost: 'db.internal',
        remotePort: 5432,
        localPort: 15432,
      },
    });
    expect(command('ssh-forward-list conn-1')).toEqual({
      kind: 'ssh-forward-command', request: { action: 'list', connectionId: 'conn-1' },
    });
    expect(command('ssh-forward-stop conn-1 fwd-1')).toEqual({
      kind: 'ssh-forward-command', request: { action: 'stop', connectionId: 'conn-1', forwardId: 'fwd-1' },
    });
  });

  it('defaults start to an OS-assigned loopback port and rejects invalid ports', () => {
    expect(command('ssh-forward-start conn-1 db.internal 443')).toMatchObject({
      request: { localPort: 0 },
    });
    expect(() => command('ssh-forward-start conn-1 db.internal 0')).toThrow(/remote port/);
    expect(() => command('ssh-forward-start conn-1 db.internal 443 --local-port -1')).toThrow();
  });
});
