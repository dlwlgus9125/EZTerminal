import type { IpcMainInvokeEvent } from 'electron';
import type { ChatStateResult } from '../shared/chat-state';
import type { ChatStateStore } from './chat-state-store';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';
import type { LocalMutationIngress } from './local-mutation-ingress';

/** Recovery storage is accessible only through an authenticated desktop surface. */
export function installChatStateIpc(options: {
  readonly ipc: FeatureIpc;
  readonly store: Pick<ChatStateStore, 'read' | 'write'>;
  readonly resolvePrincipal: (event: IpcMainInvokeEvent, clientId: unknown) => string | null;
  readonly ready: Promise<unknown>;
  readonly ingress: LocalMutationIngress;
}): () => void {
  const ipc = new IpcRegistration(options.ipc);
  const forbidden: ChatStateResult = { ok: false, error: 'forbidden', message: 'An authenticated application surface is required.' };
  const unavailable: ChatStateResult = { ok: false, error: 'unavailable', message: 'Chat recovery storage is unavailable. Keep the unsaved draft and read stored state before retrying.' };
  try {
    ipc.handle('chat-state:read', async (event, clientId: unknown, scope: unknown): Promise<ChatStateResult> => {
      if (!options.resolvePrincipal(event, clientId)) return forbidden;
      try {
        await options.ready;
        if (!options.resolvePrincipal(event, clientId)) return forbidden;
        return await options.store.read(scope);
      } catch { return unavailable; }
    });
    ipc.handle('chat-state:write', async (event, clientId: unknown, scope: unknown, request: unknown): Promise<ChatStateResult> => {
      if (!options.resolvePrincipal(event, clientId)) return forbidden;
      try {
        return await options.ingress.run(async (signal) => {
          await options.ready;
          signal.throwIfAborted();
          if (!options.resolvePrincipal(event, clientId)) return forbidden;
          return options.store.write(scope, request);
        });
      } catch { return unavailable; }
    });
  } catch (error) {
    ipc.dispose();
    throw error;
  }
  return ipc.dispose;
}
