import type { DaemonSnapshot } from '../../shared/daemon-protocol';
import type { ConversationViews } from '../conversation-views';

/**
 * Where a terminal's AI input sends: which project the terminal belongs to,
 * and which conversation is "the last one I was in" there. Pure, so the
 * terminal, its menu and their tests read one rule.
 */

const SYNTHETIC_PROJECT = 'legacy-project-';

export interface TerminalProjectInputs {
  /** `projectSession.projectId` of the tab (native projects open this way). */
  readonly tabProjectId?: string;
  /** The terminal's daemon session id (`PaneSnapshot.sessionId`). */
  readonly paneSessionId?: string | null;
  /** The terminal's current folder. */
  readonly cwd?: string | null;
}

function liveProject(snapshot: DaemonSnapshot, projectId: string | undefined): string | undefined {
  if (!projectId || projectId.startsWith(SYNTHETIC_PROJECT)) return undefined;
  return snapshot.projects.some((project) => project.id === projectId && !project.archivedAt) ? projectId : undefined;
}

function pathKey(value: string): string {
  return value.trim().replace(/\//gu, '\\').replace(/\\+$/u, '').toLocaleLowerCase('en-US');
}

function inside(child: string, root: string): boolean {
  return child === root || child.startsWith(`${root}\\`);
}

/**
 * The terminal's project: the tab's own project, else the project its daemon
 * session was registered under (not a per-folder stand-in), else the project
 * whose folder holds the current folder (the deepest one), else none.
 */
export function resolveTerminalProjectId(inputs: TerminalProjectInputs, snapshot: DaemonSnapshot | null): string | undefined {
  if (!snapshot) return undefined;
  const fromTab = liveProject(snapshot, inputs.tabProjectId);
  if (fromTab) return fromTab;
  const session = inputs.paneSessionId
    ? snapshot.sessions.find((candidate) => candidate.id === inputs.paneSessionId && candidate.kind === 'terminal')
    : undefined;
  const fromSession = liveProject(snapshot, session?.projectId);
  if (fromSession) return fromSession;
  if (!inputs.cwd) return undefined;
  const cwd = pathKey(inputs.cwd);
  let best: { readonly projectId: string; readonly length: number } | undefined;
  const consider = (projectId: string, rootPath: string | undefined): void => {
    if (!rootPath || !liveProject(snapshot, projectId)) return;
    const root = pathKey(rootPath);
    if (root && inside(cwd, root) && (!best || root.length > best.length)) best = { projectId, length: root.length };
  };
  for (const project of snapshot.projects) consider(project.id, project.rootPath);
  for (const workspace of snapshot.workspaces) if (!workspace.archivedAt) consider(workspace.projectId, workspace.rootPath);
  return best?.projectId;
}

export interface TerminalTargetCandidate {
  readonly sessionId: string;
  readonly title: string;
  readonly providerId: string;
  readonly projectId: string;
  /** When this person last looked at it here, if ever. */
  readonly viewedAt?: string;
  readonly updatedAt: string;
}

/** Conversations a terminal can send to: live top-level app conversations (not flow stages or subagents). */
export function terminalTargetCandidates(
  snapshot: DaemonSnapshot | null,
  views: ConversationViews,
  projectId?: string,
): TerminalTargetCandidate[] {
  if (!snapshot) return [];
  const agents = new Map(snapshot.agents.map((agent) => [agent.sessionId, agent]));
  const children = new Set(snapshot.agentRelations
    .filter((relation) => relation.detachedAt === undefined)
    .map((relation) => relation.childSessionId));
  return snapshot.sessions
    .filter((session) => session.kind === 'agent' && !session.archivedAt && !session.id.startsWith('planning-')
      && !children.has(session.id) && (projectId === undefined || session.projectId === projectId))
    .flatMap((session) => {
      const agent = agents.get(session.id);
      if (!agent || agent.state === 'archived') return [];
      const viewedAt = views[session.id];
      return [{
        sessionId: session.id, title: session.title, providerId: agent.providerId, projectId: session.projectId,
        ...(viewedAt ? { viewedAt } : {}),
        updatedAt: [session.updatedAt, agent.updatedAt].sort().at(-1)!,
      }];
    })
    .sort((left, right) => (right.viewedAt ?? '').localeCompare(left.viewedAt ?? '')
      || right.updatedAt.localeCompare(left.updatedAt));
}

export type TerminalTarget =
  | { readonly kind: 'conversation'; readonly sessionId: string; readonly title: string; readonly providerId: string }
  | { readonly kind: 'new'; readonly projectId?: string };

/**
 * The conversation a person picked for this terminal while it is still live;
 * else the one last looked at in the terminal's project (any project for a
 * terminal without one); else a new conversation in the terminal's project.
 */
export function resolveTerminalTarget(input: {
  readonly snapshot: DaemonSnapshot | null;
  readonly views: ConversationViews;
  readonly projectId?: string;
  readonly pickedSessionId?: string;
}): TerminalTarget {
  const all = terminalTargetCandidates(input.snapshot, input.views);
  const picked = input.pickedSessionId ? all.find((candidate) => candidate.sessionId === input.pickedSessionId) : undefined;
  const scoped = input.projectId === undefined ? all : all.filter((candidate) => candidate.projectId === input.projectId);
  const chosen = picked ?? scoped.find((candidate) => candidate.viewedAt !== undefined);
  if (chosen) return { kind: 'conversation', sessionId: chosen.sessionId, title: chosen.title, providerId: chosen.providerId };
  return input.projectId === undefined ? { kind: 'new' } : { kind: 'new', projectId: input.projectId };
}
