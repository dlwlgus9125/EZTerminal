import type { IpcMainInvokeEvent } from 'electron';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';
import { gateLocalMutation } from './local-mutation-ipc';
import type { LocalMutationIngress } from './local-mutation-ingress';
import type { ConversationHistoryService } from './conversation-history-service';
import type { ConversationQuery, HistoryResumePreparationRequest, HistoryResumeRequest } from '../shared/conversation-history';
import type { WorkflowNavigationResult } from '../shared/workflow';

export function installConversationHistoryIpc(options: {
  readonly ipc: FeatureIpc;
  readonly service: ConversationHistoryService;
  readonly navigation: (projectId: string) => Promise<WorkflowNavigationResult>;
  readonly ready: Promise<unknown>;
  readonly ingress: LocalMutationIngress;
  readonly resolvePrincipal: (event: IpcMainInvokeEvent, clientId: unknown) => string | null;
}): () => void {
  const ipc = new IpcRegistration(options.ipc);
  const denied = { ok: false, reason: 'unavailable', message: 'A connected application surface is required.' } as const;
  try {
    ipc.handle('conversation-history:resolve', async (event, clientId: unknown, ref: unknown) => {
      if (!options.resolvePrincipal(event, clientId)) return denied;
      await options.ready; return options.service.resolveConversation(ref as import('../shared/conversation-history').ConversationRef);
    });
    ipc.handle('workflow:navigation', async (event, clientId: unknown, projectId: unknown) => {
      if (!options.resolvePrincipal(event, clientId) || typeof projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(projectId))
        return { ok: false, error: 'invalid', message: 'A connected application and valid project are required.' };
      await options.ready; return options.navigation(projectId);
    });
    ipc.handle('conversation-history:list', async (event, clientId: unknown, query: unknown) => {
      if (!options.resolvePrincipal(event, clientId)) return denied;
      await options.ready; return options.service.listConversations(query as ConversationQuery);
    });
    ipc.handle('conversation-history:read', async (event, clientId: unknown, id: unknown, cursor?: unknown, limit?: unknown) => {
      if (!options.resolvePrincipal(event, clientId)) return denied;
      await options.ready; return options.service.readConversation(id as string, cursor as string | undefined, limit as number | undefined);
    });
    ipc.handle('conversation-history:prepare-resume', async (event, clientId: unknown, request: unknown) => {
      if (!options.resolvePrincipal(event, clientId)) return denied;
      await options.ready; return options.service.prepareHistoryResume(request as HistoryResumePreparationRequest);
    });
    ipc.handle('conversation-history:resume', gateLocalMutation(options.ingress, async (event, clientId: unknown, request: unknown) => {
      const principal = options.resolvePrincipal(event, clientId);
      if (!principal) return denied;
      await options.ready; return options.service.resumeHistory(request as HistoryResumeRequest, { kind: 'desktop', id: principal });
    }));
  } catch (error) { ipc.dispose(); throw error; }
  return ipc.dispose;
}
