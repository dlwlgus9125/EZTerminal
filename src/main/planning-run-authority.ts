import { PlanningRunRequestSchema, type PlanningRunResult } from '../shared/planning-run';
import type { PlanningRunService } from './planning-run-service';
import type { LocalMutationIngress } from './local-mutation-ingress';
import { PlanningResultQuerySchema, type PlanningResultQueryResult } from '../shared/planning-result';
import type { PlanningResultService } from './planning-result-service';

export class PlanningRunAuthority {
  constructor(private readonly options: {
    readonly service: PlanningRunService;
    readonly ready: Promise<unknown>;
    readonly ingress: LocalMutationIngress;
    readonly available: () => boolean;
    readonly results: Pick<PlanningResultService, 'readResult' | 'readIntegration' | 'readLog' | 'readDiff' | 'readDeviceCapture'>;
    readonly ownsSubproject?: (projectId: string, subprojectId: string, writing?: boolean) => Promise<boolean>;
  }) {}

  async readResult(value: unknown): Promise<PlanningResultQueryResult> {
    const parsed = PlanningResultQuerySchema.safeParse(value);
    if (!parsed.success) return { ok: false, message: 'Invalid result identity.' };
    try {
      await this.options.ready;
      if (!this.options.available() || !this.options.service.read(parsed.data.projectId).ok) throw new Error('The project is unavailable.');
      const query = parsed.data;
      const scope = await this.read(query.projectId, query.subprojectId); if (!scope.ok) throw new Error(scope.message);
      const runs = scope.snapshot.runs;
      if ((query.kind === 'attempt' || query.kind === 'diff') && !runs.some(run => run.attempts.some(attempt => attempt.attemptId === query.attemptId))) throw new Error('This result belongs to another planning scope.');
      if (query.kind === 'integration' && !runs.some(run => run.runId === query.runId)) throw new Error('This integration belongs to another planning scope.');
      if (query.kind === 'log' || query.kind === 'capture') {
        const reference = query.reference; const matches = (entry: { logRefs: readonly string[]; captureRefs?: readonly string[]; device?: { captureRefs: readonly string[] } }) => [...entry.logRefs, ...entry.captureRefs ?? [], ...entry.device?.captureRefs ?? []].some(value => value === reference || value === `capture:${reference}`);
        let referenced = runs.some(run => run.evidence.some(matches));
        for (const run of runs) if (!referenced) referenced = Boolean((await this.options.results.readIntegration(query.projectId, run.runId))?.validations.some(matches));
        if (!referenced) throw new Error('This evidence is not referenced by the selected planning scope.');
      }
      if (query.kind === 'attempt') return { ok: true, kind: query.kind, result: await this.options.results.readResult(query.projectId, query.attemptId) };
      if (query.kind === 'integration') return { ok: true, kind: query.kind, integration: await this.options.results.readIntegration(query.projectId, query.runId) };
      if (query.kind === 'diff') {
        const text = await this.options.results.readDiff(query.projectId, query.attemptId);
        return text === null ? { ok: false, message: 'This result has no Git diff.' } : { ok: true, kind: query.kind, text };
      }
      if (query.kind === 'capture') {
        const capture = await this.options.results.readDeviceCapture(query.projectId, query.reference);
        return capture === null ? { ok: false, message: 'This device capture is unavailable.' } : { ok: true, kind: query.kind, ...capture };
      }
      const text = await this.options.results.readLog(query.projectId, query.reference);
      return text === null ? { ok: false, message: 'This evidence log is unavailable.' } : { ok: true, kind: query.kind, text };
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'The result is unavailable.' }; }
  }

  async read(projectId: unknown, subprojectId?: unknown): Promise<PlanningRunResult> {
    if (typeof projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(projectId)) {
      return { ok: false, error: 'invalid-command', message: 'Invalid project identity.' };
    }
    try {
      await this.options.ready;
      if (!this.options.available()) throw new Error('Execution authority is unavailable.');
      if (subprojectId !== undefined && (typeof subprojectId !== 'string' || !await this.options.ownsSubproject?.(projectId, subprojectId))) throw new Error('The subproject is unavailable.');
      const result = this.options.service.read(projectId);
      return result.ok ? { ...result, snapshot: { ...result.snapshot, runs: result.snapshot.runs.filter(run => (run.preparation.subprojectId ?? 'legacy-default') === (subprojectId ?? 'legacy-default')) } } : result;
    } catch (error) { return { ok: false, error: 'unavailable', message: error instanceof Error ? error.message : 'Execution authority is unavailable.' }; }
  }

  async execute(value: unknown, principal: { kind: 'desktop' | 'android'; id: string }): Promise<PlanningRunResult> {
    const parsed = PlanningRunRequestSchema.safeParse(value);
    if (!parsed.success) return { ok: false, error: 'invalid-command', message: 'Invalid execution request.' };
    try {
      return await this.options.ingress.run(async (signal) => {
        await this.options.ready;
        signal.throwIfAborted();
        if (!this.options.available()) throw new Error('Execution authority is unavailable.');
        return this.options.service.execute(parsed.data, principal);
      });
    } catch { return { ok: false, error: 'unavailable', message: 'The result is unconfirmed. Refresh the execution state before retrying this command.' }; }
  }
}
