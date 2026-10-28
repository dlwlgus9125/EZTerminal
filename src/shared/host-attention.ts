import type { AgentActivity } from './agent';
import type { DaemonSnapshot } from './daemon-protocol';
import type { ExecutionRun } from './planning-execution';

/**
 * 나를 기다리는 것 — what waits on the person, computed once by the host so the desktop top bar, the project tabs,
 * the board, the work list and the phone badge all count the same items:
 *
 * - `approval` / `question`: a pending conversation approval of a live session (not archived, with an agent);
 *   a question request is a `question`.
 * - `flow-approval`: an approval stage awaiting a person in a run that is neither completed nor cancelled. A run
 *   frozen with 자동 승인 counts only once the host's automatic decision was refused (a refusal it recorded),
 *   since otherwise the host decides it. An answer stage (v18) waiting for the person counts the same way
 *   (always: 자동 승인 never answers); older phones know this kind, so it keeps it.
 * - `terminal-agent`: a terminal agent blocked on the person; orchestration workers are left to their lead.
 *
 * Finished-work notices (an agent done or failed) stay per device and are not here.
 */
export const HOST_ATTENTION_VERSION = 1 as const;

export type HostAttentionKind = 'approval' | 'question' | 'flow-approval' | 'terminal-agent';

export interface HostAttentionItem {
  /** Stable for the same wait: derived from its kind, project, run or session, and activation or approval. */
  readonly id: string;
  readonly kind: HostAttentionKind;
  readonly projectId?: string;
  /** The conversation, the stage or the terminal agent that waits. */
  readonly title: string;
  /** When the wait began, as far as the host knows (ISO 8601). */
  readonly since: string;
  readonly sessionId?: string;
  readonly approvalId?: string;
  readonly subprojectId?: string;
  readonly runId?: string;
  readonly runRevision?: number;
  readonly activationId?: string;
  readonly nodeId?: string;
  readonly activityId?: string;
}

export interface HostAttention {
  readonly version: typeof HOST_ATTENTION_VERSION;
  /** Changes exactly when the set of items (or what they show) changes; independent of their order. A run's
   * revision moves with every other stage and is left out (clients read it fresh with the snapshot). */
  readonly digest: string;
  /** Newest first. */
  readonly items: readonly HostAttentionItem[];
}

export interface HostAttentionFlowRun {
  readonly projectId: string;
  readonly run: ExecutionRun;
  /** The host refused its automatic decision for this approval stage (it recorded the refusal). */
  readonly autoApprovalRefused: (activationId: string) => boolean;
  /** When the host first saw this stage wait (the run's own time moves with every other stage). */
  readonly awaitingSince?: (activationId: string) => string | undefined;
}

export interface HostAttentionInput {
  /** With `projects`, a flow approval counts only in a project that is still there (not archived or removed). */
  readonly daemon: Pick<DaemonSnapshot, 'sessions' | 'agents' | 'approvals'> & Partial<Pick<DaemonSnapshot, 'projects'>>;
  readonly flows: readonly HostAttentionFlowRun[];
  readonly terminalAgents: readonly AgentActivity[];
  /** Activity ids of orchestration workers (see orchestrationWorkerActivityIds). */
  readonly orchestrationWorkers: ReadonlySet<string>;
}

export function computeHostAttention(input: HostAttentionInput): HostAttention {
  const live = input.daemon.projects && new Set(input.daemon.projects.filter((project) => !project.archivedAt).map((project) => project.id));
  const flows = live ? input.flows.filter((flow) => live.has(flow.projectId)) : input.flows;
  const items = [...conversationItems(input.daemon), ...flowItems(flows), ...terminalItems(input.terminalAgents, input.orchestrationWorkers)]
    .sort((left, right) => right.since.localeCompare(left.since) || left.id.localeCompare(right.id));
  return { version: HOST_ATTENTION_VERSION, digest: attentionDigest(items), items };
}

/** The digest of a set of items, whatever their order. */
export function attentionDigest(items: readonly HostAttentionItem[]): string {
  const canonical = [...items].sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => JSON.stringify(Object.keys(item).filter((key) => key !== 'runRevision').sort().map((key) => [key, item[key as keyof HostAttentionItem]])));
  return stableHash(canonical.join('\n'));
}

function conversationItems(daemon: HostAttentionInput['daemon']): HostAttentionItem[] {
  const sessions = new Map(daemon.sessions.map((session) => [session.id, session]));
  const agents = new Set(daemon.agents.map((agent) => agent.sessionId));
  return daemon.approvals.flatMap((approval) => {
    const session = sessions.get(approval.sessionId);
    if (approval.state !== 'pending' || !session || session.archivedAt || !agents.has(approval.sessionId)) return [];
    const kind = approval.request?.kind === 'question' ? 'question' : 'approval';
    return [{
      id: itemId(kind, session.projectId, session.id, approval.id), kind, projectId: session.projectId, title: session.title,
      since: approval.createdAt, sessionId: session.id, approvalId: approval.id,
    }];
  });
}

function flowItems(flows: readonly HostAttentionFlowRun[]): HostAttentionItem[] {
  return flows.flatMap(({ projectId, run, autoApprovalRefused, awaitingSince }) => {
    const workflow = run.preparation.workflow;
    if (!workflow || run.state === 'completed' || run.state === 'cancelled') return [];
    return (run.workflowRuntime?.activations ?? []).flatMap((activation) => {
      if (activation.state !== 'awaiting-approval' && activation.state !== 'awaiting-answer') return [];
      if (activation.state === 'awaiting-approval' && run.preparation.approvalPolicy === 'auto' && !autoApprovalRefused(activation.id)) return [];
      const node = workflow.graph.nodes.find((entry) => entry.id === activation.nodeId);
      return [{
        id: itemId('flow-approval', projectId, run.runId, activation.id), kind: 'flow-approval' as const, projectId,
        title: node?.title ?? activation.nodeId, since: awaitingSince?.(activation.id) ?? run.updatedAt, subprojectId: workflow.subprojectId,
        runId: run.runId, runRevision: run.revision, activationId: activation.id, nodeId: activation.nodeId,
      }];
    });
  });
}

function terminalItems(agents: readonly AgentActivity[], workers: ReadonlySet<string>): HostAttentionItem[] {
  return agents.flatMap((agent) => agent.state !== 'blocked' || workers.has(agent.id) ? [] : [{
    id: itemId('terminal-agent', agent.projectId ?? '', agent.id, String(agent.stateSeq)), kind: 'terminal-agent' as const,
    ...(agent.projectId ? { projectId: agent.projectId } : {}), title: agent.providerLabel ?? agent.provider,
    since: new Date(agent.updatedAt).toISOString(), activityId: agent.id,
  }]);
}

function itemId(kind: HostAttentionKind, projectId: string, owner: string, wait: string): string {
  return `${kind}-${stableHash(JSON.stringify([kind, projectId, owner, wait]))}`;
}

/** A short deterministic hash (cyrb53, two 32-bit lanes) usable in the renderer and in the main process alike. */
function stableHash(text: string): string {
  let h1 = 0xdeadbeef; let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
