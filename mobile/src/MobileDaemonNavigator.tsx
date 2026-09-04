import {
  Archive,
  Bot,
  ChevronLeft,
  ChevronRight,
  FileDiff,
  Folder,
  GitBranch,
  Globe,
  Play,
  RefreshCw,
  Server,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { formatCwd } from '../../src/renderer/format-cwd';
import { useAppTranslation } from '../../src/renderer/i18n';
import { DaemonSafeModeNotice } from '../../src/renderer/DaemonSafeModeNotice';
import type {
  DaemonSession,
  DaemonSnapshot,
  SessionKind,
} from '../../src/shared/daemon-protocol';
import {
  isDaemonSessionArchived,
  isStructuredDaemonAgentSession,
} from '../../src/shared/daemon-session-visibility';
import type { DaemonRuntimeViewState } from './transport/ws-ezterminal';

interface NavigatorCopy {
  readonly title: string;
  readonly projects: string;
  readonly workspaces: string;
  readonly sessions: string;
  readonly archived: string;
  readonly archivedDescription: string;
  readonly loading: string;
  readonly reconnecting: string;
  readonly loadFailed: string;
  readonly invalidSnapshot: string;
  readonly gap: string;
  readonly retry: string;
  readonly noProjects: string;
  readonly noWorkspaces: string;
  readonly noSessions: string;
  readonly noArchivedProjects: string;
  readonly noArchivedWorkspaces: string;
  readonly noArchivedSessions: string;
  readonly local: string;
  readonly worktree: string;
  readonly revision: string;
  readonly backToProjects: string;
  readonly backToWorkspaces: string;
  readonly backToCurrent: string;
  readonly openSession: string;
}

const COPY: Readonly<Record<'en' | 'ko', NavigatorCopy>> = {
  en: {
    title: 'Projects',
    projects: 'Projects',
    workspaces: 'Workspaces',
    sessions: 'Sessions',
    archived: 'Archived',
    archivedDescription: 'Saved Agent history',
    loading: 'Loading projects from the desktop…',
    reconnecting: 'Reconnecting and checking the latest project state…',
    loadFailed: 'The desktop project state is unavailable.',
    invalidSnapshot: 'The desktop returned an invalid project snapshot.',
    gap: 'Some updates were missed. Reloading the authoritative state…',
    retry: 'Retry',
    noProjects: 'No projects yet. Create one on Desktop to get started.',
    noWorkspaces: 'This project has no active workspaces.',
    noSessions: 'This workspace has no active sessions.',
    noArchivedProjects: 'No archived Agent sessions.',
    noArchivedWorkspaces: 'This project has no archived Agent sessions.',
    noArchivedSessions: 'This workspace has no archived Agent sessions.',
    local: 'Local',
    worktree: 'Worktree',
    revision: 'Revision',
    backToProjects: 'Back to projects',
    backToWorkspaces: 'Back to workspaces',
    backToCurrent: 'Back to current sessions',
    openSession: 'Open session',
  },
  ko: {
    title: '프로젝트',
    projects: '프로젝트',
    workspaces: '워크스페이스',
    sessions: '세션',
    archived: '보관됨',
    archivedDescription: '저장된 Agent 기록',
    loading: '데스크톱에서 프로젝트를 불러오는 중…',
    reconnecting: '다시 연결하고 최신 프로젝트 상태를 확인하는 중…',
    loadFailed: '데스크톱 프로젝트 상태를 불러올 수 없습니다.',
    invalidSnapshot: '데스크톱이 올바르지 않은 프로젝트 스냅샷을 보냈습니다.',
    gap: '일부 업데이트를 놓쳤습니다. 기준 상태를 다시 불러오는 중…',
    retry: '다시 시도',
    noProjects: '아직 프로젝트가 없습니다. 데스크톱에서 프로젝트를 만들어 주세요.',
    noWorkspaces: '이 프로젝트에는 활성 워크스페이스가 없습니다.',
    noSessions: '이 워크스페이스에는 활성 세션이 없습니다.',
    noArchivedProjects: '보관된 Agent 세션이 없습니다.',
    noArchivedWorkspaces: '이 프로젝트에는 보관된 Agent 세션이 없습니다.',
    noArchivedSessions: '이 워크스페이스에는 보관된 Agent 세션이 없습니다.',
    local: '로컬',
    worktree: '워크트리',
    revision: '리비전',
    backToProjects: '프로젝트로 돌아가기',
    backToWorkspaces: '워크스페이스로 돌아가기',
    backToCurrent: '현재 세션으로 돌아가기',
    openSession: '세션 열기',
  },
};

const SESSION_ICON: Readonly<Record<SessionKind, LucideIcon>> = {
  agent: Bot,
  terminal: SquareTerminal,
  diff: FileDiff,
  browser: Globe,
  script: Play,
  service: Server,
};

const SESSION_LABEL: Readonly<Record<'en' | 'ko', Readonly<Record<SessionKind, string>>>> = {
  en: {
    agent: 'Agent',
    terminal: 'Terminal',
    diff: 'Review',
    browser: 'Browser',
    script: 'Script',
    service: 'Service',
  },
  ko: {
    agent: '에이전트',
    terminal: '터미널',
    diff: '리뷰',
    browser: '브라우저',
    script: '스크립트',
    service: '서비스',
  },
};

function currentProjects(snapshot: DaemonSnapshot) {
  return snapshot.projects.filter((project) => project.archivedAt === undefined);
}

function sessionMeta(
  session: DaemonSession,
  language: 'en' | 'ko',
  archivedLabel?: string,
): string {
  const source = session.source === 'legacy-pty'
    ? ' · Legacy PTY'
    : session.source === 'legacy-import'
      ? ' · Imported'
      : '';
  return `${SESSION_LABEL[language][session.kind]} · ${archivedLabel ?? session.state}${source}`;
}

export type MobileDaemonNavigatorVisibility = 'active' | 'archived';

export function MobileDaemonNavigator({
  state,
  onRetry,
  onSelectSession,
  visibility,
  onVisibilityChange,
}: {
  readonly state: DaemonRuntimeViewState;
  readonly onRetry: () => void;
  readonly onSelectSession: (sessionId: string) => void;
  readonly visibility?: MobileDaemonNavigatorVisibility;
  readonly onVisibilityChange?: (visibility: MobileDaemonNavigatorVisibility) => void;
}): JSX.Element {
  const { i18n } = useAppTranslation();
  const language: 'en' | 'ko' = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko')
    ? 'ko'
    : 'en';
  const copy = COPY[language];
  const [internalVisibility, setInternalVisibility] = useState<MobileDaemonNavigatorVisibility>('active');
  const resolvedVisibility = visibility ?? internalVisibility;
  const showArchived = resolvedVisibility === 'archived';
  const [projectId, setProjectId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const snapshot = state.snapshot;
  const agents = useMemo(
    () => new Map(snapshot?.agents.map((agent) => [agent.sessionId, agent]) ?? []),
    [snapshot],
  );
  const archivedSessions = useMemo(() => snapshot ? snapshot.sessions.filter((session) => (
    isStructuredDaemonAgentSession(session)
    && isDaemonSessionArchived(session, agents.get(session.id))
  )) : [], [agents, snapshot]);
  const archivedCount = archivedSessions.length;
  const projects = useMemo(() => {
    if (!snapshot) return [];
    if (!showArchived) return currentProjects(snapshot);
    const projectIds = new Set(archivedSessions.map((session) => session.projectId));
    return snapshot.projects.filter((project) => projectIds.has(project.id));
  }, [archivedSessions, showArchived, snapshot]);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const workspaces = useMemo(() => {
    if (!snapshot || !project) return [];
    if (!showArchived) {
      return snapshot.workspaces.filter((workspace) => (
        workspace.projectId === project.id && workspace.archivedAt === undefined
      ));
    }
    const workspaceIds = new Set(archivedSessions
      .filter((session) => session.projectId === project.id)
      .map((session) => session.workspaceId));
    return snapshot.workspaces.filter((workspace) => workspaceIds.has(workspace.id));
  }, [archivedSessions, project, showArchived, snapshot]);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const sessions = useMemo(() => {
    if (!snapshot || !workspace) return [];
    if (showArchived) {
      return archivedSessions.filter((session) => session.workspaceId === workspace.id);
    }
    return snapshot.sessions.filter((session) => (
      session.workspaceId === workspace.id
      && !isDaemonSessionArchived(session, agents.get(session.id))
    ));
  }, [agents, archivedSessions, showArchived, snapshot, workspace]);
  const rootLabel = showArchived ? copy.archived : copy.projects;

  const changeVisibility = (next: MobileDaemonNavigatorVisibility): void => {
    setInternalVisibility(next);
    onVisibilityChange?.(next);
    setProjectId(null);
    setWorkspaceId(null);
  };

  useEffect(() => {
    if (projectId !== null && !projects.some((candidate) => candidate.id === projectId)) {
      setProjectId(null);
      setWorkspaceId(null);
    }
  }, [projectId, projects]);

  useEffect(() => {
    if (workspaceId !== null && !workspaces.some((candidate) => candidate.id === workspaceId)) {
      setWorkspaceId(null);
    }
  }, [workspaceId, workspaces]);

  const statusMessage = state.status === 'loading'
    ? copy.loading
    : state.error === 'event-gap'
      ? copy.gap
      : state.status === 'recovering'
        ? copy.reconnecting
        : null;

  return (
    <section
      className="mob-daemon-nav"
      aria-label={rootLabel}
      data-testid="mobile-daemon-navigator"
      data-sync-status={state.status}
    >
      <header className="mob-daemon-nav__head">
        <div>
          <h2>{workspace ? copy.sessions : project ? copy.workspaces : rootLabel}</h2>
          {snapshot && (
            <small data-testid="mobile-daemon-revision">
              {copy.revision} {snapshot.revision}
            </small>
          )}
        </div>
        {workspace ? (
          <button
            type="button"
            className="mob-icon-btn"
            aria-label={copy.backToWorkspaces}
            onClick={() => setWorkspaceId(null)}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
        ) : project ? (
          <button
            type="button"
            className="mob-icon-btn"
            aria-label={copy.backToProjects}
            onClick={() => {
              setProjectId(null);
              setWorkspaceId(null);
            }}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
        ) : showArchived ? (
          <button
            type="button"
            className="mob-icon-btn"
            aria-label={copy.backToCurrent}
            onClick={() => changeVisibility('active')}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
        ) : null}
      </header>

      {(project || workspace) && (
        <nav className="mob-daemon-nav__crumbs" aria-label={`${rootLabel} / ${copy.workspaces} / ${copy.sessions}`}>
          <button
            type="button"
            onClick={() => {
              setProjectId(null);
              setWorkspaceId(null);
            }}
          >
            {rootLabel}
          </button>
          {project && (
            <>
              <ChevronRight aria-hidden="true" />
              <button type="button" onClick={() => setWorkspaceId(null)}>{project.name}</button>
            </>
          )}
          {workspace && (
            <>
              <ChevronRight aria-hidden="true" />
              <span aria-current="page">{workspace.name}</span>
            </>
          )}
        </nav>
      )}

      {statusMessage && (
        <p className="mob-daemon-nav__status" role="status" aria-live="polite">
          <RefreshCw aria-hidden="true" />
          {statusMessage}
        </p>
      )}

      {state.availability?.state === 'legacy-only-safe-mode' && (
        <DaemonSafeModeNotice availability={state.availability} compact />
      )}

      {state.status === 'error' && (
        <div className="mob-daemon-nav__error" role="alert">
          <p>{state.error === 'invalid-snapshot' ? copy.invalidSnapshot : copy.loadFailed}</p>
          <button type="button" className="mob-btn-ghost" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            {copy.retry}
          </button>
        </div>
      )}

      {snapshot && !workspace && !project && (
        projects.length === 0 && (showArchived || archivedCount === 0) ? (
          <p className="mob-empty" data-testid="mobile-daemon-empty-projects">
            {showArchived ? copy.noArchivedProjects : copy.noProjects}
          </p>
        ) : (
          <ul className="mob-daemon-nav__list">
            {projects.map((entry) => {
              const count = showArchived
                ? new Set(archivedSessions
                  .filter((session) => session.projectId === entry.id)
                  .map((session) => session.workspaceId)).size
                : snapshot.workspaces.filter((candidate) => (
                  candidate.projectId === entry.id && candidate.archivedAt === undefined
                )).length;
              return (
                <li key={entry.id}>
                <button
                  type="button"
                  className="mob-daemon-nav__row"
                  onClick={() => {
                    setProjectId(entry.id);
                    setWorkspaceId(null);
                  }}
                  data-testid="mobile-daemon-project"
                >
                  <Folder aria-hidden="true" />
                  <span>
                    <strong>{entry.name}</strong>
                    <small title={entry.rootPath}>{entry.rootPath ? formatCwd(entry.rootPath, 38) : copy.projects}</small>
                  </span>
                  <span className="mob-daemon-nav__count" aria-label={`${count} ${copy.workspaces}`}>{count}</span>
                  <ChevronRight aria-hidden="true" />
                </button>
                </li>
              );
            })}
            {!showArchived && archivedCount > 0 && (
              <li>
                <button
                  type="button"
                  className="mob-daemon-nav__row mob-daemon-nav__row--archived"
                  onClick={() => changeVisibility('archived')}
                  data-testid="mobile-daemon-archived"
                  aria-label={`${copy.archived}: ${archivedCount}`}
                >
                  <Archive aria-hidden="true" />
                  <span>
                    <strong>{copy.archived}</strong>
                    <small>{copy.archivedDescription}</small>
                  </span>
                  <span className="mob-daemon-nav__count" aria-hidden="true">{archivedCount}</span>
                  <ChevronRight aria-hidden="true" />
                </button>
              </li>
            )}
          </ul>
        )
      )}

      {snapshot && project && !workspace && (
        workspaces.length === 0 ? (
          <p className="mob-empty" data-testid="mobile-daemon-empty-workspaces">
            {showArchived ? copy.noArchivedWorkspaces : copy.noWorkspaces}
          </p>
        ) : (
          <ul className="mob-daemon-nav__list">
            {workspaces.map((entry) => {
              const count = showArchived
                ? archivedSessions.filter((candidate) => candidate.workspaceId === entry.id).length
                : snapshot.sessions.filter((candidate) => (
                  candidate.workspaceId === entry.id
                  && !isDaemonSessionArchived(candidate, agents.get(candidate.id))
                )).length;
              return (
                <li key={entry.id}>
                <button
                  type="button"
                  className="mob-daemon-nav__row"
                  onClick={() => setWorkspaceId(entry.id)}
                  data-testid="mobile-daemon-workspace"
                  data-workspace-kind={entry.kind}
                >
                  {entry.kind === 'worktree'
                    ? <GitBranch aria-hidden="true" />
                    : <Folder aria-hidden="true" />}
                  <span>
                    <strong>{entry.name}</strong>
                    <small title={entry.rootPath}>
                      {entry.kind === 'worktree' ? copy.worktree : copy.local}
                      {' · '}
                      {formatCwd(entry.rootPath, 32)}
                    </small>
                  </span>
                  <span className="mob-daemon-nav__count" aria-label={`${count} ${copy.sessions}`}>{count}</span>
                  <ChevronRight aria-hidden="true" />
                </button>
                </li>
              );
            })}
          </ul>
        )
      )}

      {snapshot && workspace && (
        sessions.length === 0 ? (
          <p className="mob-empty" data-testid="mobile-daemon-empty-sessions">
            {showArchived ? copy.noArchivedSessions : copy.noSessions}
          </p>
        ) : (
          <ul className="mob-daemon-nav__list">
            {sessions.map((session) => {
              const Icon = SESSION_ICON[session.kind];
              return (
                <li key={session.id}>
                <button
                  type="button"
                  className="mob-daemon-nav__row"
                  onClick={() => onSelectSession(session.id)}
                  aria-label={`${copy.openSession}: ${session.title}`}
                  data-testid="mobile-daemon-session"
                  data-session-id={session.id}
                  data-session-kind={session.kind}
                  data-archived={showArchived || undefined}
                >
                  <Icon aria-hidden="true" />
                  <span>
                    <strong>{session.title}</strong>
                    <small>{sessionMeta(session, language, showArchived ? copy.archived : undefined)}</small>
                  </span>
                  <ChevronRight aria-hidden="true" />
                </button>
                </li>
              );
            })}
          </ul>
        )
      )}
    </section>
  );
}
