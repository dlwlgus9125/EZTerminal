import type { WorkflowPrincipal, WorkflowResult, WorkflowPreviewResult } from '../shared/workflow';
import type { WorkflowService } from './workflow-service';
import type { LocalMutationIngress } from './local-mutation-ingress';

export class WorkflowAuthority {
  constructor(private readonly options: { service: WorkflowService; ready: Promise<unknown>; ingress: LocalMutationIngress; available: () => boolean }) {}
  async read(projectId: unknown): Promise<WorkflowResult> {
    if (typeof projectId !== 'string') return { ok: false, error: 'invalid-command', message: 'Select an authorized project.' };
    try { await this.options.ready; if (!this.options.available()) throw new Error(); return await this.options.service.read(projectId); }
    catch { return { ok: false, error: 'unavailable', message: 'The workflow authority is unavailable.' }; }
  }
  async execute(value: unknown, principal: WorkflowPrincipal): Promise<WorkflowResult> {
    try { return await this.options.ingress.run(async signal => { await this.options.ready; signal.throwIfAborted(); if (!this.options.available()) throw new Error(); return this.options.service.execute(value, principal); }); }
    catch { return { ok: false, error: 'unavailable', message: 'The command result is unconfirmed. Read the workflow and retry the same command ID.' }; }
  }
  async preview(value: unknown): Promise<WorkflowPreviewResult> {
    try { return await this.options.ingress.run(async signal => { await this.options.ready; signal.throwIfAborted(); if (!this.options.available()) throw new Error(); return this.options.service.preview(value); }); }
    catch { return { ok: false, message: 'The workflow preview is unavailable. Preserve your local creation draft.' }; }
  }
  async editPreview(sessionId: string, value: unknown): Promise<WorkflowPreviewResult> {
    try { return await this.options.ingress.run(async signal => { await this.options.ready; signal.throwIfAborted(); if (!this.options.available()) throw new Error(); return this.options.service.editPreview(sessionId, value); }); }
    catch { return { ok: false, message: 'The workflow preview authority is unavailable.' }; }
  }
}
