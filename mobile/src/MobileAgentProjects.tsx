import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  MessageSquarePlus,
  Pin,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { formatCwd } from '../../src/renderer/format-cwd';
import { useAppTranslation } from '../../src/renderer/i18n';
import type {
  AgentHistorySessionSummary,
  AgentProjectLaunchBootstrap,
  AgentProjectLauncherSummary,
  AgentProjectSummary,
  AgentResumeBootstrap,
} from '../../src/shared/agent-history';
import { MobileActionSheet } from './MobileActionSheet';
import { MobileAgentFolderPicker } from './MobileAgentFolderPicker';
import { MobileAgentHistorySheet } from './MobileAgentHistorySheet';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

function ageLabel(updatedAt: number, now: number, formatter: Intl.RelativeTimeFormat): string {
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (seconds < 60) return formatter.format(-seconds, 'second');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return formatter.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatter.format(-hours, 'hour');
  return formatter.format(-Math.floor(hours / 24), 'day');
}

export function MobileAgentProjects({
  transport,
  onResumeHistory,
  onLaunchProject,
}: {
  readonly transport: WsEzTerminalTransport;
  readonly onResumeHistory: (bootstrap: AgentResumeBootstrap) => Promise<void>;
  readonly onLaunchProject: (bootstrap: AgentProjectLaunchBootstrap) => Promise<void>;
}): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const [projects, setProjects] = useState<readonly AgentProjectSummary[]>([]);
  const [projectCursor, setProjectCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [sessions, setSessions] = useState<
    Readonly<Record<string, readonly AgentHistorySessionSummary[]>>
  >({});
  const [sessionCursors, setSessionCursors] = useState<Readonly<Record<string, string | null>>>({});
  const [sessionLoading, setSessionLoading] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [historySession, setHistorySession] = useState<AgentHistorySessionSummary | null>(null);
  const [editorProject, setEditorProject] = useState<AgentProjectSummary | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [rootsDraft, setRootsDraft] = useState<readonly string[]>([]);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AgentProjectSummary | null>(null);
  const [launcherProject, setLauncherProject] = useState<AgentProjectSummary | null>(null);
  const [launchers, setLaunchers] = useState<readonly AgentProjectLauncherSummary[]>([]);
  const [launchersLoading, setLaunchersLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const canManage = transport.supportsAgentProjectManagement;
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const relativeTime = useMemo(
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' }),
    [locale],
  );

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(async (
    force = false,
    cursor?: string,
    append = false,
  ): Promise<void> => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    const result = await transport
      .listAgentProjects(force, cursor, 40, debouncedQuery.trim() || undefined)
      .catch(() => null);
    setLoading(false);
    setLoadingMore(false);
    if (!result) {
      setError(t('agentHub.projects.loadFailed'));
      return;
    }
    setProjects((current) => append ? [...current, ...result.items] : result.items);
    setProjectCursor(result.nextCursor);
  }, [debouncedQuery, t, transport]);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const toggleProject = async (projectId: string): Promise<void> => {
    if (expandedProject === projectId) {
      setExpandedProject(null);
      return;
    }
    setExpandedProject(projectId);
    setSessionError(null);
    if (sessions[projectId]) return;
    setSessionLoading(projectId);
    const result = await transport
      .listAgentHistorySessions(projectId, undefined, 20)
      .catch(() => null);
    setSessionLoading(null);
    if (!result) {
      setSessionError(projectId);
      return;
    }
    setSessions((current) => ({ ...current, [projectId]: result.items }));
    setSessionCursors((current) => ({ ...current, [projectId]: result.nextCursor }));
  };

  const loadMoreSessions = async (projectId: string): Promise<void> => {
    const cursor = sessionCursors[projectId];
    if (!cursor || sessionLoading) return;
    setSessionLoading(projectId);
    setSessionError(null);
    const result = await transport
      .listAgentHistorySessions(projectId, cursor, 20)
      .catch(() => null);
    setSessionLoading(null);
    if (!result) {
      setSessionError(projectId);
      return;
    }
    setSessions((current) => ({
      ...current,
      [projectId]: [...(current[projectId] ?? []), ...result.items],
    }));
    setSessionCursors((current) => ({ ...current, [projectId]: result.nextCursor }));
  };

  const openEditor = (project?: AgentProjectSummary): void => {
    setEditorProject(project ?? null);
    setNameDraft(project?.name ?? '');
    setRootsDraft(project ? [project.primaryRoot, ...project.additionalRoots] : []);
    setError(null);
    setEditorOpen(true);
    if (!project) setFolderPickerOpen(true);
  };

  const saveProject = async (): Promise<void> => {
    const [primaryRoot, ...additionalRoots] = rootsDraft;
    const name = nameDraft.trim();
    if (!primaryRoot || !name || saving) return;
    setSaving(true);
    setError(null);
    const result = await transport.saveAgentProject({
      ...(editorProject ? { projectId: editorProject.projectId } : {}),
      name,
      primaryRoot,
      additionalRoots,
      pinned: editorProject?.pinned ?? false,
    }).catch(() => ({ ok: false, reason: 'invalid' } as const));
    setSaving(false);
    if (!result.ok) {
      setError(t('agentHub.projects.saveFailed'));
      return;
    }
    setEditorOpen(false);
    setSessions({});
    setExpandedProject(null);
    await refresh(true);
  };

  const patchProject = async (
    project: AgentProjectSummary,
    patch: Partial<Pick<AgentProjectSummary, 'pinned'>>,
  ): Promise<void> => {
    setError(null);
    const result = await transport.saveAgentProject({
      projectId: project.projectId,
      name: project.name,
      primaryRoot: project.primaryRoot,
      additionalRoots: project.additionalRoots,
      pinned: patch.pinned ?? project.pinned,
    }).catch(() => ({ ok: false, reason: 'invalid' } as const));
    if (!result.ok) {
      setError(t('agentHub.projects.saveFailed'));
      return;
    }
    await refresh(true);
  };

  const removeProject = async (): Promise<void> => {
    if (!deleteTarget) return;
    const removed = await transport.removeAgentProject(deleteTarget.projectId).catch(() => false);
    if (!removed) {
      setError(t('agentHub.projects.deleteFailed'));
      return;
    }
    setDeleteTarget(null);
    setSessions({});
    setExpandedProject(null);
    await refresh(true);
  };

  const openLaunchers = async (project: AgentProjectSummary): Promise<void> => {
    setLauncherProject(project);
    if (launchers.length > 0) return;
    setLaunchersLoading(true);
    const result = await transport.listAgentProjectLaunchers().catch(() => []);
    setLaunchers(result);
    setLaunchersLoading(false);
  };

  const launchProject = async (launcher: AgentProjectLauncherSummary): Promise<void> => {
    if (!launcherProject || launching) return;
    setLaunching(true);
    setError(null);
    const preparation = await transport
      .prepareAgentProjectLaunch(launcherProject.projectId, launcher.launcherId)
      .catch(() => ({ ok: false, reason: 'unavailable' } as const));
    if (!preparation.ok) {
      setLaunching(false);
      setError(t('agentHub.projects.launchFailed'));
      setLauncherProject(null);
      return;
    }
    const bootstrap: AgentProjectLaunchBootstrap = {
      kind: 'new-chat',
      projectId: preparation.projectId,
      launcherId: preparation.launcherId,
      provider: preparation.provider,
      name: preparation.name,
      cwd: preparation.cwd,
      revision: preparation.revision,
    };
    try {
      await onLaunchProject(bootstrap);
    } catch {
      setLaunching(false);
      setError(t('agentHub.projects.launchFailed'));
      setLauncherProject(null);
    }
  };

  return (
    <section className="mob-agent-projects" data-testid="mobile-agent-projects">
      <div className="mob-agent-projects__head">
        <h2>{t('agentHub.projects.title')}</h2>
        {canManage && (
          <button
            type="button"
            className="mob-icon-btn"
            aria-label={t('agentHub.projects.add')}
            onClick={() => openEditor()}
            data-testid="mobile-agent-add-project"
          >
            <FolderPlus aria-hidden="true" />
          </button>
        )}
      </div>
      <label className="mob-agent-project-search">
        <span className="ez-ui-visually-hidden">{t('agentHub.projects.searchLabel')}</span>
        <Search aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder={t('agentHub.projects.searchPlaceholder')}
          onChange={(event) => setQuery(event.currentTarget.value)}
          data-testid="mobile-agent-project-search"
        />
      </label>
      {!canManage && (
        <p className="mob-agent-project-upgrade" role="status">
          {t('agentHub.projects.upgradeRequired')}
        </p>
      )}
      {error && <p className="mob-agent-error" role="alert">{error}</p>}
      {loading && <p className="mob-empty">{t('agentHub.projects.loading')}</p>}
      {!loading && projects.length === 0 && (
        <p className="mob-empty">
          {debouncedQuery.trim()
            ? t('agentHub.projects.noMatches')
            : t('agentHub.projects.empty')}
        </p>
      )}
      <div className="mob-agent-project-list">
        {projects.map((project) => {
          const expanded = expandedProject === project.projectId;
          const projectSessions = sessions[project.projectId];
          return (
            <article className="mob-agent-project" key={project.projectId}>
              <button
                type="button"
                className="mob-agent-project__summary"
                onClick={() => void toggleProject(project.projectId)}
                aria-expanded={expanded}
              >
                {expanded
                  ? <ChevronDown aria-hidden="true" />
                  : <ChevronRight aria-hidden="true" />}
                <span>
                  <strong>
                    {project.pinned && <Pin aria-hidden="true" />}
                    {project.name}
                  </strong>
                  <small title={project.primaryRoot}>{formatCwd(project.primaryRoot, 34)}</small>
                </span>
                {projectSessions && (
                  <small>{projectSessions.length}{sessionCursors[project.projectId] ? '+' : ''}</small>
                )}
              </button>
              <div className="mob-agent-project__actions">
                {canManage && (
                  <button
                    type="button"
                    className="mob-btn-ghost"
                    onClick={() => void openLaunchers(project)}
                  >
                    <MessageSquarePlus aria-hidden="true" />
                    {t('agentHub.projects.newChat')}
                  </button>
                )}
                {canManage && (
                  <>
                    <button
                      type="button"
                      className="mob-icon-btn"
                      aria-label={project.pinned
                        ? t('agentHub.projects.unpin')
                        : t('agentHub.projects.pin')}
                      onClick={() => void patchProject(project, { pinned: !project.pinned })}
                    >
                      <Pin aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="mob-icon-btn"
                      aria-label={t('agentHub.projects.edit')}
                      onClick={() => openEditor(project)}
                    >
                      <Settings aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="mob-icon-btn"
                      aria-label={t('agentHub.projects.delete')}
                      onClick={() => setDeleteTarget(project)}
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
              {expanded && (
                <div className="mob-agent-history-list">
                  {sessionLoading === project.projectId && !projectSessions && (
                    <p className="mob-empty">{t('agentHub.projects.sessionsLoading')}</p>
                  )}
                  {sessionError === project.projectId && (
                    <p className="mob-agent-error">{t('agentHub.projects.sessionsFailed')}</p>
                  )}
                  {projectSessions?.length === 0 && (
                    <p className="mob-empty">{t('agentHub.projects.sessionsEmpty')}</p>
                  )}
                  {projectSessions?.map((session) => (
                    <button
                      type="button"
                      className="mob-row"
                      key={session.historyId}
                      onClick={() => setHistorySession(session)}
                    >
                      <span>
                        <strong>{session.title}</strong>
                        <small>
                          {session.provider} · {ageLabel(session.updatedAt, now, relativeTime)}
                        </small>
                      </span>
                    </button>
                  ))}
                  {sessionCursors[project.projectId] && (
                    <button
                      type="button"
                      className="mob-btn-ghost"
                      disabled={sessionLoading !== null}
                      onClick={() => void loadMoreSessions(project.projectId)}
                    >
                      {sessionLoading === project.projectId
                        ? t('agentHub.projects.sessionsLoading')
                        : t('agentHub.projects.moreSessions')}
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {projectCursor && (
        <button
          type="button"
          className="mob-btn-ghost"
          disabled={loadingMore}
          onClick={() => void refresh(false, projectCursor, true)}
        >
          {loadingMore ? t('agentHub.projects.loading') : t('agentHub.projects.loadMore')}
        </button>
      )}

      {historySession && (
        <MobileAgentHistorySheet
          session={historySession}
          onClose={() => setHistorySession(null)}
          onResume={onResumeHistory}
        />
      )}
      {editorOpen && (
        <MobileActionSheet
          title={editorProject
            ? t('agentHub.projects.editorEditTitle')
            : t('agentHub.projects.editorAddTitle')}
          onClose={() => {
            if (!saving) setEditorOpen(false);
          }}
          variant="fullscreen"
          testId="mobile-agent-project-editor"
        >
          <form
            className="mob-agent-project-editor"
            onSubmit={(event) => {
              event.preventDefault();
              void saveProject();
            }}
          >
            <label>
              <span>{t('agentHub.projects.name')}</span>
              <input
                value={nameDraft}
                onChange={(event) => setNameDraft(event.currentTarget.value)}
                data-testid="mobile-agent-project-name"
              />
            </label>
            <div className="mob-agent-project-roots">
              <strong>{t('agentHub.projects.roots')}</strong>
              {rootsDraft.length === 0 && (
                <p className="mob-empty">{t('agentHub.projects.selectPrimary')}</p>
              )}
              {rootsDraft.map((root, index) => (
                <div className="mob-agent-project-root" key={root}>
                  <span>
                    <strong>{index === 0 ? t('agentHub.projects.primary') : `+${index}`}</strong>
                    <small title={root}>{root}</small>
                  </span>
                  {index > 0 && (
                    <>
                      <button
                        type="button"
                        className="mob-btn-ghost"
                        onClick={() => setRootsDraft((current) => [
                          root,
                          ...current.filter((candidate) => candidate !== root),
                        ])}
                      >
                        {t('agentHub.projects.setPrimary')}
                      </button>
                      <button
                        type="button"
                        className="mob-icon-btn"
                        aria-label={`${t('agentHub.projects.removeFolder')}: ${root}`}
                        onClick={() => setRootsDraft((current) => (
                          current.filter((candidate) => candidate !== root)
                        ))}
                      >
                        <X aria-hidden="true" />
                      </button>
                    </>
                  )}
                </div>
              ))}
              <button
                type="button"
                className="mob-btn-ghost"
                onClick={() => setFolderPickerOpen(true)}
              >
                <FolderPlus aria-hidden="true" />
                {t('agentHub.projects.addFolder')}
              </button>
            </div>
            {error && <p className="mob-agent-error" role="alert">{error}</p>}
            <div className="mob-agent-project-editor__footer">
              <button type="button" className="mob-btn-ghost" onClick={() => setEditorOpen(false)}>
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className="mob-cta"
                disabled={saving || !nameDraft.trim() || rootsDraft.length === 0}
              >
                {saving ? t('agentHub.projects.saving') : t('common.save')}
              </button>
            </div>
          </form>
        </MobileActionSheet>
      )}
      {folderPickerOpen && (
        <MobileAgentFolderPicker
          transport={transport}
          excludedRoots={rootsDraft}
          onClose={() => {
            setFolderPickerOpen(false);
            if (rootsDraft.length === 0 && !editorProject) setEditorOpen(false);
          }}
          onSelect={(root) => {
            const name = root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
            setRootsDraft((current) => [...current, root]);
            setNameDraft((current) => current || name);
            setFolderPickerOpen(false);
          }}
        />
      )}
      {launcherProject && (
        <MobileActionSheet
          title={t('agentHub.projects.chooseAgent')}
          onClose={() => {
            if (!launching) setLauncherProject(null);
          }}
          testId="mobile-agent-launchers"
        >
          {launchersLoading && <p className="mob-empty">{t('agentHub.projects.loadingAgents')}</p>}
          {!launchersLoading && launchers.length === 0 && (
            <p className="mob-empty">{t('agentHub.projects.noAgents')}</p>
          )}
          {launchers.map((launcher) => (
            <button
              type="button"
              className="mobile-action-sheet-row"
              key={launcher.launcherId}
              disabled={launching}
              onClick={() => void launchProject(launcher)}
            >
              <MessageSquarePlus aria-hidden="true" />
              {launcher.name}
            </button>
          ))}
        </MobileActionSheet>
      )}
      {deleteTarget && (
        <MobileActionSheet
          title={t('agentHub.projects.deleteTitle', { name: deleteTarget.name })}
          description={t('agentHub.projects.deleteDescription')}
          onClose={() => setDeleteTarget(null)}
          role="alertdialog"
          testId="mobile-agent-delete-project"
        >
          {error && <p className="mob-agent-error" role="alert">{error}</p>}
          <div className="mob-agent-delete-actions">
            <button type="button" className="mob-btn-ghost" onClick={() => setDeleteTarget(null)}>
              {t('common.cancel')}
            </button>
            <button type="button" className="mob-btn-warning" onClick={() => void removeProject()}>
              {t('agentHub.projects.deleteConfirm')}
            </button>
          </div>
        </MobileActionSheet>
      )}
    </section>
  );
}
