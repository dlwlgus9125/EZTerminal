import { describe, expect, it, vi } from 'vitest';

import { TERMINAL_COMPLETION_MAX_LINE } from '../shared/terminal-completion';
import { installTerminalCompletionIpc, TERMINAL_COMPLETE_CHANNEL } from './terminal-completion-ipc';

function install(
  complete = vi.fn(async () => ({ ok: false as const, reason: 'none' as const })),
  resolvePrincipal = vi.fn((_event: unknown, clientId: unknown) => (clientId === 'desktop-client' ? 'desktop:1' : null)),
) {
  let handler: ((event: unknown, clientId: unknown, request: unknown) => Promise<unknown>) | undefined;
  const ipcMain = {
    handle: vi.fn((channel: string, listener: typeof handler) => { if (channel === TERMINAL_COMPLETE_CHANNEL) handler = listener; }),
    removeHandler: vi.fn(),
  };
  const dispose = installTerminalCompletionIpc(ipcMain as never, complete, resolvePrincipal as never);
  return { invoke: (request: unknown, clientId: unknown = 'desktop-client') => handler!({}, clientId, request), complete, ipcMain, dispose };
}

describe('terminal completion IPC', () => {
  it('passes only the checked fields of a valid request to the interpreter', async () => {
    const { invoke, complete } = install();
    await expect(invoke({ sessionId: 's1', line: 'cd sr', caret: 5, extra: 'x' })).resolves.toEqual({ ok: false, reason: 'none' });
    expect(complete).toHaveBeenCalledWith({ sessionId: 's1', line: 'cd sr', caret: 5 });
  });

  it('refuses a caller that is not an authenticated desktop surface', async () => {
    const { invoke, complete } = install();
    await expect(invoke({ sessionId: 's1', line: 'cd sr', caret: 5 }, 'someone-else')).resolves.toEqual({ ok: false, reason: 'unavailable' });
    await expect(invoke({ sessionId: 's1', line: 'cd sr', caret: 5 }, null)).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('refuses malformed requests without asking the interpreter', async () => {
    const { invoke, complete } = install();
    for (const request of [
      null, 'cd', { sessionId: '', line: 'x', caret: 0 }, { sessionId: 's', line: 'x', caret: 2 },
      { sessionId: 's', line: 'x', caret: -1 }, { sessionId: 's', line: 'x', caret: 0.5 },
      { sessionId: 's', line: 'x'.repeat(TERMINAL_COMPLETION_MAX_LINE + 1), caret: 0 },
    ]) {
      await expect(invoke(request)).resolves.toEqual({ ok: false, reason: 'unavailable' });
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it('answers unavailable when the interpreter call throws and removes its handler on dispose', async () => {
    const { invoke, ipcMain, dispose } = install(vi.fn(async () => { throw new Error('gone'); }));
    await expect(invoke({ sessionId: 's1', line: 'g', caret: 1 })).resolves.toEqual({ ok: false, reason: 'unavailable' });
    dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(TERMINAL_COMPLETE_CHANNEL);
  });
});
