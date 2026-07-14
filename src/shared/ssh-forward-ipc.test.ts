import { describe, expect, it } from 'vitest';

import type { InterpreterFrame, InterpreterToMain, MainToInterpreter } from './ipc';

describe('SSH forwarding IPC membership', () => {
  it('keeps connection lifecycle and commands on control IPC, never credential fields', () => {
    const state: InterpreterToMain = { type: 'ssh-connection-state', connectionId: 'conn-1', state: 'ready' };
    const request: InterpreterToMain = {
      type: 'ssh-forward-request', requestId: 'req-1',
      request: { action: 'start', connectionId: 'conn-1', remoteHost: 'db.internal', remotePort: 5432, localPort: 0 },
      origin: 'desktop',
    };
    const response: MainToInterpreter = {
      type: 'ssh-forward-response', requestId: 'req-1', result: { ok: true, forwards: [] },
    };
    const frame: InterpreterFrame = { type: 'ssh-connection', connectionId: 'conn-1', state: 'ready' };
    expect([state.type, request.type, response.type, frame.type]).toEqual([
      'ssh-connection-state', 'ssh-forward-request', 'ssh-forward-response', 'ssh-connection',
    ]);
    expect(JSON.stringify([state, request, response, frame])).not.toMatch(/password|passphrase|privateKey|token/i);
  });
});
