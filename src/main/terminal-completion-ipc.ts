import type { IpcMain, IpcMainInvokeEvent } from 'electron';

import {
  isTerminalCompletionRequest,
  type TerminalCompletionRequest,
  type TerminalCompletionResult,
} from '../shared/terminal-completion';

export const TERMINAL_COMPLETE_CHANNEL = 'terminal:complete';

/**
 * Tab completion for the desktop terminal. Only an authenticated desktop
 * surface may ask (the same principal check as the other protected stores; the
 * phone's bridge does not route here); the request is checked before the
 * interpreter sees it, and a session the interpreter does not know answers
 * `unavailable`.
 */
export function installTerminalCompletionIpc(
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>,
  complete: (request: TerminalCompletionRequest) => Promise<TerminalCompletionResult>,
  resolvePrincipal: (event: IpcMainInvokeEvent, clientId: unknown) => string | null,
): () => void {
  ipcMain.handle(TERMINAL_COMPLETE_CHANNEL, async (event, clientId: unknown, request: unknown): Promise<TerminalCompletionResult> => {
    if (!resolvePrincipal(event, clientId) || !isTerminalCompletionRequest(request)) return { ok: false, reason: 'unavailable' };
    try {
      return await complete({ sessionId: request.sessionId, line: request.line, caret: request.caret });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  });
  return () => ipcMain.removeHandler(TERMINAL_COMPLETE_CHANNEL);
}
