import type { IpcMainInvokeEvent, WebContents } from 'electron';

import type { AgentSideQuestionResult } from '../shared/agent-side-question';
import type { AgentSideQuestionHost } from './agent-side-question-service';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';
import type { LocalMutationIngress } from './local-mutation-ingress';

interface InstallAgentSideQuestionIpcOptions {
  readonly ipc: FeatureIpc;
  readonly host: AgentSideQuestionHost;
  readonly resolveDesktopPrincipal: (event: IpcMainInvokeEvent, clientId: unknown) => unknown;
  readonly ingress: LocalMutationIngress;
  readonly maxPerSender?: number;
}

const requestIdOf = (request: unknown): string | undefined => {
  const requestId = typeof request === 'object' && request !== null && !Array.isArray(request)
    ? (request as { readonly requestId?: unknown }).requestId
    : undefined;
  return typeof requestId === 'string' && requestId.length >= 1 && requestId.length <= 128 ? requestId : undefined;
};

/**
 * `agent-side-question:ask` (invoke) and `agent-side-question:cancel` (send). Each pending ask is
 * keyed by sender and request id; a closing, crashing or navigating renderer aborts all of its own.
 */
export function installAgentSideQuestionIpc(options: InstallAgentSideQuestionIpcOptions): () => void {
  const ipcMain = new IpcRegistration(options.ipc);
  const maxPerSender = options.maxPerSender ?? 4;
  const pending = new Map<string, AbortController>();
  const wired = new WeakSet<WebContents>();
  const abortSender = (senderId: number): void => {
    for (const [key, controller] of pending) {
      if (key.startsWith(`${String(senderId)}:`)) {
        controller.abort();
        pending.delete(key);
      }
    }
  };
  const wire = (sender: WebContents): void => {
    if (wired.has(sender)) return;
    wired.add(sender);
    const senderId = sender.id;
    const release = (): void => abortSender(senderId);
    sender.on('destroyed', release);
    sender.on('render-process-gone', release);
    sender.on('did-navigate', release);
  };
  try {
    ipcMain.handle('agent-side-question:ask', async (event, clientId: unknown, request: unknown): Promise<AgentSideQuestionResult> => {
      if (!options.resolveDesktopPrincipal(event, clientId)) return { ok: false, code: 'unavailable' };
      const requestId = requestIdOf(request);
      if (!requestId) return { ok: false, code: 'invalid' };
      const key = `${String(event.sender.id)}:${requestId}`;
      const own = [...pending.keys()].filter((entry) => entry.startsWith(`${String(event.sender.id)}:`)).length;
      if (pending.has(key) || own >= maxPerSender) return { ok: false, code: 'busy' };
      wire(event.sender);
      const controller = new AbortController();
      pending.set(key, controller);
      try {
        return await options.ingress.run((shutdown) => options.host.ask(request, AbortSignal.any([controller.signal, shutdown])));
      } catch {
        return { ok: false, code: 'unavailable' };
      } finally {
        if (pending.get(key) === controller) pending.delete(key);
      }
    });
    // Keyed by the sender, so a renderer can only cancel its own asks.
    ipcMain.on('agent-side-question:cancel', (event, requestId: unknown) => {
      if (typeof requestId !== 'string') return;
      const key = `${String(event.sender.id)}:${requestId}`;
      pending.get(key)?.abort();
      pending.delete(key);
    });
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return () => {
    for (const controller of pending.values()) controller.abort();
    pending.clear();
    ipcMain.dispose();
  };
}
