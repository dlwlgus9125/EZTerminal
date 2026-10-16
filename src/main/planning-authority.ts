import { PlanningCommandSchema, type PlanningMutationResult, type PlanningReadResult } from '../shared/planning';
import type { PlanningService } from './planning-service';
import type { LocalMutationIngress } from './local-mutation-ingress';

/** Transport identity and lifecycle admission stay outside the portable planning store. */
export class PlanningAuthority {
  constructor(private readonly options: {
    readonly service: Pick<PlanningService, 'read' | 'execute'>;
    readonly ready: Promise<unknown>;
    readonly ingress: LocalMutationIngress;
    readonly available: () => boolean;
    readonly onChanged?: (projectId: string) => Promise<void>;
    readonly ownsSubproject?: (projectId: string, subprojectId: string, writing: boolean) => Promise<boolean>;
  }) {}

  async read(projectId: unknown, subprojectId?: unknown): Promise<PlanningReadResult> {
    if (typeof projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(projectId)) {
      return { ok: false, error: 'invalid', message: 'Invalid project identity.' };
    }
    try {
      await this.options.ready;
      if (!this.options.available()) return { ok: false, error: 'unavailable', message: 'Planning authority is unavailable.' };
      if (subprojectId !== undefined && (typeof subprojectId !== 'string' || !await this.options.ownsSubproject?.(projectId, subprojectId, false))) return { ok: false, error: 'forbidden', message: 'The subproject is unavailable.' };
      return await this.options.service.read(projectId, subprojectId as string | undefined);
    } catch {
      return { ok: false, error: 'unavailable', message: 'Planning could not be loaded.' };
    }
  }

  async execute(value: unknown, principalId: string): Promise<PlanningMutationResult> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'invalid', message: 'Invalid planning command.' };
    }
    const parsed = PlanningCommandSchema.safeParse({ ...value, actor: { kind: 'user', id: principalId } });
    if (!parsed.success) return { ok: false, error: 'invalid', message: 'Invalid planning command.' };
    try {
      return await this.options.ingress.run(async (signal) => {
        await this.options.ready;
        signal.throwIfAborted();
        if (!this.options.available()) return { ok: false, error: 'unavailable', message: 'Planning authority is unavailable.' };
        if (parsed.data.subprojectId && !await this.options.ownsSubproject?.(parsed.data.projectId, parsed.data.subprojectId, true)) return { ok: false, error: 'forbidden', message: 'The subproject is unavailable or archived.' };
        const result = await this.options.service.execute(parsed.data);
        if (result.ok) await this.options.onChanged?.(parsed.data.projectId);
        return result;
      });
    } catch {
      // A disconnected caller must reconcile its commandId; failure here does
      // not assert that an already-started filesystem commit was rolled back.
      return { ok: false, error: 'unavailable', message: 'Planning result is unconfirmed. Reload before retrying the same command.' };
    }
  }
}
