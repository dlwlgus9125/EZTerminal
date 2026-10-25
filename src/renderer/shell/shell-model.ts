import type { DaemonApproval, DaemonSnapshot } from '../../shared/daemon-protocol';
import { blockingRunOf } from '../../shared/planning-execution';
import type { WorkflowSnapshot } from '../../shared/workflow';
import { currentFlowRun, flowRunNumber, runStageConversation } from '../../shared/workflow-run-view';
import { projectRunOverlay, type WorkflowNodeRunStatus } from '../workflow/workflow-canvas-model';

/**
 * What the Board + Desk shell shows, derived from what the host already
 * reports (daemon snapshot, workflow snapshot). Pure, so the board, the live
 * list and their stories read one model.
 */

/** A lamp's colour: on = working, amber = waits for the person, red = stopped on an error. */
export type Lamp = 'on' | 'amber' | 'red' | 'ok' | 'idle';

export type ConversationState = 'working' | 'approval' | 'question' | 'failed' | 'stopped' | 'done' | 'new';

export interface LiveConversation {
  readonly sessionId: string;
  readonly title: string;
  readonly providerId: string;
  readonly state: ConversationState;
  readonly lamp: Lamp;
  readonly updatedAt: string;
  readonly children: readonly LiveConversation[];
}

export interface WaitingItem {
  /** The conversation approval, or the host's item id for a flow approval or a terminal agent. */
  readonly approvalId: string;
  /** The conversation that waits; empty for a flow approval or a terminal agent. */
  readonly sessionId: string;
  /** The conversation that waits (the parent when a subagent asked), the stage, or the terminal agent. */
  readonly title: string;
  readonly providerId: string;
  readonly kind: 'command' | 'file-change' | 'tool' | 'question' | 'plan' | 'other' | 'flow-approval' | 'terminal-agent';
  /** One line: the command, the file, the question. */
  readonly detail: string;
  readonly at: string;
  /** Where a flow approval or a terminal agent waits (a conversation's project comes from its session). */
  readonly projectId?: string;
  readonly flow?: { readonly subprojectId: string; readonly nodeId: string };
}

export type StageLamp = 'done' | 'run' | 'wait' | 'idle' | 'fail';

export interface LiveFlow {
  readonly subprojectId: string;
  readonly title: string;
  /** 실행 #n of the run shown (the one still going, else the latest); 0 = never run. */
  readonly runNumber: number;
  readonly phase: 'never-run' | 'prepared' | 'running' | 'awaiting-approval' | 'paused' | 'completed' | 'cancelled' | 'attention';
  readonly lamp: Lamp;
  /** The run's stages (a condition is part of its review stage); `sessionId` = this stage's conversation in this run. */
  readonly stages: readonly { readonly id: string; readonly title: string; readonly state: StageLamp; readonly sessionId?: string }[];
  readonly autoApprove: boolean;
  /** 다시 실행 can be sent now: no run of the flow is going and its review AI is saved. */
  readonly canRunAgain: boolean;
}

const WORKING = new Set(['starting', 'queued', 'working']);

function lampOf(state: ConversationState): Lamp {
  switch (state) {
    case 'working': return 'on';
    case 'approval': case 'question': return 'amber';
    case 'failed': return 'red';
    case 'done': return 'ok';
    default: return 'idle';
  }
}

function waitingKind(approval: DaemonApproval): WaitingItem['kind'] {
  return approval.request?.kind ?? 'other';
}

/** Conversations of a project: top level, newest first, provider subagents nested under their parent. */
export function projectConversations(
  snapshot: DaemonSnapshot | null,
  projectId: string,
  options: { readonly exclude?: ReadonlySet<string> } = {},
): LiveConversation[] {
  if (!snapshot) return [];
  const agents = new Map(snapshot.agents.map((agent) => [agent.sessionId, agent]));
  const pending = new Map<string, DaemonApproval[]>();
  for (const approval of snapshot.approvals) {
    if (approval.state !== 'pending') continue;
    pending.set(approval.sessionId, [...(pending.get(approval.sessionId) ?? []), approval]);
  }
  const attached = snapshot.agentRelations.filter((relation) => relation.detachedAt === undefined);
  const childIds = new Set(attached.map((relation) => relation.childSessionId));
  const turned = new Set(snapshot.turns.map((turn) => turn.sessionId));
  const build = (sessionId: string, seen: ReadonlySet<string>): LiveConversation | null => {
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
    const agent = agents.get(sessionId);
    if (!session || !agent || session.archivedAt || agent.state === 'archived') return null;
    const waits = pending.get(sessionId) ?? [];
    const state: ConversationState = waits.some((approval) => approval.request?.kind === 'question') ? 'question'
      : waits.length > 0 || agent.state === 'blocked' ? 'approval'
        : WORKING.has(agent.state) ? 'working'
          : agent.state === 'error' || agent.state === 'delivery-uncertain' ? 'failed'
            : agent.state === 'interrupted' ? 'stopped'
              : turned.has(sessionId) ? 'done' : 'new';
    const next = new Set(seen).add(sessionId);
    const children = attached
      .filter((relation) => relation.parentSessionId === sessionId && !next.has(relation.childSessionId))
      .map((relation) => build(relation.childSessionId, next))
      .filter((child): child is LiveConversation => child !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return {
      sessionId, title: session.title, providerId: agent.providerId, state, lamp: lampOf(state),
      updatedAt: [session.updatedAt, agent.updatedAt].sort().at(-1)!, children,
    };
  };
  return snapshot.sessions
    .filter((session) => session.projectId === projectId && session.kind === 'agent' && !childIds.has(session.id)
      // Planning runs report through their flow, not as conversations.
      && !session.id.startsWith('planning-') && !options.exclude?.has(session.id))
    .map((session) => build(session.id, new Set()))
    .filter((item): item is LiveConversation => item !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** Approvals and questions that wait on the person, newest first; all projects when none is given. */
export function waitingItems(snapshot: DaemonSnapshot | null, projectId?: string): WaitingItem[] {
  if (!snapshot) return [];
  const sessions = new Map(snapshot.sessions.map((session) => [session.id, session]));
  const agents = new Map(snapshot.agents.map((agent) => [agent.sessionId, agent]));
  return snapshot.approvals
    .filter((approval) => approval.state === 'pending')
    .flatMap((approval) => {
      const session = sessions.get(approval.sessionId);
      const agent = agents.get(approval.sessionId);
      if (!session || !agent || session.archivedAt || (projectId && session.projectId !== projectId)) return [];
      const request = approval.request;
      const detail = request?.kind === 'command' ? request.command
        : request?.kind === 'question' ? request.questions[0]?.question ?? approval.title
          : request?.kind === 'file-change' ? request.files.map((file) => file.path).join(', ')
            : request?.kind === 'tool' ? [request.toolName, request.target].filter(Boolean).join(' · ')
              : approval.detail ?? approval.title;
      return [{
        approvalId: approval.id, sessionId: approval.sessionId, title: session.title, providerId: agent.providerId,
        kind: waitingKind(approval), detail, at: approval.createdAt,
      }];
    })
    .sort((left, right) => right.at.localeCompare(left.at));
}

/**
 * Everything that waits on the person: the conversation approvals above, plus what the host counts besides them
 * (flow approval stages, blocked terminal agents) when it sends `attention` (src/shared/host-attention.ts). An older
 * host sends none: its flow approvals stay on the flow and its terminal agents in 받은 요청.
 */
export function hostWaitingItems(snapshot: DaemonSnapshot | null, projectId?: string): WaitingItem[] {
  // Conversation approvals are read here from the same snapshot, by the host's own rule (pending, live session with an
  // agent: see conversationItems in host-attention.ts), for their command or question line; keep the two rules alike.
  const conversations = waitingItems(snapshot, projectId);
  const attention = snapshot?.attention;
  if (!attention) return conversations;
  const others = attention.items.flatMap((item): WaitingItem[] => {
    if ((item.kind !== 'flow-approval' && item.kind !== 'terminal-agent') || (projectId && item.projectId !== projectId)) return [];
    return [{
      approvalId: item.id, sessionId: '', title: item.title, providerId: '', kind: item.kind, detail: '', at: item.since,
      ...(item.projectId ? { projectId: item.projectId } : {}),
      ...(item.kind === 'flow-approval' && item.subprojectId && item.nodeId ? { flow: { subprojectId: item.subprojectId, nodeId: item.nodeId } } : {}),
    }];
  });
  return [...conversations, ...others].sort((left, right) => right.at.localeCompare(left.at));
}

function stageLamp(status: WorkflowNodeRunStatus | undefined): StageLamp {
  switch (status) {
    case 'completed': return 'done';
    case 'awaiting-approval': case 'paused': return 'wait';
    case 'needs-attention': case 'rejected': case 'retry-exhausted': return 'fail';
    case 'working': case 'queued': case 'reviewing': case 'reconciling': case 'waiting': return 'run';
    default: return 'idle';
  }
}

/** The project's live subprojects with their latest run, as lamps on a wire. */
export function projectFlows(workflow: Pick<WorkflowSnapshot, 'subprojects' | 'runs'> | null): LiveFlow[] {
  if (!workflow) return [];
  return workflow.subprojects
    .filter((subproject) => subproject.status === 'active' && !subproject.legacyPlanning)
    .map((subproject) => {
      // The run still going, else the latest: the run the flow screen opens, with the same number.
      const latest = currentFlowRun(workflow.runs, subproject.id);
      const overlay = latest ? projectRunOverlay(latest) : null;
      const graph = latest?.preparation.workflow?.graph ?? subproject.graph;
      const stages = graph.nodes.filter((node) => node.operation !== 'condition').map((node) => {
        const conversation = runStageConversation(latest, node.id);
        return { id: node.id, title: node.title, state: stageLamp(overlay?.nodes[node.id]?.status), ...(conversation ? { sessionId: conversation.sessionId } : {}) };
      });
      const phase: LiveFlow['phase'] = !latest ? 'never-run'
        : (overlay?.awaitingApproval.length ?? 0) > 0 ? 'awaiting-approval'
          : stages.some((stage) => stage.state === 'fail') && latest.state !== 'completed' ? 'attention'
            : latest.state === 'completed' ? 'completed'
              : latest.state === 'cancelled' ? 'cancelled'
                : latest.state === 'paused' ? 'paused'
                  : latest.state === 'prepared' ? 'prepared' : 'running';
      const lamp: Lamp = phase === 'awaiting-approval' || phase === 'paused' ? 'amber'
        : phase === 'attention' ? 'red' : phase === 'running' ? 'on' : phase === 'completed' ? 'ok' : 'idle';
      return { subprojectId: subproject.id, title: subproject.title, runNumber: latest ? flowRunNumber(workflow.runs, latest) : 0, phase, lamp, stages,
        autoApprove: subproject.autoApprove === true, canRunAgain: !!subproject.runSettings && !blockingRunOf(workflow.runs, subproject.id) };
    });
}

/** A conversation and every subagent under it. */
export function flattenConversations(items: readonly LiveConversation[]): LiveConversation[] {
  return items.flatMap((item) => [item, ...flattenConversations(item.children)]);
}

/** Other projects that need a look: waiting, failed or working counts (subagents included), busiest first. */
export function otherProjects(snapshot: DaemonSnapshot | null, currentProjectId: string | null): {
  readonly projectId: string; readonly name: string; readonly waiting: number; readonly failed: number; readonly working: number;
}[] {
  if (!snapshot) return [];
  return snapshot.projects
    .filter((project) => project.id !== currentProjectId && !project.archivedAt)
    .map((project) => {
      const items = flattenConversations(projectConversations(snapshot, project.id));
      return {
        projectId: project.id, name: project.name,
        waiting: items.filter((item) => item.lamp === 'amber').length,
        failed: items.filter((item) => item.state === 'failed').length,
        working: items.filter((item) => item.state === 'working').length,
      };
    })
    .filter((project) => project.waiting + project.failed + project.working > 0)
    .sort((left, right) => (right.waiting - left.waiting) || (right.failed - left.failed) || (right.working - left.working));
}
