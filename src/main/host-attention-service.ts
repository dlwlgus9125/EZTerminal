import type { AgentActivity } from '../shared/agent';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import { computeHostAttention, type HostAttention, type HostAttentionFlowRun } from '../shared/host-attention';
import type { ExecutionRun } from '../shared/planning-execution';

export interface HostAttentionServiceOptions {
  /** Projects that have execution runs, read once at start. */
  readonly projectIds: () => readonly string[];
  /** A project's runs as clients see them (stage bindings applied). */
  readonly readRuns: (projectId: string) => readonly ExecutionRun[];
  /** The host refused its automatic decision on this approval stage (a recorded refusal receipt). */
  readonly autoApprovalRefused: (projectId: string, runId: string, activationId: string) => boolean;
  readonly terminalAgents: () => readonly AgentActivity[];
  readonly orchestrationWorkers: () => ReadonlySet<string>;
  /** Tells clients to read the snapshot again: an events-only daemon commit (flows and terminals move no revision). */
  readonly announce: () => Promise<void>;
  readonly reportError?: (error: unknown) => void;
  readonly debounceMs?: number;
}

/**
 * Keeps what waits on the person (see src/shared/host-attention.ts) for the daemon snapshot. Conversation approvals come
 * from the snapshot itself (their changes already move its revision); flow approvals and blocked terminal agents do
 * not, so a change in those is announced once, after it settles.
 */
export class HostAttentionService {
  private readonly flows = new Map<string, readonly HostAttentionFlowRun[]>();
  private announced: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly options: HostAttentionServiceOptions) {
    try {
      for (const projectId of options.projectIds()) {
        try { this.load(projectId); } catch (error) { options.reportError?.(error); }
      }
    } catch (error) { options.reportError?.(error); }
    this.announced = this.ownDigest();
  }

  /** What waits now, for a snapshot about to be sent. */
  attention(daemon: Pick<DaemonSnapshot, 'sessions' | 'agents' | 'approvals'>): HostAttention {
    return computeHostAttention({ daemon, flows: [...this.flows.values()].flat(), terminalAgents: this.options.terminalAgents(), orchestrationWorkers: this.options.orchestrationWorkers() });
  }

  /** A project's execution ledger committed (a new receipt, a refusal or a restart recovery). */
  projectChanged(projectId: string): void {
    if (this.closed) return;
    try { this.load(projectId); } catch (error) { this.options.reportError?.(error); return; }
    this.schedule();
  }

  /** Terminal agents or orchestration workers changed. */
  terminalsChanged(): void {
    if (!this.closed) this.schedule();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private load(projectId: string): void {
    const runs = this.options.readRuns(projectId).filter((run) => run.state !== 'completed' && run.state !== 'cancelled');
    if (!runs.length) { this.flows.delete(projectId); return; }
    // A refusal is itself a ledger commit, so it is read here once rather than for every snapshot.
    this.flows.set(projectId, runs.map((run) => {
      const refused = new Set(run.preparation.approvalPolicy !== 'auto' ? [] : (run.workflowRuntime?.activations ?? [])
        .filter((activation) => activation.state === 'awaiting-approval' && this.options.autoApprovalRefused(projectId, run.runId, activation.id))
        .map((activation) => activation.id));
      return { projectId, run, autoApprovalRefused: (activationId: string) => refused.has(activationId) };
    }));
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed) return;
      const digest = this.ownDigest();
      if (digest === this.announced) return;
      this.announced = digest;
      this.options.announce().catch((error: unknown) => this.options.reportError?.(error));
    }, this.options.debounceMs ?? 200);
  }

  /** The part this service owns (flows and terminals), whose changes move no daemon revision. */
  private ownDigest(): string {
    return this.attention({ sessions: [], agents: [], approvals: [] }).digest;
  }
}
