import type { AgentActivity } from '../../../src/shared/agent';
import type { AgentUsage } from '../../../src/shared/agent-usage';
import type { DaemonSnapshot } from '../../../src/shared/daemon-protocol';
import type { WorkflowSnapshot } from '../../../src/shared/workflow';
import {
  projectConversations,
  projectFlows,
  waitingItems,
  type Lamp,
  type LiveConversation,
  type LiveFlow,
  type WaitingItem,
} from '../../../src/renderer/shell/shell-model';

/**
 * The phone's first screen (I4 feed): 나를 기다리는 것 across every project, then the flows and
 * conversations of the project chosen in the header (or of all projects). Pure: the feed view,
 * the badge and their tests read one model, built on the desktop shell model.
 */

/** `null` = every project. */
export type FeedScope = string | null;

export type FeedWaitingKind = 'approval' | 'question' | 'plan' | 'flow-approval' | 'terminal-agent';

/** What a card can decide by itself; everything else opens where the decision is made. */
export type FeedDecision =
  | { readonly target: 'conversation'; readonly approvalId: string }
  | { readonly target: 'terminal'; readonly activityId: string; readonly approvalId: string };

export interface FeedWaitingItem {
  readonly key: string;
  readonly kind: FeedWaitingKind;
  readonly at: string;
  /** The conversation, the stage or the terminal agent that waits. */
  readonly title: string;
  /** One line: the command, the files, the question, the tool. */
  readonly detail: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly providerId?: string;
  /** A conversation approval's request kind (command, file-change, tool, other). */
  readonly requestKind?: WaitingItem['kind'];
  readonly sessionId?: string;
  readonly approvalId?: string;
  readonly activityId?: string;
  readonly flow?: { readonly subprojectId: string; readonly nodeId: string; readonly runId?: string };
  readonly decide?: FeedDecision;
}

export interface FeedConversation extends LiveConversation {
  readonly projectId: string;
  readonly projectName: string;
}

export interface FeedFlow extends LiveFlow {
  readonly projectId: string;
  readonly projectName: string;
}

export interface FeedProject {
  readonly id: string;
  readonly name: string;
}

/** Approvals a card answers itself, like the desktop board (src/renderer/shell/ProjectBoard.tsx). */
const CARD_DECIDES = new Set<WaitingItem['kind']>(['command', 'file-change', 'tool']);

/** Projects still there, in the host's order. */
export function feedProjects(daemon: DaemonSnapshot | null): FeedProject[] {
  return (daemon?.projects ?? []).filter((project) => !project.archivedAt).map((project) => ({ id: project.id, name: project.name }));
}

function projectNames(daemon: DaemonSnapshot | null): ReadonlyMap<string, string> {
  return new Map((daemon?.projects ?? []).map((project) => [project.id, project.name]));
}

/** A terminal agent's line: its command, else its tool. */
function terminalDetail(activity: AgentActivity | undefined): string {
  return activity?.approval?.command ?? activity?.approval?.toolName ?? '';
}

function terminalDecision(activity: AgentActivity | undefined): FeedDecision | undefined {
  const approval = activity?.approval;
  return activity && approval?.pending ? { target: 'terminal', activityId: activity.id, approvalId: approval.approvalId } : undefined;
}

/**
 * 나를 기다리는 것, newest first, always across every project. Conversation approvals are read from the snapshot
 * by the host's own rule (see waitingItems); flow approvals and blocked terminal agents come from the host's
 * `attention` when it sends one. An older PC sends none: its blocked terminal agents are read from the phone's
 * agent list instead, and its flow approvals stay on the flow.
 *
 * `terminalAgents` are the user-facing activities (orchestration workers left out, as the host does).
 */
export function feedWaiting(
  daemon: DaemonSnapshot | null,
  terminalAgents: readonly AgentActivity[],
  /** Flows read so far, by project: a flow approval then names its flow, with the stage below. */
  workflows?: ReadonlyMap<string, Pick<WorkflowSnapshot, 'subprojects'>>,
): FeedWaitingItem[] {
  if (!daemon && terminalAgents.length === 0) return [];
  const names = projectNames(daemon);
  const sessionProject = new Map((daemon?.sessions ?? []).map((session) => [session.id, session.projectId]));
  const conversations = waitingItems(daemon).map((item): FeedWaitingItem => {
    const projectId = sessionProject.get(item.sessionId);
    const kind: FeedWaitingKind = item.kind === 'question' ? 'question' : item.kind === 'plan' ? 'plan' : 'approval';
    return {
      key: `approval:${item.approvalId}`, kind, at: item.at, title: item.title, detail: item.detail,
      ...(projectId ? { projectId, ...(names.has(projectId) ? { projectName: names.get(projectId)! } : {}) } : {}),
      providerId: item.providerId, requestKind: item.kind, sessionId: item.sessionId, approvalId: item.approvalId,
      ...(CARD_DECIDES.has(item.kind) ? { decide: { target: 'conversation' as const, approvalId: item.approvalId } } : {}),
    };
  });
  const activities = new Map(terminalAgents.map((activity) => [activity.id, activity]));
  const attention = daemon?.attention;
  const others: FeedWaitingItem[] = attention
    ? attention.items.flatMap((item): FeedWaitingItem[] => {
      const project = item.projectId ? { projectId: item.projectId, ...(names.has(item.projectId) ? { projectName: names.get(item.projectId)! } : {}) } : {};
      if (item.kind === 'flow-approval' && item.subprojectId && item.nodeId) {
        const flowTitle = item.projectId ? workflows?.get(item.projectId)?.subprojects.find((subproject) => subproject.id === item.subprojectId)?.title : undefined;
        return [{ key: `flow:${item.id}`, kind: 'flow-approval', at: item.since, title: flowTitle ?? item.title, detail: flowTitle ? item.title : '', ...project,
          flow: { subprojectId: item.subprojectId, nodeId: item.nodeId, ...(item.runId ? { runId: item.runId } : {}) } }];
      }
      if (item.kind === 'terminal-agent' && item.activityId) {
        const activity = activities.get(item.activityId);
        const decide = terminalDecision(activity);
        return [{ key: `terminal:${item.id}`, kind: 'terminal-agent', at: item.since, title: item.title, detail: terminalDetail(activity),
          ...project, activityId: item.activityId, ...(decide ? { decide } : {}) }];
      }
      return [];
    })
    : terminalAgents.filter((activity) => activity.state === 'blocked').map((activity): FeedWaitingItem => {
      const decide = terminalDecision(activity);
      return {
        key: `terminal:${activity.id}:${String(activity.stateSeq)}`, kind: 'terminal-agent', at: new Date(activity.updatedAt).toISOString(),
        title: activity.providerLabel ?? activity.provider, detail: terminalDetail(activity),
        ...(activity.projectId ? { projectId: activity.projectId, ...(names.has(activity.projectId) ? { projectName: names.get(activity.projectId)! } : {}) } : {}),
        activityId: activity.id, ...(decide ? { decide } : {}),
      };
    });
  return [...conversations, ...others].sort((left, right) => right.at.localeCompare(left.at) || left.key.localeCompare(right.key));
}

/** The badge counts exactly the feed's waiting cards. */
export function feedBadgeCount(daemon: DaemonSnapshot | null, terminalAgents: readonly AgentActivity[]): number {
  // The count does not depend on flow titles.
  return feedWaiting(daemon, terminalAgents).length;
}

/** Conversations that are a flow stage's: they report through their flow (as on the desktop board). */
export function stageSessionIds(workflows: Iterable<Pick<WorkflowSnapshot, 'sessionLinks'>>): Set<string> {
  const ids = new Set<string>();
  for (const workflow of workflows) {
    for (const link of workflow.sessionLinks) if (link.scope === 'stage') ids.add(link.sessionId);
  }
  return ids;
}

/**
 * The scope's conversations, newest first: app conversations only (the phone lists `structured` sessions), flow
 * stages and the ones already shown as waiting left out. `total` counts every listed one; `items` stops at `limit`
 * (the rest is behind 모두 보기).
 */
export function feedConversations(daemon: DaemonSnapshot | null, scope: FeedScope, options: {
  readonly stageSessions?: ReadonlySet<string>;
  readonly waitingSessions?: ReadonlySet<string>;
  readonly limit?: number;
} = {}): { readonly items: FeedConversation[]; readonly total: number } {
  if (!daemon) return { items: [], total: 0 };
  const exclude = new Set(options.stageSessions ?? []);
  for (const session of daemon.sessions) if (session.kind === 'agent' && session.source !== 'structured') exclude.add(session.id);
  const projects = feedProjects(daemon).filter((project) => scope === null || project.id === scope);
  const all = projects
    .flatMap((project) => projectConversations(daemon, project.id, { exclude })
      .map((item): FeedConversation => ({ ...item, projectId: project.id, projectName: project.name })))
    .filter((item) => !options.waitingSessions?.has(item.sessionId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { items: options.limit === undefined ? all : all.slice(0, options.limit), total: all.length };
}

const GOING = new Set<LiveFlow['phase']>(['prepared', 'running', 'awaiting-approval', 'paused', 'attention']);
const LAMP_ORDER: Record<Lamp, number> = { amber: 0, red: 1, on: 2, ok: 3, idle: 4 };

/**
 * The scope's flows. One project: all its live subprojects, as on the board. Every project: only the flows with a
 * run going (an idle flow of another project is noise on a phone). Waiting first, then failed, then working.
 */
export function feedFlows(workflows: ReadonlyMap<string, Pick<WorkflowSnapshot, 'subprojects' | 'runs'>>, scope: FeedScope, projects: readonly FeedProject[]): FeedFlow[] {
  return projects
    .filter((project) => scope === null || project.id === scope)
    .flatMap((project) => projectFlows(workflows.get(project.id) ?? null)
      .filter((flow) => scope !== null || GOING.has(flow.phase))
      .map((flow): FeedFlow => ({ ...flow, projectId: project.id, projectName: project.name })))
    .sort((left, right) => LAMP_ORDER[left.lamp] - LAMP_ORDER[right.lamp] || left.title.localeCompare(right.title));
}

/**
 * Which projects' flows to read: the chosen one; for every project, the ones with a flow approval waiting, then
 * the projects of the newest conversations, then the rest — at most `limit`, read one after another.
 */
export function flowReadProjects(scope: FeedScope, projects: readonly FeedProject[], waiting: readonly FeedWaitingItem[], conversations: readonly FeedConversation[], limit = 6): string[] {
  if (scope !== null) return projects.some((project) => project.id === scope) ? [scope] : [];
  const known = new Set(projects.map((project) => project.id));
  const order = [
    ...waiting.filter((item) => item.kind === 'flow-approval').map((item) => item.projectId),
    ...conversations.map((item) => item.projectId),
    ...projects.map((project) => project.id),
  ].filter((id): id is string => id !== undefined && known.has(id));
  return [...new Set(order)].slice(0, limit);
}

/**
 * The plan limits shown on the ask bar: the provider of the newest conversation, else the first ready one.
 * No context figure: a new conversation has none yet.
 */
export function askBarUsage(daemon: DaemonSnapshot | null, conversations: readonly FeedConversation[]): { readonly providerId: string; readonly usage: AgentUsage } | null {
  const usage = daemon?.providerUsage;
  if (!usage) return null;
  const candidates = [conversations[0]?.providerId, ...(daemon.providers ?? []).filter((provider) => provider.enabled && provider.health === 'ready').map((provider) => provider.id)];
  for (const providerId of candidates) {
    const entry = providerId ? usage[providerId] : undefined;
    if (providerId && entry && (entry.fiveHour || entry.weekly)) return { providerId, usage: entry };
  }
  return null;
}
