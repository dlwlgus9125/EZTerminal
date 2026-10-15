import type { IpcMainInvokeEvent } from 'electron';
import type { PlanningDraftResult } from '../shared/planning-draft';
import type { PlanningDraftStore } from './planning-draft-store';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';
import type { LocalMutationIngress } from './local-mutation-ingress';

export function installPlanningDraftIpc(options: {
  readonly ipc: FeatureIpc;
  readonly store: Pick<PlanningDraftStore, 'read' | 'write'>;
  readonly resolvePrincipal: (event: IpcMainInvokeEvent, clientId: unknown) => string | null;
  readonly ready: Promise<unknown>;
  readonly ingress: LocalMutationIngress;
}): () => void {
  const ipc = new IpcRegistration(options.ipc);
  const forbidden: PlanningDraftResult = { ok: false, error: 'forbidden', message: 'An authenticated application surface is required.' };
  const unavailable: PlanningDraftResult = { ok: false, error: 'unavailable', message: 'Planning recovery storage is unavailable. Keep local edits and check stored state before retrying.' };
  try {
    ipc.handle('planning-draft:read', async (event, clientId: unknown, projectId: unknown, subprojectId?: unknown): Promise<PlanningDraftResult> => {
      if (!options.resolvePrincipal(event, clientId)) return forbidden;
      try {
        await options.ready;
        return options.resolvePrincipal(event, clientId) ? await options.store.read(projectId, subprojectId) : forbidden;
      } catch { return unavailable; }
    });
    ipc.handle('planning-draft:write', async (event, clientId: unknown, projectId: unknown, request: unknown, subprojectId?: unknown): Promise<PlanningDraftResult> => {
      if (!options.resolvePrincipal(event, clientId)) return forbidden;
      try {
        return await options.ingress.run(async (signal) => {
          await options.ready; signal.throwIfAborted();
          return options.resolvePrincipal(event, clientId) ? options.store.write(projectId, request, subprojectId) : forbidden;
        });
      } catch { return unavailable; }
    });
  } catch (error) { ipc.dispose(); throw error; }
  return ipc.dispose;
}
