import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import type { AgentProjectSummary } from '../../shared/agent-history';
import { createDaemonCommand, type DaemonSnapshot } from '../../shared/daemon-protocol';
import type { WorkflowSnapshot } from '../../shared/workflow';
import { ConversationStartPanel } from '../ConversationStartPanel';
import { useConversationStartWiring } from '../conversation-start-wiring';
import type { LedTone } from '../ui';
import { LiveList, type ShellTerminal, type ShellTool } from './LiveList';
import { ProjectBoard } from './ProjectBoard';
import { ShellTopBar } from './ShellTopBar';
import { projectTabs, type ShellNavigation } from './navigation-store';
import { otherProjects, projectConversations, projectFlows, waitingItems, type WaitingItem } from './shell-model';
import { useShellText } from './shell-text';
import './shell.css';

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
  /** Terminal CLI agents waiting on the person; listed in 받은 요청, counted in the top bar. */
  readonly externalWaiting: number;
  readonly layoutMenu?: ReactNode;
  readonly windowControls?: ReactNode;
  readonly actions: DeskShellActions;
}

function useAgentProjects(snapshot: DaemonSnapshot | null): readonly AgentProjectSummary[] | null {
  const [projects, setProjects] = useState<readonly AgentProjectSummary[] | null>(null);
  // The registry changes when a project is added, edited or removed; the daemon's project list follows it.
  const key = useMemo(() => (snapshot?.projects ?? []).map((project) => `${project.id}:${project.updatedAt}:${project.archivedAt ?? ''}`).join('|'), [snapshot]);
  useEffect(() => {
    let alive = true;
    void window.ezterminal.listAgentProjects(false, undefined, 100)
      .then((page) => { if (alive) setProjects(page.items.filter((project) => project.saved)); })
      .catch(() => { if (alive) setProjects((current) => current ?? []); });
    return () => { alive = false; };
  }, [key]);
  return projects;
}

function useWorkflow(projectId: string | null, revision: number | undefined): WorkflowSnapshot | null {
  const [workflow, setWorkflow] = useState<{ readonly projectId: string; readonly snapshot: WorkflowSnapshot } | null>(null);
  const last = useRef(0);
  useEffect(() => {
    if (!projectId || typeof window.ezterminal.getWorkflowSnapshot !== 'function') return undefined;
    let alive = true;
    const read = (): void => {
      last.current = Date.now();
      void window.ezterminal.getWorkflowSnapshot(projectId).then((result) => {
        if (alive && result.ok) setWorkflow({ projectId, snapshot: result.snapshot });
      }).catch(() => undefined);
    };
    // A run moves through its stages without changing the daemon revision every time: read again now and then.
    if (Date.now() - last.current > 400) read();
    const timer = window.setInterval(read, 10_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [projectId, revision]);
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
  const projects = useAgentProjects(snapshot);

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
    if (!projects || projects.length === 0) return;
    if (!nav.projectId || !projects.some((project) => project.projectId === nav.projectId)) {
      const first = projectTabs(projects.map((project) => ({ ...project, lastActiveAt: project.lastActiveAt ?? undefined })), null, 1)[0];
      if (first) navigation.followPanel(first.projectId);
    }
  }, [navigation, nav.projectId, projects]);

  const project = projects?.find((candidate) => candidate.projectId === nav.projectId) ?? null;
  const projectId = project?.projectId ?? null;
  const projectRef = project ? { projectId: project.projectId, name: project.name } : undefined;
  const workflow = useWorkflow(projectId, snapshot?.revision);
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
    .filter((candidate) => projectConversations(snapshot, candidate.id).some((item) => item.state === 'failed'))
    .map((candidate) => candidate.id)), [snapshot]);

  const tabs = useMemo(() => projectTabs((projects ?? []).map((candidate) => ({ ...candidate, lastActiveAt: candidate.lastActiveAt ?? undefined })), projectId), [projects, projectId]);

  const openConversation = useCallback((sessionId: string, preview = true): void => {
    const title = snapshot?.sessions.find((session) => session.id === sessionId)?.title;
    actions.openConversation(sessionId, title, { preview });
    navigation.showWork(sessionProject(sessionId) ?? null);
  }, [actions, navigation, sessionProject, snapshot]);

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
    { id: 'explorer', label: text('파일', 'Files'), glyph: 'file' },
    { id: 'monitor', label: text('모니터', 'Monitor'), glyph: 'mon' },
    ...(props.openclawVisible ? [{ id: 'openclaw', label: 'OpenClaw', glyph: 'claw' as const }] : []),
    { id: 'remote', label: text('원격 · 폰', 'Remote · phone'), glyph: 'phone' },
    { id: 'settings', label: text('설정', 'Settings'), glyph: 'set' },
  ], [props.openclawVisible, text]);

  const wiring = useConversationStartWiring(snapshot, projectId ?? undefined);
  const [startRound, setStartRound] = useState(0);
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
              // A conversation started here is kept, not a preview.
              setStartRound((round) => round + 1);
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
        onAddProject={actions.openProjects}
      />
    </div>
  ) : null;

  return { top, list, board };
}
