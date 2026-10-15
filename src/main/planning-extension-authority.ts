import type { IpcMainInvokeEvent } from 'electron';
import type { PlanningAiResult } from '../shared/planning-ai';
import type { PlanningAssetResult } from '../shared/planning-asset';
import type { LocalMutationIngress } from './local-mutation-ingress';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';

/** One admission boundary for host-owned proposal and binary-asset requests. */
export class PlanningExtensionAuthority<T extends PlanningAiResult | PlanningAssetResult> {
  constructor(private readonly options: {
    readonly ready: Promise<unknown>; readonly ingress: LocalMutationIngress; readonly available: () => boolean;
    readonly request: (value: unknown, principalId: string) => Promise<T>;
  }) {}
  async request(value: unknown, principalId: string): Promise<T | { ok: false; message: string }> {
    try {
      return await this.options.ingress.run(async signal => {
        await this.options.ready; signal.throwIfAborted();
        if (!this.options.available()) throw new Error('Planning authority is unavailable.');
        return this.options.request(value, principalId);
      });
    } catch { return { ok: false, message: 'The result is unconfirmed. Reconcile the saved request before retrying.' }; }
  }
}

export function installPlanningExtensionIpc(options: {
  readonly ipc: FeatureIpc;
  readonly ai: PlanningExtensionAuthority<PlanningAiResult>;
  readonly assets: PlanningExtensionAuthority<PlanningAssetResult>;
  readonly resolvePrincipal: (event: IpcMainInvokeEvent, clientId: unknown) => string | null;
}): () => void {
  const ipc = new IpcRegistration(options.ipc);
  try {
    for (const [channel, authority] of [['planning-ai:request', options.ai], ['planning-asset:request', options.assets]] as const) {
      ipc.handle(channel, (event, clientId: unknown, value: unknown) => options.resolvePrincipal(event, clientId)
        ? authority.request(value, 'desktop-user') : { ok: false, message: 'An authenticated application surface is required.' });
    }
  } catch (error) { ipc.dispose(); throw error; }
  return ipc.dispose;
}
