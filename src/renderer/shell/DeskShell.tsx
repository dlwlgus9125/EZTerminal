import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import type { AgentProjectSummary } from '../../shared/agent-history';
import type { GitDirectoryStatus } from '../../shared/git-status';
import { createDaemonCommand, type DaemonSnapshot } from '../../shared/daemon-protocol';
import type { WorkflowSnapshot } from '../../shared/workflow';
import { ConversationStartPanel } from '../ConversationStartPanel';
import { useConversationStartWiring } from '../conversation-start-wiring';
import type { LedTone } from '../ui';
import { LiveList, type ShellTerminal, type ShellTool } from './LiveList';
import { ProjectBoard } from './ProjectBoard';
import { ShellTopBar } from './ShellTopBar';
import { projectTabs, type ShellNavigation } from './navigation-store';
import { flattenConversations, otherProjects, projectConversations, projectFlows, waitingItems, type WaitingItem } from './shell-model';
import { useShellText } from './shell-text';
import './shell.css';

const START_ROUNDS_KEY = 'ezterminal.board-start-rounds';

function readStartRounds(): Record<string, number> {
  try {
    const value = JSON.parse(window.localStorage.getItem(START_ROUNDS_KEY) ?? '{}') as unknown;
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => Number.isInteger(entry[1])));
  } catch { return {}; }
}

function writeStartRounds(rounds: Readonly<Record<string, number>>): void {
  try { window.localStorage.setItem(START_ROUNDS_KEY, JSON.stringify(rounds)); } catch { /* not kept: the bar may reuse a sent draft's identity after restart */ }
}

/** A terminal tab in the main window; `projectId` when it was opened for a project. */
export interface DeskTerminal extends ShellTerminal {
  readonly projectId?: string;
}

export interface DeskShellActions {
  readonly openConversation: (sessionId: string, title: string | undefined, options: { readonly preview: boolean }) => void;
  readonly newConversation: (project: { readonly projectId: string; readonly name: string } | undefined) => void;
  readonly openHistory: (projectId: string | undefined) => void;
  readonly openFlow: (project: { readonly projectId: string; readonly name: string }, subprojectId?: string) => void;
  readonly openTerminal: (panelId: string) => void;
  readonly newTerminal: (project: { readonly projectId: string; readonly name: string } | undefined) => void;
  readonly openTool: (id: string) => void;
  /** 받은 요청: everything that asked for the person, including finished turns and terminal agents. */
  readonly openInbox: () => void;
  readonly openProjects: () => void;
  readonly openProjectFiles: (projectId: string) => void;
  readonly newWorktree: (projectId: string) => void;
  readonly editProject: (projectId: string) => void;
  readonly openFind: () => void;
  readonly openRemote: () => void;
  readonly openSettings: () => void;
}

export interface DeskShellProps {
  readonly navigation: ShellNavigation;
  readonly appVersion: string | null;
  /** Whether a navigation state was stored before this start (decides the first screen). */
  readonly restored: boolean;
  readonly snapshot: DaemonSnapshot | null;
  readonly terminals: readonly DeskTerminal[];
  /** The session (conversation) or panel (terminal) of the dock's active tab. */
  readonly focus: string | null;
  readonly host: { readonly label: string; readonly tone: LedTone };
  readonly updateAvailable: boolean;
  readonly activeTool: string | null;
  readonly openclawVisible: boolean;
  /** Changes when the project registry may have changed; -1 while the project screen is open. */
  readonly projectsRevision: number;
  /** Below 1200px the live list folds into a strip. */
  readonly folded: boolean;
  /** Terminal CLI agents waiting on the person; listed in 받은 요청, counted in the top bar. */
  readonly externalWaiting: number;
  readonly layoutMenu?: ReactNode;
  readonly windowControls?: ReactNode;
  readonly actions: DeskShellActions;
}

function useAgentProjects(snapshot: DaemonSnapshot | null, revision: number): readonly AgentProjectSummary[] | null {
  const [projects, setProjects] = useState<readonly AgentProjectSummary[] | null>(null);
  // Added, edited or removed projects reach the daemon's list; pins and recency live only in the
  // registry, so it is read again after the project screen closes (revision) and once a minute.
  const key = useMemo(() => (snapshot?.projects ?? []).map((project) => `${project.id}:${project.updatedAt}:${project.archivedAt ?? ''}`).join('|'), [snapshot]);
  useEffect(() => {
    if (revision < 0) return undefined;
    let alive = true;
    const read = (): void => {
      void window.ezterminal.listAgentProjects(false, undefined, 100)
        .then((page) => { if (alive) setProjects(page.items.filter((project) => project.saved)); })
        .catch(() => { if (alive) setProjects((current) => current ?? []); });
    };
    read();
    const timer = window.setInterval(read, 60_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [key, revision]);
  return projects;
}

/** git status of the project folder while the board shows it (the changes lane and the branch). */
function useGitChanges(root: string | null, visible: boolean): GitDirectoryStatus | null {
  const [status, setStatus] = useState<{ readonly root: string; readonly value: GitDirectoryStatus } | null>(null);
  useEffect(() => {
    if (!root || !visible || typeof window.ezterminal.getGitStatus !== 'function') return undefined;
    let alive = true;
    const read = (): void => {
      void window.ezterminal.getGitStatus(root).then((value) => { if (alive) setStatus({ root, value }); }).catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, 15_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [root, visible]);
  return status?.root === root ? status.value : null;
}

function useWorkflow(projectId: string | null, revision: number | undefined): WorkflowSnapshot | null {
  const [workflow, setWorkflow] = useState<{ readonly projectId: string; readonly snapshot: WorkflowSnapshot } | null>(null);
  const readRef = useRef<() => void>(() => undefined);
  // A response is dropped only when the project changed meanwhile; newer revisions just read again.
  useEffect(() => {
    if (!projectId || typeof window.ezterminal.getWorkflowSnapshot !== 'function') { readRef.current = () => undefined; return undefined; }
    let alive = true;
    const read = (): void => {
      void window.ezterminal.getWorkflowSnapshot(projectId).then((result) => {
        if (alive && result.ok) setWorkflow({ projectId, snapshot: result.snapshot });
      }).catch(() => undefined);
    };
    readRef.current = read;
    read();
    // A run moves through its stages without changing the daemon revision every time: read again now and then.
    const timer = window.setInterval(read, 10_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [projectId]);
  useEffect(() => {
    if (revision === undefined) return undefined;
    const timer = window.setTimeout(() => readRef.current(), 300);
    return () => window.clearTimeout(timer);
  }, [revision]);
  return workflow?.projectId === projectId ? workflow.snapshot : null;
}

/**
 * The Board + Desk shell around the dock (approved 2026-10-24): the top bar,
 * work mode's live list and the project board, fed by the host's daemon and
 * workflow snapshots. App owns the dock; this owns what is around it.
 */
export function useDeskShell(props: DeskShellProps): { readonly top: JSX.Element; readonly list: JSX.Element | null; readonly board: JSX.Element | null } {
  const { navigation, snapshot, actions } = props;
  const nav = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot);
  const { text } = useShellText();
  const projects = useAgentProjects(snapshot, props.projectsRevision);
  // Projects the host knows but the registry list does not (unsaved, or past its first page) still have a board.
  const known = useMemo<readonly AgentProjectSummary[] | null>(() => {
    if (projects === null) return null;
    const listed = new Set(projects.map((project) => project.projectId));
    const extra = (snapshot?.projects ?? []).filter((project) => !project.archivedAt && !listed.has(project.id)).map((project): AgentProjectSummary => ({
      projectId: project.id, name: project.name, primaryRoot: project.rootPath ?? '', additionalRoots: [], pinned: false, saved: false,
      sessionCount: 0, providers: [], lastActiveAt: Date.parse(project.updatedAt) || null,
    }));
    return [...projects, ...extra];
  }, [projects, snapshot]);

  // First start without a stored place: a person with projects lands on a board, one without on the terminal.
  const settled = useRef(props.restored);
  useEffect(() => {
    if (settled.current || projects === null) return;
    settled.current = true;
    const first = projectTabs(projects.map((project) => ({ ...project, lastActiveAt: project.lastActiveAt ?? undefined })), null, 1)[0];
    if (first) navigation.showBoard(first.projectId);
    else navigation.showWork();
  }, [navigation, projects]);

  // A selected project that no longer exists falls back to the first one.
  useEffect(() => {
    if (!projects || !known || projects.length === 0) return;
    if (!nav.projectId || !known.some((project) => project.projectId === nav.projectId)) {
      const first = projectTabs(projects.map((project) => ({ ...project, lastActiveAt: project.lastActiveAt ?? undefined })), null, 1)[0];
      if (first) navigation.followPanel(first.projectId);
    }
  }, [navigation, nav.projectId, projects, known]);

  const project = known?.find((candidate) => candidate.projectId === nav.projectId) ?? null;
  const projectId = project?.projectId ?? null;
  const projectRef = project ? { projectId: project.projectId, name: project.name } : undefined;
  const workflow = useWorkflow(projectId, snapshot?.revision);
  const git = useGitChanges(project?.primaryRoot ?? null, nav.mode === 'board');
  const changes = useMemo(() => (git && projectId ? {
    ...(git.branch ? { branch: git.branch } : {}),
    files: git.changes.length,
    added: git.changes.reduce((sum, change) => sum + (change.added ?? 0), 0),
    removed: git.changes.reduce((sum, change) => sum + (change.removed ?? 0), 0),
    worktrees: (snapshot?.workspaces ?? []).filter((workspace) => workspace.projectId === projectId && workspace.kind === 'worktree' && !workspace.archivedAt).length,
    availability: git.availability,
    truncated: git.truncated,
  } : null), [git, projectId, snapshot]);
  const stageSessions = useMemo(() => new Set((workflow?.sessionLinks ?? []).filter((link) => link.scope === 'stage').map((link) => link.sessionId)), [workflow]);
  const conversations = useMemo(() => (projectId ? projectConversations(snapshot, projectId, { exclude: stageSessions }) : []), [snapshot, projectId, stageSessions]);
  const allWaiting = useMemo(() => waitingItems(snapshot), [snapshot]);
  const waiting = useMemo(() => (projectId ? waitingItems(snapshot, projectId) : allWaiting), [snapshot, projectId, allWaiting]);
  const flows = useMemo(() => projectFlows(workflow), [workflow]);
  const others = useMemo(() => otherProjects(snapshot, projectId), [snapshot, projectId]);
  const terminals = useMemo(() => props.terminals.filter((terminal) => !terminal.projectId || terminal.projectId === projectId), [props.terminals, projectId]);

  const sessionProject = useCallback((sessionId: string): string | undefined => snapshot?.sessions.find((session) => session.id === sessionId)?.projectId, [snapshot]);
  const waitingByProject = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of allWaiting) {
      const owner = sessionProject(item.sessionId);
      if (owner) counts[owner] = (counts[owner] ?? 0) + 1;
    }
    return counts;
  }, [allWaiting, sessionProject]);
  const stoppedProjects = useMemo(() => new Set((snapshot?.projects ?? [])
    .filter((candidate) => flattenConversations(projectConversations(snapshot, candidate.id)).some((item) => item.state === 'failed'))
    .map((candidate) => candidate.id)), [snapshot]);

  // Saved projects make the tabs; a project chosen from elsewhere (other projects, the project screen) joins them.
  const tabs = useMemo(() => {
    const candidates = [...(projects ?? []), ...(project && !projects?.some((candidate) => candidate.projectId === project.projectId) ? [project] : [])];
    return projectTabs(candidates.map((candidate) => ({ ...candidate, lastActiveAt: candidate.lastActiveAt ?? undefined })), projectId);
  }, [projects, project, projectId]);

  const openConversation = useCallback((sessionId: string, preview = true): void => {
    const title = snapshot?.sessions.find((session) => session.id === sessionId)?.title;
    // The opening helper decides visibility (a tab living in a popout leaves the board alone).
    actions.openConversation(sessionId, title, { preview });
  }, [actions, snapshot]);

  const decide = useCallback(async (item: WaitingItem, decision: 'allow' | 'deny'): Promise<{ readonly ok: boolean; readonly message?: string }> => {
    try {
      const authority = await window.ezterminal.getDaemonSnapshot();
      if (!authority) return { ok: false, message: text('에이전트 호스트에 연결할 수 없습니다.', 'The Agent host is unavailable.') };
      const commandId = `command-${crypto.randomUUID()}`;
      const receipt = await window.ezterminal.sendDaemonCommand(createDaemonCommand({
        commandId, idempotencyKey: commandId, expectedRevision: authority.revision, issuedAt: new Date().toISOString(),
        principal: { kind: 'desktop', id: 'renderer-agent-ui' }, type: 'permission.resolve', payload: { approvalId: item.approvalId, decision },
      }));
      return receipt.ok ? { ok: true } : { ok: false, message: receipt.error.message };
    } catch (reason) {
      return { ok: false, message: String(reason) };
    }
  }, [text]);

  const tools = useMemo<ShellTool[]>(() => [
    { id: 'explorer', label: text('파일', 'Files'), glyph: 'file', testId: 'btn-toggle-files' },
    { id: 'monitor', label: text('모니터', 'Monitor'), glyph: 'mon', testId: 'btn-toggle-stats' },
    ...(props.openclawVisible ? [{ id: 'openclaw', label: 'OpenClaw', glyph: 'claw' as const, testId: 'btn-toggle-openclaw' }] : []),
    { id: 'remote', label: text('원격 · 폰', 'Remote · phone'), glyph: 'phone', testId: 'rail-remote' },
    { id: 'settings', label: text('설정', 'Settings'), glyph: 'set', testId: 'shell-tool-settings' },
  ], [props.openclawVisible, text]);

  const wiring = useConversationStartWiring(snapshot, projectId ?? undefined);
  const [startRounds, setStartRounds] = useState<Readonly<Record<string, number>>>(readStartRounds);
  const startRound = projectId ? startRounds[projectId] ?? 0 : 0;
  // Stable per project (a draft survives other projects and restarts); a started one is not reused.
  const startIdentity = `board-start-${projectId ?? 'none'}${startRound > 0 ? `-${startRound}` : ''}`;

  const top = (
    <ShellTopBar
      mode={nav.mode}
      appVersion={props.appVersion}
      projects={tabs}
      selectedProjectId={projectId}
      waitingByProject={waitingByProject}
      stoppedProjects={stoppedProjects}
      waitingTotal={allWaiting.length + props.externalWaiting}
      host={props.host}
      updateAvailable={props.updateAvailable}
      settingsActive={props.activeTool === 'settings'}
      onSelectProject={(id) => navigation.showBoard(id)}
      onAddProject={actions.openProjects}
      onWaits={() => { const first = waiting[0] ?? allWaiting[0]; if (first) openConversation(first.sessionId); else actions.openInbox(); }}
      onFind={actions.openFind}
      onHost={actions.openRemote}
      onSettings={actions.openSettings}
      {...(nav.mode === 'work' && props.layoutMenu ? { layoutMenu: props.layoutMenu } : {})}
      {...(props.windowControls ? { windowControls: props.windowControls } : {})}
    />
  );

  const list = nav.mode === 'work' ? (
    <LiveList
      folded={props.folded}
      projectName={project?.name ?? null}
      conversations={conversations}
      waiting={waiting}
      flows={flows}
      terminals={terminals}
      focus={props.focus}
      others={others}
      tools={tools}
      activeTool={props.activeTool}
      onBoard={() => navigation.showBoard()}
      onOpenConversation={(sessionId) => openConversation(sessionId)}
      onNewConversation={() => { actions.newConversation(projectRef); navigation.showWork(); }}
      onOpenWaiting={(item) => openConversation(item.sessionId)}
      onInbox={actions.openInbox}
      onOpenFlow={(subprojectId) => { if (projectRef) actions.openFlow(projectRef, subprojectId); }}
      onOpenTerminal={(panelId) => actions.openTerminal(panelId)}
      onNewTerminal={() => actions.newTerminal(projectRef)}
      onAllConversations={() => actions.openHistory(projectId ?? undefined)}
      onOtherProject={(id) => navigation.showBoard(id)}
      onTool={actions.openTool}
    />
  ) : null;

  const board = nav.mode === 'board' ? (
    <div className="ez-shell-board-layer" data-testid="shell-board-layer" tabIndex={-1}>
      <ProjectBoard
        project={project ? { name: project.name, path: project.primaryRoot } : null}
        flows={flows}
        conversations={conversations}
        terminals={terminals}
        waiting={waiting}
        others={others}
        changes={changes}
        startBar={project ? (
          <ConversationStartPanel
            key={startIdentity}
            identity={startIdentity}
            projectId={project.projectId}
            snapshot={snapshot}
            access={wiring.access}
            storage={wiring.storage}
            capabilityClient={wiring.capabilityClient}
            {...(wiring.workspaceFolders ? { workspaceFolders: wiring.workspaceFolders } : {})}
            onEditProject={actions.editProject}
            onOpenHistory={() => actions.openHistory(project.projectId)}
            onStarted={(sessionId) => {
              // A conversation started here is kept, not a preview; this project's bar starts over.
              setStartRounds((current) => {
                const next = { ...current, [project.projectId]: (current[project.projectId] ?? 0) + 1 };
                writeStartRounds(next);
                return next;
              });
              openConversation(sessionId, false);
            }}
          />
        ) : undefined}
        onOpenConversation={(sessionId) => openConversation(sessionId)}
        onOpenFlow={(subprojectId) => { if (projectRef) { actions.openFlow(projectRef, subprojectId); navigation.showWork(); } }}
        onNewFlow={() => { if (projectRef) { actions.openFlow(projectRef); navigation.showWork(); } }}
        onOpenTerminal={(panelId) => { actions.openTerminal(panelId); navigation.showWork(); }}
        onNewTerminal={() => { actions.newTerminal(projectRef); navigation.showWork(); }}
        onDecide={decide}
        onOtherProject={(id) => navigation.showBoard(id)}
        onFiles={() => { if (projectId) actions.openProjectFiles(projectId); }}
        onProjectSettings={() => { if (projectId) actions.editProject(projectId); }}
        onWorktree={() => { if (projectId) actions.newWorktree(projectId); }}
        onAddProject={actions.openProjects}
      />
    </div>
  ) : null;

  return { top, list, board };
}
