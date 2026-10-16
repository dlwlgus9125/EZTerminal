import type { IpcMainInvokeEvent } from 'electron';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';
import type { PlanningAuthority } from './planning-authority';

export function installPlanningIpc(options: {
  readonly ipc: FeatureIpc;
  readonly authority: PlanningAuthority;
  readonly resolvePrincipal: (event: IpcMainInvokeEvent, clientId: unknown) => string | null;
}): () => void {
  const ipc = new IpcRegistration(options.ipc);
  const forbidden = { ok: false, error: 'forbidden', message: 'An authenticated application surface is required.' } as const;
  try {
    ipc.handle('planning:read', (event, clientId: unknown, projectId: unknown, subprojectId?: unknown) => (
      options.resolvePrincipal(event, clientId) ? options.authority.read(projectId, subprojectId) : forbidden
    ));
    ipc.handle('planning:execute', (event, clientId: unknown, command: unknown) => {
      const principal = options.resolvePrincipal(event, clientId);
      return principal ? options.authority.execute(command, 'desktop-user') : forbidden;
    });
  } catch (error) {
    ipc.dispose();
    throw error;
  }
  return ipc.dispose;
}
