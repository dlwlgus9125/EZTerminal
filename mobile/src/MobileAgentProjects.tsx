import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  MessageSquarePlus,
  Pin,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { formatCwd } from '../../src/renderer/format-cwd';
import { DeferredSearchInput } from '../../src/renderer/DeferredSearchInput';
import { AgentRelativeAge } from '../../src/renderer/AgentTime';
import { useLatestRequestGate } from '../../src/renderer/latest-request';
import { useAppTranslation } from '../../src/renderer/i18n';
import type {
  AgentHistorySessionSummary,
  AgentLaunchBootstrap,
  AgentLaunchTarget,
  AgentProjectLauncherSummary,
  AgentProjectSummary,
  AgentResumeBootstrap,
} from '../../src/shared/agent-history';
import {
  EMPTY_AGENT_COORDINATION_SNAPSHOT,
  type AgentCoordinationSnapshot,
} from '../../src/shared/agent-coordination';
import {
  EMPTY_AGENT_ORCHESTRATION_SNAPSHOT,
  type AgentOrchestrationSnapshot,
} from '../../src/shared/agent-orchestration';
import { MobileActionSheet } from './MobileActionSheet';
import { MobileCollaborationPolicySheet } from './MobileCollaborationPolicySheet';
import { MobileAgentFolderPicker } from './MobileAgentFolderPicker';
import { MobileAgentHistorySheet } from './MobileAgentHistorySheet';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

const HISTORY_PROVIDER_LABEL = {
  codex: 'Codex',
  claude: 'Claude',
} as const;

export function MobileAgentProjects({
  transport,
  coordinationSnapshot = EMPTY_AGENT_COORDINATION_SNAPSHOT,
  orchestrationSnapshot = EMPTY_AGENT_ORCHESTRATION_SNAPSHOT,
  onResumeHistory,
  onLaunchAgent,
}: {
  readonly transport: WsEzTerminalTransport;
  readonly coordinationSnapshot?: AgentCoordinationSnapshot;
  readonly orchestrationSnapshot?: AgentOrchestrationSnapshot;
  readonly onResumeHistory: (bootstrap: AgentResumeBootstrap) => Promise<void>;
  readonly onLaunchAgent: (bootstrap: AgentLaunchBootstrap) => Promise<void>;
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
  const [folderPickerMode, setFolderPickerMode] = useState<'editor' | 'launch' | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AgentProjectSummary | null>(null);
  const [collaborationProject, setCollaborationProject] = useState<AgentProjectSummary | null>(null);
  const [launchPickerOpen, setLaunchPickerOpen] = useState(false);
  const [launchTarget, setLaunchTarget] = useState<AgentLaunchTarget | null>(null);
  const [launchTargetProject, setLaunchTargetProject] = useState<AgentProjectSummary | null>(null);
  const [launchProjectOptions, setLaunchProjectOptions] = useState<readonly AgentProjectSummary[]>([]);
  const [launchProjectQuery, setLaunchProjectQuery] = useState('');
  const [launchProjectsLoading, setLaunchProjectsLoading] = useState(false);
  const [launchers, setLaunchers] = useState<readonly AgentProjectLauncherSummary[]>([]);
  const [launchersLoading, setLaunchersLoading] = useState(false);
  const [selectedLauncherId, setSelectedLauncherId] = useState('');
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const projectRequestGate = useLatestRequestGate();
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

  const refresh = useCallback(async (
    force = false,
    cursor?: string,
    append = false,
  ): Promise<void> => {
    const generation = projectRequestGate.begin();
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    const result = await transport
      .listAgentProjects(force, cursor, 40, debouncedQuery.trim() || undefined)
      .catch(() => null);
    if (!projectRequestGate.isCurrent(generation)) return;
    setLoading(false);
    setLoadingMore(false);
    if (!result) {
      setError(t('agentHub.projects.loadFailed'));
      return;
    }
    setProjects((current) => append ? [...current, ...result.items] : result.items);
    setProjectCursor(result.nextCursor);
  }, [debouncedQuery, projectRequestGate, t, transport]);

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
    if (!project) setFolderPickerMode('editor');
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

  useEffect(() => {
    if (!launchPickerOpen) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLaunchProjectsLoading(true);
      void transport
        .listAgentProjects(false, undefined, 100, launchProjectQuery.trim() || undefined)
        .then((result) => {
          if (cancelled) return;
          setLaunchProjectOptions(
            launchTargetProject
              && !result.items.some((project) => project.projectId === launchTargetProject.projectId)
              ? [launchTargetProject, ...result.items]
              : result.items,
          );
        })
        .catch(() => {
          if (!cancelled) {
            setLaunchProjectOptions(launchTargetProject ? [launchTargetProject] : []);
          }
        })
        .finally(() => {
          if (!cancelled) setLaunchProjectsLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [launchPickerOpen, launchProjectQuery, launchTargetProject, transport]);

  const openLaunchPicker = async (project?: AgentProjectSummary): Promise<void> => {
    setLaunchTarget(project ? { kind: 'project', projectId: project.projectId } : null);
    setLaunchTargetProject(project ?? null);
    setLaunchProjectOptions(project ? [project] : projects);
    setLaunchProjectQuery('');
    setSelectedLauncherId('');
    setLaunchError(null);
    setLaunchPickerOpen(true);
    if (launchers.length > 0 || launchersLoading) return;
    setLaunchersLoading(true);
    const result = await transport.listAgentProjectLaunchers().catch(() => []);
    setLaunchers(result);
    setLaunchersLoading(false);
  };

  const launchAgent = async (): Promise<void> => {
    if (!launchTarget || !selectedLauncherId || launching) return;
    setLaunching(true);
    setLaunchError(null);
    const preparation = await transport
      .prepareAgentLaunch(launchTarget, selectedLauncherId)
      .catch(() => ({ ok: false, reason: 'unavailable' } as const));
    if (!preparation.ok) {
      setLaunching(false);
      setLaunchError(t('agentHub.projects.launchFailed'));
      return;
    }
    const bootstrap: AgentLaunchBootstrap = {
      kind: 'new-chat',
      target: preparation.target,
      launcherId: preparation.launcherId,
      provider: preparation.provider,
      name: preparation.name,
      cwd: preparation.cwd,
      revision: preparation.revision,
    };
    try {
      await onLaunchAgent(bootstrap);
      setLaunching(false);
      setLaunchPickerOpen(false);
    } catch {
      setLaunching(false);
      setLaunchError(t('agentHub.projects.launchFailed'));
    }
  };

  const selectedLauncher = launchers.find(
    (launcher) => launcher.launcherId === selectedLauncherId,
  );
  const ignoredAdditionalRoots = launchTargetProject
    && selectedLauncher
    && !selectedLauncher.supportsAdditionalRoots
    ? launchTargetProject.additionalRoots.length
    : 0;

  return (
    <section className="mob-agent-projects" data-testid="mobile-agent-projects">
      <div className="mob-agent-projects__head">
        <h2>{t('agentHub.projects.title')}</h2>
        <div className="mob-agent-projects__head-actions">
          {canManage && (
            <button
              type="button"
              className="mob-btn-ghost"
              onClick={() => void openLaunchPicker()}
              data-testid="mobile-agent-new-run"
            >
              <MessageSquarePlus aria-hidden="true" />
              {t('agentHub.newAgentRun')}
            </button>
          )}
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
      </div>
      <label className="mob-agent-project-search">
        <span className="ez-ui-visually-hidden">{t('agentHub.projects.searchLabel')}</span>
        <Search aria-hidden="true" />
        <DeferredSearchInput
          value={query}
          placeholder={t('agentHub.projects.searchPlaceholder')}
          onQueryChange={setQuery}
          testId="mobile-agent-project-search"
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
                    onClick={() => void openLaunchPicker(project)}
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
                      aria-label={t('collaboration.projectPolicy')}
                      onClick={() => setCollaborationProject(project)}
                      data-testid="mobile-agent-collaboration-policy"
                    >
                      <ShieldCheck aria-hidden="true" />
                    </button>
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
                      className="mob-row mob-agent-history-row"
                      data-provider={session.provider}
                      key={session.historyId}
                      onClick={() => setHistorySession(session)}
                    >
                      <span>
                        <strong>{session.title}</strong>
                        <small>
                          <span className="mob-agent-provider-badge">
                            {HISTORY_PROVIDER_LABEL[session.provider]}
                          </span>
                          {' · '}
                          <AgentRelativeAge updatedAt={session.updatedAt} formatter={relativeTime} />
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
      {collaborationProject && (
        <MobileCollaborationPolicySheet
          project={collaborationProject}
          coordinationSnapshot={coordinationSnapshot}
          snapshot={orchestrationSnapshot}
          transport={transport}
          onClose={() => setCollaborationProject(null)}
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
                onClick={() => setFolderPickerMode('editor')}
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
      {folderPickerMode && (
        <MobileAgentFolderPicker
          transport={transport}
          excludedRoots={folderPickerMode === 'editor' ? rootsDraft : []}
          onClose={() => {
            const mode = folderPickerMode;
            setFolderPickerMode(null);
            if (mode === 'editor' && rootsDraft.length === 0 && !editorProject) {
              setEditorOpen(false);
            }
          }}
          onSelect={(root) => {
            if (folderPickerMode === 'editor') {
              const name = root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
              setRootsDraft((current) => [...current, root]);
              setNameDraft((current) => current || name);
            } else {
              setLaunchTarget({ kind: 'directory', directory: root });
              setLaunchTargetProject(null);
              setLaunchError(null);
            }
            setFolderPickerMode(null);
          }}
        />
      )}
      {launchPickerOpen && (
        <MobileActionSheet
          title={t('agentHub.projects.launchTitle')}
          description={t('agentHub.projects.launchDescription')}
          onClose={() => {
            if (!launching) {
              setLaunchPickerOpen(false);
              setLaunchError(null);
            }
          }}
          variant="fullscreen"
          testId="mobile-agent-launch-picker"
        >
          <form
            className="mob-agent-launch-picker"
            onSubmit={(event) => {
              event.preventDefault();
              void launchAgent();
            }}
          >
            <label>
              <span>{t('agentHub.projects.agent')}</span>
              <select
                value={selectedLauncherId}
                onChange={(event) => {
                  setSelectedLauncherId(event.currentTarget.value);
                  setLaunchError(null);
                }}
                disabled={launchersLoading}
                required
                data-testid="mobile-agent-launch-agent"
              >
                <option value="">
                  {launchersLoading
                    ? t('agentHub.projects.loadingAgents')
                    : t('agentHub.projects.selectAgent')}
                </option>
                {launchers.map((launcher) => (
                  <option key={launcher.launcherId} value={launcher.launcherId}>
                    {launcher.name} · {launcher.provider === 'generic' ? 'CLI' : launcher.provider}
                  </option>
                ))}
              </select>
            </label>
            {!launchersLoading && launchers.length === 0 && (
              <p className="mob-empty">{t('agentHub.projects.noAgents')}</p>
            )}
            <fieldset>
              <legend>{t('agentHub.projects.location')}</legend>
              <DeferredSearchInput
                value={launchProjectQuery}
                placeholder={t('agentHub.projects.locationSearch')}
                ariaLabel={t('agentHub.projects.locationSearch')}
                onQueryChange={setLaunchProjectQuery}
              />
              <select
                value={launchTarget?.kind === 'project'
                  ? launchTarget.projectId
                  : launchTarget?.kind === 'directory'
                    ? '__directory__'
                    : ''}
                onChange={(event) => {
                  if (event.currentTarget.value === '__directory__') return;
                  const project = launchProjectOptions.find(
                    (candidate) => candidate.projectId === event.currentTarget.value,
                  );
                  setLaunchTarget(
                    project ? { kind: 'project', projectId: project.projectId } : null,
                  );
                  setLaunchTargetProject(project ?? null);
                  setLaunchError(null);
                }}
                disabled={launchProjectsLoading}
                required
                aria-label={t('agentHub.projects.selectProject')}
                data-testid="mobile-agent-launch-project"
              >
                <option value="">
                  {launchProjectsLoading
                    ? t('agentHub.projects.loading')
                    : t('agentHub.projects.selectProject')}
                </option>
                {launchTarget?.kind === 'directory' && (
                  <option value="__directory__">
                    {t('agentHub.projects.selectedFolder')} · {formatCwd(launchTarget.directory, 30)}
                  </option>
                )}
                {launchProjectOptions.map((project) => (
                  <option key={project.projectId} value={project.projectId}>
                    {project.name} · {formatCwd(project.primaryRoot, 30)}
                  </option>
                ))}
              </select>
            </fieldset>
            {transport.supportsAgentDirectLaunch ? (
              <button
                type="button"
                className="mob-btn-ghost"
                onClick={() => setFolderPickerMode('launch')}
                data-testid="mobile-agent-launch-folder"
              >
                <FolderPlus aria-hidden="true" />
                {t('agentHub.projects.chooseFolder')}
              </button>
            ) : (
              <p className="mob-agent-project-upgrade" role="status">
                {t('agentHub.projects.directLaunchUpgrade')}
              </p>
            )}
            {launchTarget?.kind === 'directory' && (
              <p className="mob-agent-launch-directory" title={launchTarget.directory}>
                <strong>{t('agentHub.projects.selectedFolder')}</strong>
                <code>{launchTarget.directory}</code>
              </p>
            )}
            {ignoredAdditionalRoots > 0 && (
              <p className="mob-agent-launch-warning" role="status">
                {t('agentHub.projects.genericRootsIgnored', {
                  value: ignoredAdditionalRoots,
                })}
              </p>
            )}
            {launchError && <p className="mob-agent-error" role="alert">{launchError}</p>}
            <div className="mob-agent-project-editor__footer">
              <button
                type="button"
                className="mob-btn-ghost"
                onClick={() => setLaunchPickerOpen(false)}
                disabled={launching}
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className="mob-cta"
                disabled={launching || !launchTarget || !selectedLauncherId}
                data-testid="mobile-agent-launch-submit"
              >
                {launching
                  ? t('agentHub.projects.launching')
                  : t('agentHub.projects.launch')}
              </button>
            </div>
          </form>
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
