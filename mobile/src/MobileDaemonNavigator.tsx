import {
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
import type {
  DaemonSession,
  DaemonSnapshot,
  SessionKind,
} from '../../src/shared/daemon-protocol';
import type { DaemonRuntimeViewState } from './transport/ws-ezterminal';

interface NavigatorCopy {
  readonly title: string;
  readonly projects: string;
  readonly workspaces: string;
  readonly sessions: string;
  readonly loading: string;
  readonly reconnecting: string;
  readonly loadFailed: string;
  readonly invalidSnapshot: string;
  readonly gap: string;
  readonly retry: string;
  readonly noProjects: string;
  readonly noWorkspaces: string;
  readonly noSessions: string;
  readonly local: string;
  readonly worktree: string;
  readonly revision: string;
  readonly backToProjects: string;
  readonly backToWorkspaces: string;
  readonly openSession: string;
}

const COPY: Readonly<Record<'en' | 'ko', NavigatorCopy>> = {
  en: {
    title: 'Projects',
    projects: 'Projects',
    workspaces: 'Workspaces',
    sessions: 'Sessions',
    loading: 'Loading projects from the desktop…',
    reconnecting: 'Reconnecting and checking the latest project state…',
    loadFailed: 'The desktop project state is unavailable.',
    invalidSnapshot: 'The desktop returned an invalid project snapshot.',
    gap: 'Some updates were missed. Reloading the authoritative state…',
    retry: 'Retry',
    noProjects: 'No projects yet. Create one on Desktop to get started.',
    noWorkspaces: 'This project has no active workspaces.',
    noSessions: 'This workspace has no active sessions.',
    local: 'Local',
    worktree: 'Worktree',
    revision: 'Revision',
    backToProjects: 'Back to projects',
    backToWorkspaces: 'Back to workspaces',
    openSession: 'Open session',
  },
  ko: {
    title: '프로젝트',
    projects: '프로젝트',
    workspaces: '워크스페이스',
    sessions: '세션',
    loading: '데스크톱에서 프로젝트를 불러오는 중…',
    reconnecting: '다시 연결하고 최신 프로젝트 상태를 확인하는 중…',
    loadFailed: '데스크톱 프로젝트 상태를 불러올 수 없습니다.',
    invalidSnapshot: '데스크톱이 올바르지 않은 프로젝트 스냅샷을 보냈습니다.',
    gap: '일부 업데이트를 놓쳤습니다. 기준 상태를 다시 불러오는 중…',
    retry: '다시 시도',
    noProjects: '아직 프로젝트가 없습니다. 데스크톱에서 프로젝트를 만들어 주세요.',
    noWorkspaces: '이 프로젝트에는 활성 워크스페이스가 없습니다.',
    noSessions: '이 워크스페이스에는 활성 세션이 없습니다.',
    local: '로컬',
    worktree: '워크트리',
    revision: '리비전',
    backToProjects: '프로젝트로 돌아가기',
    backToWorkspaces: '워크스페이스로 돌아가기',
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

function sessionMeta(session: DaemonSession, language: 'en' | 'ko'): string {
  const source = session.source === 'legacy-pty'
    ? ' · Legacy PTY'
    : session.source === 'legacy-import'
      ? ' · Imported'
      : '';
  return `${SESSION_LABEL[language][session.kind]} · ${session.state}${source}`;
}

export function MobileDaemonNavigator({
  state,
  onRetry,
  onSelectSession,
}: {
  readonly state: DaemonRuntimeViewState;
  readonly onRetry: () => void;
  readonly onSelectSession: (sessionId: string) => void;
}): JSX.Element {
  const { i18n } = useAppTranslation();
  const language: 'en' | 'ko' = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko')
    ? 'ko'
    : 'en';
  const copy = COPY[language];
  const [projectId, setProjectId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const snapshot = state.snapshot;
  const projects = useMemo(() => snapshot ? currentProjects(snapshot) : [], [snapshot]);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const workspaces = useMemo(() => snapshot && project
    ? snapshot.workspaces.filter((workspace) => (
      workspace.projectId === project.id && workspace.archivedAt === undefined
    ))
    : [], [project, snapshot]);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const sessions = useMemo(() => snapshot && workspace
    ? snapshot.sessions.filter((session) => (
      session.workspaceId === workspace.id && session.archivedAt === undefined
    ))
    : [], [snapshot, workspace]);

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
      aria-label={copy.title}
      data-testid="mobile-daemon-navigator"
      data-sync-status={state.status}
    >
      <header className="mob-daemon-nav__head">
        <div>
          <h2>{workspace ? copy.sessions : project ? copy.workspaces : copy.projects}</h2>
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
        ) : null}
      </header>

      {(project || workspace) && (
        <nav className="mob-daemon-nav__crumbs" aria-label={`${copy.projects} / ${copy.workspaces} / ${copy.sessions}`}>
          <button
            type="button"
            onClick={() => {
              setProjectId(null);
              setWorkspaceId(null);
            }}
          >
            {copy.projects}
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
        projects.length === 0 ? (
          <p className="mob-empty" data-testid="mobile-daemon-empty-projects">{copy.noProjects}</p>
        ) : (
          <ul className="mob-daemon-nav__list">
            {projects.map((entry) => {
              const count = snapshot.workspaces.filter((candidate) => (
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
          </ul>
        )
      )}

      {snapshot && project && !workspace && (
        workspaces.length === 0 ? (
          <p className="mob-empty" data-testid="mobile-daemon-empty-workspaces">{copy.noWorkspaces}</p>
        ) : (
          <ul className="mob-daemon-nav__list">
            {workspaces.map((entry) => {
              const count = snapshot.sessions.filter((candidate) => (
                candidate.workspaceId === entry.id && candidate.archivedAt === undefined
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
          <p className="mob-empty" data-testid="mobile-daemon-empty-sessions">{copy.noSessions}</p>
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
                >
                  <Icon aria-hidden="true" />
                  <span>
                    <strong>{session.title}</strong>
                    <small>{sessionMeta(session, language)}</small>
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
