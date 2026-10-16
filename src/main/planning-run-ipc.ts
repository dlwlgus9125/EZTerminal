import type { IpcMainInvokeEvent } from 'electron';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';
import type { PlanningRunAuthority } from './planning-run-authority';

export function installPlanningRunIpc(options: {
  readonly ipc: FeatureIpc;
  readonly authority: PlanningRunAuthority;
  readonly resolvePrincipal: (event: IpcMainInvokeEvent, clientId: unknown) => string | null;
}): () => void {
  const ipc = new IpcRegistration(options.ipc);
  const forbidden = { ok: false, error: 'forbidden', message: 'An authenticated application surface is required.' } as const;
  try {
    ipc.handle('planning-run:read', (event, clientId: unknown, projectId: unknown, subprojectId: unknown) => (
      options.resolvePrincipal(event, clientId) ? options.authority.read(projectId, subprojectId) : forbidden
    ));
    ipc.handle('planning-run:execute', (event, clientId: unknown, command: unknown) => (
      options.resolvePrincipal(event, clientId) ? options.authority.execute(command, { kind: 'desktop', id: 'desktop-user' }) : forbidden
    ));
    ipc.handle('planning-run:result', (event, clientId: unknown, query: unknown) => (
      options.resolvePrincipal(event, clientId) ? options.authority.readResult(query) : forbidden
    ));
  } catch (error) { ipc.dispose(); throw error; }
  return ipc.dispose;
}
