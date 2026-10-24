import { WorkflowDraftResultSchema, type WorkflowDraftAccess, type WorkflowDraftState } from '../../shared/workflow-draft';

/** Serializes encrypted recovery CAS writes. A failed/uncertain write requires an explicit reread. */
export class WorkflowRecovery {
  private revision: number | undefined;
  private blocked = false;
  /** The last read came from an older version's storage (its graphs are a reduced view). */
  olderVersion = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly projectId: string, private readonly hostId: string, private readonly access: WorkflowDraftAccess) {}
  async read(): Promise<WorkflowDraftState | null> {
    await this.queue.catch(() => undefined);
    const result = WorkflowDraftResultSchema.parse(await this.access.workflowDraftRead(this.projectId));
    if (!result.ok) throw new Error(result.message);
    if (result.snapshot.projectId !== this.projectId || result.snapshot.state && result.snapshot.state.hostId !== this.hostId) throw new Error('Workflow recovery belongs to another PC or project.');
    this.revision = result.snapshot.revision; this.blocked = false; this.olderVersion = result.snapshot.olderVersion === true;
    return result.snapshot.state;
  }
  write(state: WorkflowDraftState): Promise<void> {
    if (state.projectId !== this.projectId || state.hostId !== this.hostId) return Promise.reject(new Error('Workflow recovery belongs to another PC or project.'));
    const operation = this.queue.catch(() => undefined).then(async () => {
      if (this.revision === undefined || this.blocked) throw new Error('Read secure workflow recovery before saving. Your input is preserved.');
      try {
        const result = WorkflowDraftResultSchema.parse(await this.access.workflowDraftWrite(this.projectId, { expectedRevision: this.revision, state }));
        if (!result.ok) throw new Error(result.message);
        if (result.snapshot.projectId !== this.projectId || result.snapshot.state?.hostId !== this.hostId) throw new Error('Workflow recovery receipt scope mismatch.');
        this.revision = result.snapshot.revision;
      } catch (reason) { this.blocked = true; throw reason; }
    });
    this.queue = operation; return operation;
  }
}
