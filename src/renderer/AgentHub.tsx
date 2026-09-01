import {
  ArrowLeft,
  Check,
  CircleAlert,
  CheckCircle2,
  FolderPlus,
  GitCompareArrows,
  GitMerge,
  History,
  MessageSquarePlus,
  MoreHorizontal,
  Pin,
  Play,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AgentActivity,
  AgentApprovalRisk,
  AgentActivitySnapshot,
  AgentDecision,
  AgentDecisionResult,
  AgentFollowupResult,
  AgentProvider,
  AgentStatus,
} from '../shared/agent';
import {
  EMPTY_AGENT_COORDINATION_SNAPSHOT,
  type AgentCoordinationMutationResult,
  type AgentCoordinationSnapshot,
  type AgentParticipant,
  type AgentParticipantInput,
  type AgentProjectCoordination,
  type AgentProjectCoordinationInput,
  type AgentValidationCommand,
  type ManagedMergeDecisionInput,
  type ManagedMergeGrantInput,
  type ManagedMergeRequest,
  isSafeLocalBranch,
} from '../shared/agent-coordination';
import {
  EMPTY_AGENT_TEAM_DESKTOP_SNAPSHOT,
  MAX_AGENT_TEAM_GOAL_CRITERIA,
  MAX_AGENT_TEAM_MEMBERS,
  type AgentTeamDesktopSnapshot,
  type AgentTeamMemberBinding,
  type AgentTeamRun,
  isTerminalAgentTeamRunPhase,
} from '../shared/agent-team';
import type {
  AgentHistorySessionSummary,
  AgentLaunchBootstrap,
  AgentLaunchTarget,
  AgentProjectLauncherSummary,
  AgentProjectSummary,
} from '../shared/agent-history';
import type {
  ProjectSessionPanelMetadata,
  ProjectSessionTarget,
} from '../shared/project-workspace';
import {
  EMPTY_GIT_DIRECTORY_STATUS,
  type GitDiffOmission,
  type GitDiffResult,
  type GitDirectoryStatus,
} from '../shared/git-status';
import { formatCwd } from './format-cwd';
import { useGitBranches } from './use-git-branch';
import { useAppTranslation } from './i18n';
import { ProjectWorkspacePanel, type ProjectExplorerState } from './ProjectWorkspacePanel';
import type { ProjectCodeLocation } from './project-code-navigation';
import type { ProjectEditorDocument } from './project-editor-model';
import { AgentFollowupComposer } from './AgentFollowupComposer';
import { AgentApprovalCountdown, AgentElapsed, AgentRelativeAge } from './AgentTime';
import { DeferredSearchInput } from './DeferredSearchInput';
import { useLatestRequestGate } from './latest-request';
import {
  Button,
  Dialog,
  Field,
  IconButton,
  Input,
  Menu,
  MenuItem,
  Select,
} from './ui';

/** Used when no Git reader is supplied; every row then shows its directory. */
const readNothing = (): Promise<GitDirectoryStatus> => Promise.resolve(EMPTY_GIT_DIRECTORY_STATUS);

const ATTENTION = new Set<AgentStatus>(['blocked', 'error', 'done']);
const ACTIVE = new Set<AgentStatus>(['starting', 'working']);

const STATUS_LABEL_KEY = {
  starting: 'agentHub.status.starting',
  working: 'agentHub.status.working',
  blocked: 'agentHub.status.blocked',
  done: 'agentHub.status.done',
  idle: 'agentHub.status.idle',
  unknown: 'agentHub.status.unknown',
  error: 'agentHub.status.error',
} as const satisfies Record<AgentStatus, string>;

const PROVIDER_LABEL: Record<AgentProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  generic: 'CLI',
};

const RISK_LABEL_KEY = {
  danger: 'agentHub.approvalRisk.danger',
  write: 'agentHub.approvalRisk.write',
  read: 'agentHub.approvalRisk.read',
} as const satisfies Record<AgentApprovalRisk, string>;

const RISK_RANK = {
  danger: 0,
  write: 1,
  read: 2,
} as const satisfies Record<AgentApprovalRisk, number>;

function sortRecent(a: AgentActivity, b: AgentActivity): number {
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

function validTeamRunCriteria(criteria: readonly string[]): boolean {
  const normalized = criteria.map((criterion) => criterion.trim());
  return normalized.length >= 1
    && normalized.length <= MAX_AGENT_TEAM_GOAL_CRITERIA
    && normalized.every((criterion) => criterion.length > 0 && criterion.length <= 500)
    && new Set(normalized.map((criterion) => criterion.toLocaleLowerCase('en-US'))).size === normalized.length;
}

export interface AgentHubProps {
  readonly snapshot: AgentActivitySnapshot;
  readonly coordinationSnapshot?: AgentCoordinationSnapshot;
  readonly teamSnapshot?: AgentTeamDesktopSnapshot;
  readonly onFocusSession: (sessionId: string) => void;
  readonly onSendFollowup: (activityId: string, text: string) => Promise<AgentFollowupResult>;
  /** Answers a parked permission hook. Absent leaves the queue read-only. */
  readonly onDecideApproval?: (
    activityId: string,
    approvalId: string,
    decision: AgentDecision,
  ) => Promise<AgentDecisionResult>;
  /** The agent's uncommitted work, for the reviewer who wants to look first. */
  readonly onLoadDiff?: (directory: string) => Promise<GitDiffResult>;
  /** Opens the first-class project review panel. False falls back to the legacy bounded dialog. */
  readonly onOpenProjectReview?: (directory: string) => Promise<boolean>;
  /** Reads the immutable candidate-vs-target patch for one managed merge revision. */
  readonly onLoadManagedMergeDiff?: (requestId: string, revision: number) => Promise<GitDiffResult>;
  /** Resolves each activity's branch. Absent leaves the working directory. */
  readonly onReadGitStatus?: (directory: string) => Promise<GitDirectoryStatus>;
  /** Opens a singleton read-only history tab without disturbing live terminals. */
  readonly onOpenHistorySession?: (
    session: AgentHistorySessionSummary,
    project: AgentProjectSummary,
  ) => void;
  readonly onOpenHistoryReview?: (
    session: AgentHistorySessionSummary,
    project: AgentProjectSummary,
  ) => void;
  /** Opens the Project drill-in's reusable read-only editor tab. */
  readonly onOpenProjectDocument?: (
    document: ProjectEditorDocument,
    location?: ProjectCodeLocation,
  ) => void;
  readonly onOpenProjectMap?: (target: {
    readonly projectId: string;
    readonly rootId: string;
    readonly workspaceId: string;
  }) => void;
  /** Controlled project drill-in identity. Omit to retain local behavior. */
  readonly activeProjectId?: string | null;
  readonly onActiveProjectIdChange?: (projectId: string | null) => void;
  /** Controlled explorer state, suitable for restoration across sidebar remounts. */
  readonly projectWorkspaceState?: ProjectExplorerState;
  readonly onProjectWorkspaceStateChange?: (state: ProjectExplorerState) => void;
  readonly onProjectDrillChange?: (open: boolean) => void;
  /** Opens a fresh terminal using a main-prepared project or directory launch. */
  readonly onLaunchAgent?: (
    bootstrap: AgentLaunchBootstrap,
    projectSession?: ProjectSessionPanelMetadata,
  ) => void;
  readonly onOpenProjectTerminal?: (projectSession: ProjectSessionPanelMetadata) => void;
  readonly onOpenAgentSettings?: () => void;
  readonly onJoinCollaboration?: (
    input: AgentParticipantInput,
  ) => Promise<AgentCoordinationMutationResult<{ readonly participant: AgentParticipant; readonly brief: string }>>;
  readonly onLeaveCollaboration?: (activityId: string) => Promise<boolean>;
  readonly onSaveCoordinationProject?: (
    input: AgentProjectCoordinationInput,
  ) => Promise<AgentCoordinationMutationResult<AgentProjectCoordination>>;
  readonly onSendPrompt?: (activityId: string, text: string) => Promise<AgentFollowupResult>;
  readonly onRequestManagedMerge?: (
    activityId: string,
    targetBranch: string,
  ) => Promise<AgentCoordinationMutationResult<ManagedMergeRequest>>;
  readonly onDecideManagedMerge?: (
    input: ManagedMergeDecisionInput,
  ) => Promise<AgentCoordinationMutationResult<ManagedMergeRequest>>;
  readonly onGrantNextManagedMerge?: (
    input: ManagedMergeGrantInput,
  ) => Promise<AgentCoordinationMutationResult<{ readonly expiresAt: number }>>;
  readonly onClose?: () => void;
  readonly mobile?: boolean;
  readonly disconnected?: boolean;
  /** Fixed clock for deterministic product handoff/reference rendering. */
  readonly currentTime?: number;
}

type DiffView =
  | { readonly state: 'loading' }
  | {
      readonly state: 'ready';
      readonly text: string;
      readonly truncated: boolean;
      readonly omissions: readonly GitDiffOmission[];
    }
  | { readonly state: 'error'; readonly message: string };

export function AgentHub({
  snapshot,
  coordinationSnapshot = EMPTY_AGENT_COORDINATION_SNAPSHOT,
  teamSnapshot = EMPTY_AGENT_TEAM_DESKTOP_SNAPSHOT,
  onFocusSession,
  onSendFollowup,
  onDecideApproval,
  onLoadDiff,
  onOpenProjectReview,
  onLoadManagedMergeDiff,
  onReadGitStatus,
  onOpenHistorySession,
  onOpenHistoryReview,
  onOpenProjectDocument,
  onOpenProjectMap,
  activeProjectId,
  onActiveProjectIdChange,
  projectWorkspaceState,
  onProjectWorkspaceStateChange,
  onProjectDrillChange,
  onLaunchAgent,
  onOpenProjectTerminal,
  onOpenAgentSettings,
  onJoinCollaboration,
  onLeaveCollaboration,
  onSaveCoordinationProject,
  onSendPrompt,
  onRequestManagedMerge,
  onDecideManagedMerge,
  onGrantNextManagedMerge,
  onClose,
  mobile = false,
  disconnected = false,
  currentTime,
}: AgentHubProps): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [diffView, setDiffView] = useState<DiffView | null>(null);
  const [projects, setProjects] = useState<readonly AgentProjectSummary[]>([]);
  const [projectCursor, setProjectCursor] = useState<string | null>(null);
  const [projectQuery, setProjectQuery] = useState('');
  const [debouncedProjectQuery, setDebouncedProjectQuery] = useState('');
  const [projectSessions, setProjectSessions] = useState<
    Readonly<Record<string, readonly AgentHistorySessionSummary[]>>
  >({});
  const [projectSessionCursors, setProjectSessionCursors] = useState<
    Readonly<Record<string, string | null>>
  >({});
  const [loadingSessionProjects, setLoadingSessionProjects] = useState<ReadonlySet<string>>(new Set());
  const [historyProject, setHistoryProject] = useState<AgentProjectSummary | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsLoadingMore, setProjectsLoadingMore] = useState(false);
  const [projectsError, setProjectsError] = useState(false);
  const [projectSessionErrors, setProjectSessionErrors] = useState<ReadonlySet<string>>(new Set());
  const [projectActionError, setProjectActionError] = useState<string | null>(null);
  const [launchers, setLaunchers] = useState<readonly AgentProjectLauncherSummary[]>([]);
  const [launchersLoading, setLaunchersLoading] = useState(false);
  const [launchPickerOpen, setLaunchPickerOpen] = useState(false);
  const [launchSessionType, setLaunchSessionType] = useState<'agent' | 'terminal'>('agent');
  const [launchProjectSession, setLaunchProjectSession] = useState<ProjectSessionPanelMetadata | null>(null);
  const [launchLocationLabel, setLaunchLocationLabel] = useState('');
  const [launchTarget, setLaunchTarget] = useState<AgentLaunchTarget | null>(null);
  const [launchTargetProject, setLaunchTargetProject] = useState<AgentProjectSummary | null>(null);
  const [launchProjectOptions, setLaunchProjectOptions] = useState<readonly AgentProjectSummary[]>([]);
  const [launchProjectQuery, setLaunchProjectQuery] = useState('');
  const [launchProjectsLoading, setLaunchProjectsLoading] = useState(false);
  const [selectedLauncherId, setSelectedLauncherId] = useState('');
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchWorkspaceMode, setLaunchWorkspaceMode] = useState<'current' | 'managed'>('current');
  const [launchWorktreeBranch, setLaunchWorktreeBranch] = useState('');
  const [editingProject, setEditingProject] = useState<AgentProjectSummary | null>(null);
  const [projectEditorOpen, setProjectEditorOpen] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState('');
  const [projectRootsDraft, setProjectRootsDraft] = useState<readonly string[]>([]);
  const [projectSaving, setProjectSaving] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<AgentProjectSummary | null>(null);
  const [localDrillProject, setLocalDrillProject] = useState<AgentProjectSummary | null>(null);
  const [collaborationActivity, setCollaborationActivity] = useState<AgentActivity | null>(null);
  const [collaborationAlias, setCollaborationAlias] = useState('');
  const [collaborationRole, setCollaborationRole] = useState('');
  const [collaborationTask, setCollaborationTask] = useState('');
  const [collaborationBusy, setCollaborationBusy] = useState(false);
  const [collaborationError, setCollaborationError] = useState<string | null>(null);
  const [briefDraft, setBriefDraft] = useState<{ readonly activityId: string; readonly text: string } | null>(null);
  const [coordinationProject, setCoordinationProject] = useState<AgentProjectSummary | null>(null);
  const [coordinationGoal, setCoordinationGoal] = useState('');
  const [coordinationTarget, setCoordinationTarget] = useState('main');
  const [coordinationValidations, setCoordinationValidations] = useState<readonly AgentValidationCommand[]>([]);
  const [coordinationSaving, setCoordinationSaving] = useState(false);
  const [coordinationError, setCoordinationError] = useState<string | null>(null);
  const [teamProject, setTeamProject] = useState<AgentProjectSummary | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [teamGoal, setTeamGoal] = useState('');
  const [teamGoalCriteria, setTeamGoalCriteria] = useState<readonly string[]>(['']);
  const [teamConstraints, setTeamConstraints] = useState('');
  const [teamBaseState, setTeamBaseState] = useState<'loading' | 'clean' | 'dirty' | 'unavailable'>('loading');
  const [teamWarningAcknowledged, setTeamWarningAcknowledged] = useState(false);
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [mergeActivity, setMergeActivity] = useState<AgentActivity | null>(null);
  const [mergeTargetBranch, setMergeTargetBranch] = useState('main');
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [overrideRequest, setOverrideRequest] = useState<ManagedMergeRequest | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [grantActivity, setGrantActivity] = useState<AgentActivity | null>(null);
  const [grantDuration, setGrantDuration] = useState<ManagedMergeGrantInput['durationMs']>(900000);
  const diffRequestGeneration = useRef(0);
  const projectRequestGate = useLatestRequestGate();
  const coordinatedActivities = useMemo(() => {
    const enriched = new Map(coordinationSnapshot.activities.map((item) => [item.id, item]));
    return snapshot.items.map((item) => enriched.get(item.id) ?? item);
  }, [coordinationSnapshot.activities, snapshot.items]);
  const coordinationProjects = useMemo(
    () => new Map(coordinationSnapshot.projects.map((project) => [project.projectId, project])),
    [coordinationSnapshot.projects],
  );
  const activeTeamRun = useMemo(() => {
    if (!teamProject) return null;
    return teamSnapshot.runs.find((run) => (
      run.projectId === teamProject.projectId && !isTerminalAgentTeamRunPhase(run.phase)
    )) ?? null;
  }, [teamProject, teamSnapshot.runs]);
  const selectedTeam = useMemo(
    () => teamSnapshot.catalog.teams.find((team) => team.teamId === selectedTeamId) ?? null,
    [selectedTeamId, teamSnapshot.catalog.teams],
  );
  const selectedTeamUnavailable = useMemo(() => {
    if (!selectedTeam) return false;
    const personas = new Map(teamSnapshot.catalog.personas.map((persona) => [persona.personaId, persona]));
    const capabilities = new Map(teamSnapshot.catalog.capabilities.map((capability) => [
      capability.provider,
      capability,
    ]));
    return selectedTeam.personaIds.some((personaId) => {
      const persona = personas.get(personaId);
      if (!persona) return true;
      const capability = capabilities.get(persona.launch.provider);
      const permission = persona.launch.provider === 'codex'
        ? persona.launch.sandbox
        : persona.launch.permissionMode;
      return !capability?.available
        || !capability.permissionValues.includes(permission)
        || Boolean(persona.launch.model && !capability.supportsModel)
        || Boolean(persona.launch.provider === 'claude'
          && persona.launch.effort
          && !capability.effortValues.includes(persona.launch.effort));
    });
  }, [selectedTeam, teamSnapshot.catalog.capabilities, teamSnapshot.catalog.personas]);
  const pendingMergeRequests = useMemo(() => coordinationSnapshot.mergeRequests.filter((request) => (
    ['preparing', 'validating', 'approval-required', 'override-required', 'merging'].includes(request.state)
  )), [coordinationSnapshot.mergeRequests]);
  const branches = useGitBranches(
    coordinatedActivities.map((item) => item.cwd),
    onReadGitStatus ?? readNothing,
  );
  const drillProject = activeProjectId === undefined
    ? localDrillProject
    : activeProjectId
      ? projects.find((project) => project.projectId === activeProjectId) ?? null
      : null;
  const projectDrillOpen = activeProjectId === undefined
    ? drillProject !== null
    : activeProjectId !== null;
  const selectDrillProject = useCallback((project: AgentProjectSummary | null): void => {
    if (activeProjectId === undefined) setLocalDrillProject(project);
    onActiveProjectIdChange?.(project?.projectId ?? null);
  }, [activeProjectId, onActiveProjectIdChange]);

  useEffect(() => {
    onProjectDrillChange?.(projectDrillOpen);
    if (activeProjectId !== undefined) return undefined;
    return () => onProjectDrillChange?.(false);
  }, [activeProjectId, onProjectDrillChange, projectDrillOpen]);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const relativeTime = useMemo(
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' }),
    [locale],
  );
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }),
    [locale],
  );

  const refreshProjects = useCallback(async (
    force = false,
    cursor?: string,
    append = false,
  ): Promise<void> => {
    const generation = projectRequestGate.begin();
    if (append) setProjectsLoadingMore(true);
    else setProjectsLoading(true);
    setProjectsError(false);
    const read = window.ezterminal?.listAgentProjects;
    if (!read) {
      setProjects([]);
      setProjectsLoading(false);
      setProjectsLoadingMore(false);
      return;
    }
    const result = await read(
      force,
      cursor,
      40,
      debouncedProjectQuery.trim() || undefined,
    ).catch(() => null);
    if (!projectRequestGate.isCurrent(generation)) return;
    setProjectsLoading(false);
    setProjectsLoadingMore(false);
    if (!result) {
      setProjectsError(true);
      return;
    }
    setProjects((previous) => append ? [...previous, ...result.items] : result.items);
    setProjectCursor(result.nextCursor);
  }, [debouncedProjectQuery, projectRequestGate]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedProjectQuery(projectQuery), 200);
    return () => clearTimeout(timer);
  }, [projectQuery]);

  useEffect(() => {
    void refreshProjects(false);
  }, [refreshProjects]);

  const loadInitialProjectSessions = useCallback(async (projectId: string): Promise<void> => {
    const read = window.ezterminal?.listAgentHistorySessions;
    if (!read) return;
    setLoadingSessionProjects((previous) => new Set(previous).add(projectId));
    setProjectSessionErrors((previous) => {
      const next = new Set(previous);
      next.delete(projectId);
      return next;
    });
    const result = await read(projectId, undefined, 20).catch(() => null);
    setLoadingSessionProjects((previous) => {
      const next = new Set(previous);
      next.delete(projectId);
      return next;
    });
    if (!result) {
      setProjectSessionErrors((previous) => new Set(previous).add(projectId));
      return;
    }
    setProjectSessions((previous) => ({ ...previous, [projectId]: result.items }));
    setProjectSessionCursors((previous) => ({ ...previous, [projectId]: result.nextCursor }));
  }, []);

  const openProjectHistory = useCallback((project: AgentProjectSummary): void => {
    setHistoryProject(project);
    if (projectSessions[project.projectId] || loadingSessionProjects.has(project.projectId)) return;
    void loadInitialProjectSessions(project.projectId);
  }, [loadInitialProjectSessions, loadingSessionProjects, projectSessions]);

  const loadMoreSessions = useCallback(async (projectId: string): Promise<void> => {
    const cursor = projectSessionCursors[projectId];
    if (!cursor || loadingSessionProjects.has(projectId)) return;
    const read = window.ezterminal?.listAgentHistorySessions;
    if (!read) return;
    setLoadingSessionProjects((previous) => new Set(previous).add(projectId));
    const result = await read(projectId, cursor, 20).catch(() => null);
    setLoadingSessionProjects((previous) => {
      const next = new Set(previous);
      next.delete(projectId);
      return next;
    });
    if (!result) {
      setProjectSessionErrors((previous) => new Set(previous).add(projectId));
      return;
    }
    setProjectSessions((previous) => ({
      ...previous,
      [projectId]: [...(previous[projectId] ?? []), ...result.items],
    }));
    setProjectSessionCursors((previous) => ({ ...previous, [projectId]: result.nextCursor }));
  }, [loadingSessionProjects, projectSessionCursors]);

  const saveProject = useCallback(async (
    project: AgentProjectSummary,
    patch: Partial<Pick<AgentProjectSummary, 'name' | 'pinned' | 'primaryRoot' | 'additionalRoots'>>,
  ): Promise<void> => {
    const result = await window.ezterminal.saveAgentProject({
      projectId: project.projectId,
      name: patch.name ?? project.name,
      primaryRoot: patch.primaryRoot ?? project.primaryRoot,
      additionalRoots: patch.additionalRoots ?? project.additionalRoots,
      pinned: patch.pinned ?? project.pinned,
    });
    if (result.ok) {
      setProjectSessions({});
      void refreshProjects(true);
    } else {
      setProjectActionError(t('agentHub.projects.saveFailed'));
    }
  }, [refreshProjects, t]);

  const addProject = useCallback(async (): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop) return;
    const selection = await desktop.selectAgentProjectFolders(true);
    const [primaryRoot, ...additionalRoots] = selection.paths;
    if (selection.canceled || !primaryRoot) return;
    const name = primaryRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? primaryRoot;
    setEditingProject(null);
    setProjectNameDraft(name);
    setProjectRootsDraft([primaryRoot, ...additionalRoots]);
    setProjectActionError(null);
    setProjectEditorOpen(true);
  }, []);

  const openProjectEditor = useCallback((project: AgentProjectSummary): void => {
    setEditingProject(project);
    setProjectNameDraft(project.name);
    setProjectRootsDraft([project.primaryRoot, ...project.additionalRoots]);
    setProjectActionError(null);
    setProjectEditorOpen(true);
  }, []);

  const addProjectFolders = useCallback(async (): Promise<void> => {
    const selection = await window.ezterminalDesktop?.selectAgentProjectFolders(true);
    if (!selection || selection.canceled) return;
    setProjectRootsDraft((previous) => {
      const seen = new Set(previous.map((root) => root.toLocaleLowerCase('en-US')));
      return [
        ...previous,
        ...selection.paths.filter((root) => {
          const key = root.toLocaleLowerCase('en-US');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      ];
    });
  }, []);

  const commitProjectEditor = useCallback(async (): Promise<void> => {
    const [primaryRoot, ...additionalRoots] = projectRootsDraft;
    const name = projectNameDraft.trim();
    if (!primaryRoot || !name || projectSaving) return;
    setProjectSaving(true);
    setProjectActionError(null);
    const result = await window.ezterminal.saveAgentProject({
      ...(editingProject ? { projectId: editingProject.projectId } : {}),
      name,
      primaryRoot,
      additionalRoots,
      pinned: editingProject?.pinned ?? false,
    }).catch(() => ({ ok: false, reason: 'invalid' } as const));
    setProjectSaving(false);
    if (!result.ok) {
      setProjectActionError(t('agentHub.projects.saveFailed'));
      return;
    }
    setProjectEditorOpen(false);
    setProjectSessions({});
    void refreshProjects(true);
  }, [
    editingProject,
    projectNameDraft,
    projectRootsDraft,
    projectSaving,
    refreshProjects,
    t,
  ]);

  const removeProject = useCallback(async (): Promise<void> => {
    if (!projectToDelete) return;
    const removed = await window.ezterminal.removeAgentProject(projectToDelete.projectId).catch(() => false);
    if (!removed) {
      setProjectActionError(t('agentHub.projects.deleteFailed'));
      return;
    }
    setProjectToDelete(null);
    if (historyProject?.projectId === projectToDelete.projectId) setHistoryProject(null);
    setProjectSessions({});
    void refreshProjects(true);
  }, [historyProject, projectToDelete, refreshProjects, t]);

  const loadLaunchers = useCallback(async (): Promise<void> => {
    if (launchersLoading || launchers.length > 0) return;
    setLaunchersLoading(true);
    const result = await window.ezterminal.listAgentProjectLaunchers().catch(() => []);
    setLaunchers(result);
    setLaunchersLoading(false);
  }, [launchers, launchersLoading]);

  useEffect(() => {
    if (!launchPickerOpen) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLaunchProjectsLoading(true);
      void window.ezterminal
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
  }, [launchPickerOpen, launchProjectQuery, launchTargetProject]);

  const openLaunchPicker = useCallback((
    project?: AgentProjectSummary,
    projectTarget?: ProjectSessionTarget,
    locationLabel?: string,
  ): void => {
    const target = project
      ? { kind: 'project' as const, ...(projectTarget ?? { projectId: project.projectId }) }
      : null;
    setLaunchTarget(target);
    setLaunchTargetProject(project ?? null);
    setLaunchProjectSession(project && target
      ? {
          projectId: target.projectId,
          ...(target.rootId && target.workspaceId
            ? { rootId: target.rootId, workspaceId: target.workspaceId }
            : {}),
          projectName: project.name,
          titleMode: 'generated',
        }
      : null);
    setLaunchLocationLabel(locationLabel ?? project?.primaryRoot ?? '');
    setLaunchSessionType('agent');
    setLaunchProjectOptions(project ? [project] : projects);
    setLaunchProjectQuery('');
    setSelectedLauncherId('');
    setLaunchWorkspaceMode('current');
    setLaunchWorktreeBranch(`ez/agent-${Date.now().toString(36)}`);
    setLaunchError(null);
    setLaunchPickerOpen(true);
    void loadLaunchers();
  }, [loadLaunchers, projects]);

  const chooseLaunchDirectory = useCallback(async (): Promise<void> => {
    const selection = await window.ezterminalDesktop?.selectAgentProjectFolders(false);
    const directory = selection?.paths[0];
    if (!selection || selection.canceled || !directory) return;
    setLaunchTarget({ kind: 'directory', directory });
    setLaunchTargetProject(null);
    setLaunchError(null);
  }, []);

  const launchAgent = useCallback(async (): Promise<void> => {
    if (launchSessionType === 'terminal' && launchProjectSession) {
      if (!onOpenProjectTerminal || launching) return;
      onOpenProjectTerminal(launchProjectSession);
      setLaunchPickerOpen(false);
      return;
    }
    if (!onLaunchAgent || !launchTarget || !selectedLauncherId || launching) return;
    setLaunching(true);
    setLaunchError(null);
    let effectiveTarget = launchTarget;
    let effectiveProjectSession = launchProjectSession;
    let createdWorktreePath: string | null = null;
    if (
      launchWorkspaceMode === 'managed'
      && launchTarget.kind === 'project'
      && !launchTarget.rootId
      && launchTargetProject
    ) {
      if (!isSafeLocalBranch(launchWorktreeBranch.trim())) {
        setLaunching(false);
        setLaunchError(t('agentHub.projects.worktreeInvalidBranch'));
        return;
      }
      const base = coordinationProjects.get(launchTargetProject.projectId)?.defaultTargetBranch;
      const created = await window.ezterminal.executeWorktree({
        action: 'create',
        cwd: launchTargetProject.primaryRoot,
        branch: launchWorktreeBranch.trim(),
        ...(base ? { base } : {}),
      }).catch(() => null);
      if (!created?.ok || !created.opened) {
        setLaunching(false);
        setLaunchError(created && !created.ok
          ? `${t('agentHub.projects.worktreeCreateFailed')} ${created.message}`
          : t('agentHub.projects.worktreeCreateFailed'));
        return;
      }
      createdWorktreePath = created.opened.path;
      const descriptor = await window.ezterminalDesktop
        ?.describeProjectWorkspace(launchTargetProject.projectId)
        .catch(() => null);
      const workspace = descriptor?.ok
        ? descriptor.project.workspaces?.find((item) => item.workspaceId === created.opened?.worktreeId)
        : undefined;
      if (!workspace) {
        setLaunching(false);
        setLaunchError(t('agentHub.projects.worktreePreserved', { path: created.opened.path }));
        return;
      }
      effectiveTarget = {
        kind: 'project',
        projectId: launchTargetProject.projectId,
        rootId: workspace.rootId,
        workspaceId: workspace.workspaceId,
      };
      effectiveProjectSession = {
        projectId: launchTargetProject.projectId,
        rootId: workspace.rootId,
        workspaceId: workspace.workspaceId,
        projectName: launchTargetProject.name,
        titleMode: 'generated',
      };
    }
    const preparation = await window.ezterminal
      .prepareAgentLaunch(effectiveTarget, selectedLauncherId)
      .catch(() => ({ ok: false, reason: 'unavailable' } as const));
    setLaunching(false);
    if (!preparation.ok) {
      setLaunchError(createdWorktreePath
        ? t('agentHub.projects.worktreePreserved', { path: createdWorktreePath })
        : t('agentHub.projects.launchFailed'));
      return;
    }
    onLaunchAgent({
      kind: 'new-chat',
      target: preparation.target,
      launcherId: preparation.launcherId,
      provider: preparation.provider,
      name: preparation.name,
      cwd: preparation.cwd,
      revision: preparation.revision,
    }, effectiveProjectSession ?? undefined);
    setLaunchPickerOpen(false);
  }, [
    launchProjectSession,
    launchSessionType,
    launchTarget,
    launchTargetProject,
    launchWorkspaceMode,
    launchWorktreeBranch,
    launching,
    coordinationProjects,
    onLaunchAgent,
    onOpenProjectTerminal,
    selectedLauncherId,
    t,
  ]);

  const selectedLauncher = launchers.find(
    (launcher) => launcher.launcherId === selectedLauncherId,
  );
  const ignoredAdditionalRoots = launchTargetProject
    && selectedLauncher
    && !selectedLauncher.supportsAdditionalRoots
    ? launchTargetProject.additionalRoots.length
    : 0;

  const groups = useMemo(() => {
    const attention: AgentActivity[] = [];
    const active: AgentActivity[] = [];
    const recent: AgentActivity[] = [];
    for (const item of coordinatedActivities) {
      if (ATTENTION.has(item.status)) attention.push(item);
      else if (ACTIVE.has(item.status)) active.push(item);
      else recent.push(item);
    }
    attention.sort((a, b) => {
      const aApproval = a.approval;
      const bApproval = b.approval;
      if (aApproval && !bApproval) return -1;
      if (!aApproval && bApproval) return 1;
      if (aApproval && bApproval) {
        const approvalOrder = RISK_RANK[aApproval.risk] - RISK_RANK[bApproval.risk]
          || aApproval.expiresAt - bApproval.expiresAt;
        if (approvalOrder !== 0) return approvalOrder;
      }
      const rank = (status: AgentStatus): number => status === 'blocked' ? 0 : status === 'error' ? 1 : 2;
      return rank(a.status) - rank(b.status) || sortRecent(a, b);
    });
    active.sort(sortRecent);
    recent.sort(sortRecent);
    return { attention, active, recent };
  }, [coordinatedActivities]);

  // A running agent shows a ticking mm:ss, so the clock has to move every
  // second while one exists. With nothing running the coarse relative ages only
  // need the original slow tick. Neither is announced: elapsed time is on the
  // accessibility exclusion list for live regions.
  // A pending approval also needs the fast tick for its display countdown.
  // The host's `pending` bit, rather than this renderer's wall clock, is the
  // authority for whether the decision buttons remain actionable.
  const decide = useCallback(
    async (item: AgentActivity, decision: AgentDecision): Promise<void> => {
      if (!onDecideApproval || !item.approval || decidingId !== null) return;
      setDecidingId(item.id);
      setErrors((previous) => ({ ...previous, [item.id]: '' }));
      const result = await onDecideApproval(
        item.id,
        item.approval.approvalId,
        decision,
      ).catch((): AgentDecisionResult => ({
        ok: false,
        error: 'outcome-unknown',
      }));
      setDecidingId(null);
      if (result.ok) return;
      setErrors((previous) => ({
        ...previous,
        [item.id]: result.error === 'expired' || result.error === 'stale'
          ? t('agentHub.approvalExpired')
          : result.error === 'outcome-unknown'
            ? t('agentHub.approvalOutcomeUnknown')
            : t('agentHub.approvalFailed'),
      }));
    },
    [decidingId, onDecideApproval, t],
  );

  const openDiff = useCallback(
    async (directory: string): Promise<void> => {
      if (onOpenProjectReview && await onOpenProjectReview(directory).catch(() => false)) return;
      if (!onLoadDiff) return;
      const generation = ++diffRequestGeneration.current;
      setDiffView({ state: 'loading' });
      const result = await onLoadDiff(directory).catch((): GitDiffResult => ({
        ok: false,
        error: 'git-failed',
      }));
      if (generation !== diffRequestGeneration.current) return;
      if (!result.ok) {
        setDiffView({
          state: 'error',
          message: result.error === 'not-a-repository' ? t('agentHub.diffUnavailable') : t('agentHub.approvalFailed'),
        });
        return;
      }
      setDiffView({
        state: 'ready',
        text: result.text,
        truncated: result.truncated,
        omissions: result.omissions,
      });
    },
    [onLoadDiff, onOpenProjectReview, t],
  );

  const openManagedMergeDiff = useCallback(async (request: ManagedMergeRequest): Promise<void> => {
    if (!onLoadManagedMergeDiff) return;
    const generation = ++diffRequestGeneration.current;
    setDiffView({ state: 'loading' });
    const result = await onLoadManagedMergeDiff(request.requestId, request.revision).catch((): GitDiffResult => ({
      ok: false,
      error: 'git-failed',
    }));
    if (generation !== diffRequestGeneration.current) return;
    if (!result.ok) {
      setDiffView({ state: 'error', message: t('agentHub.managedMerge.reviewUnavailable') });
      return;
    }
    setDiffView({
      state: 'ready',
      text: result.text,
      truncated: result.truncated,
      omissions: result.omissions,
    });
  }, [onLoadManagedMergeDiff, t]);

  useEffect(() => () => {
    diffRequestGeneration.current += 1;
  }, []);

  const send = useCallback(async (activityId: string, text: string): Promise<string | null> => {
    if (!text || sendingId !== null) return t('agentHub.errorDeliveryFailed');
    setSendingId(activityId);
    const result = await onSendFollowup(activityId, text).catch((): AgentFollowupResult => ({
      ok: false,
      error: 'delivery-failed',
    }));
    setSendingId(null);
    if (result.ok) return null;
    return result.error === 'not-waiting' || result.error === 'not-ready'
      ? t('agentHub.errorNotWaiting')
      : result.error === 'invalid-text'
        ? t('agentHub.errorInvalidText')
        : result.error === 'session-ended'
          ? t('agentHub.errorSessionEnded')
          : t('agentHub.errorDeliveryFailed');
  }, [onSendFollowup, sendingId, t]);

  const projectForActivity = useCallback((activity: AgentActivity): AgentProjectSummary | null => {
    if (activity.projectId) {
      const exact = projects.find((project) => project.projectId === activity.projectId);
      if (exact) return exact;
    }
    const cwd = activity.cwd.replace(/\\/gu, '/').replace(/\/+$/u, '').toLocaleLowerCase('en-US');
    return projects.find((project) => [project.primaryRoot, ...project.additionalRoots].some((root) => {
      const normalized = root.replace(/\\/gu, '/').replace(/\/+$/u, '').toLocaleLowerCase('en-US');
      return cwd === normalized || cwd.startsWith(`${normalized}/`);
    })) ?? null;
  }, [projects]);

  const openCollaboration = useCallback((activity: AgentActivity): void => {
    const provider = PROVIDER_LABEL[activity.provider];
    setCollaborationActivity(activity);
    setCollaborationAlias(activity.participant?.alias ?? `${provider}-${activity.id.slice(-4)}`);
    setCollaborationRole(activity.participant?.role ?? 'Implementer');
    setCollaborationTask(activity.participant?.task ?? 'Work toward the Project goal and report blockers.');
    setCollaborationError(null);
  }, []);

  const joinCollaboration = useCallback(async (): Promise<void> => {
    if (!collaborationActivity || !onJoinCollaboration || collaborationBusy) return;
    const project = projectForActivity(collaborationActivity);
    const coordination = project ? coordinationProjects.get(project.projectId) : undefined;
    setCollaborationBusy(true);
    setCollaborationError(null);
    const result = await onJoinCollaboration({
      activityId: collaborationActivity.id,
      alias: collaborationAlias.trim(),
      role: collaborationRole.trim(),
      task: collaborationTask.trim(),
      ...(coordination ? { expectedProjectRevision: coordination.configRevision } : {}),
    }).catch(() => ({
      ok: false as const,
      error: 'unavailable' as const,
      message: 'Collaboration is unavailable.',
    }));
    setCollaborationBusy(false);
    if (!result.ok) {
      setCollaborationError(result.message);
      return;
    }
    setCollaborationActivity(null);
    setBriefDraft({ activityId: result.value.participant.activityId, text: result.value.brief });
  }, [
    collaborationActivity,
    collaborationAlias,
    collaborationBusy,
    collaborationRole,
    collaborationTask,
    coordinationProjects,
    onJoinCollaboration,
    projectForActivity,
  ]);

  const leaveCollaboration = useCallback(async (activity: AgentActivity): Promise<void> => {
    if (!onLeaveCollaboration) return;
    const left = await onLeaveCollaboration(activity.id).catch(() => false);
    if (!left) setErrors((previous) => ({ ...previous, [activity.id]: t('agentHub.collaboration.leaveFailed') }));
  }, [onLeaveCollaboration, t]);

  const sendBrief = useCallback(async (): Promise<void> => {
    if (!briefDraft || !onSendPrompt || collaborationBusy) return;
    const activity = coordinatedActivities.find((item) => item.id === briefDraft.activityId);
    if (!activity || !activity.live || !activity.interactiveReady || (activity.state !== 'done' && activity.state !== 'idle')) {
      setCollaborationError(t('agentHub.collaboration.waitUntilReady'));
      return;
    }
    setCollaborationBusy(true);
    setCollaborationError(null);
    const result = await onSendPrompt(briefDraft.activityId, briefDraft.text).catch((): AgentFollowupResult => ({
      ok: false,
      error: 'delivery-failed',
    }));
    setCollaborationBusy(false);
    if (result.ok) {
      setBriefDraft(null);
      return;
    }
    setCollaborationError(t('agentHub.errorDeliveryFailed'));
  }, [briefDraft, collaborationBusy, coordinatedActivities, onSendPrompt, t]);

  const openCoordinationProject = useCallback((project: AgentProjectSummary): void => {
    const current = coordinationProjects.get(project.projectId);
    setCoordinationProject(project);
    setCoordinationGoal(current?.goal ?? '');
    setCoordinationTarget(current?.defaultTargetBranch ?? 'main');
    setCoordinationValidations(current?.validationCommands ?? []);
    setCoordinationError(null);
  }, [coordinationProjects]);

  const saveCoordinationProject = useCallback(async (): Promise<void> => {
    if (!coordinationProject || !onSaveCoordinationProject || coordinationSaving) return;
    const current = coordinationProjects.get(coordinationProject.projectId);
    setCoordinationSaving(true);
    setCoordinationError(null);
    const result = await onSaveCoordinationProject({
      projectId: coordinationProject.projectId,
      goal: coordinationGoal.trim(),
      defaultTargetBranch: coordinationTarget.trim(),
      validationCommands: coordinationValidations.map((validation) => ({
        ...validation,
        name: validation.name.trim(),
        command: validation.command.trim(),
        timeoutMs: Number.isFinite(validation.timeoutMs)
          ? Math.max(1_000, Math.min(30 * 60_000, Math.round(validation.timeoutMs)))
          : 300_000,
      })),
      ...(current ? { expectedRevision: current.configRevision } : {}),
    }).catch(() => ({
      ok: false as const,
      error: 'unavailable' as const,
      message: 'Project coordination is unavailable.',
    }));
    setCoordinationSaving(false);
    if (!result.ok) {
      setCoordinationError(result.message);
      return;
    }
    setCoordinationProject(null);
  }, [
    coordinationGoal,
    coordinationProject,
    coordinationProjects,
    coordinationSaving,
    coordinationTarget,
    coordinationValidations,
    onSaveCoordinationProject,
  ]);

  const openTeamProject = useCallback(async (project: AgentProjectSummary): Promise<void> => {
    setTeamProject(project);
    const team = teamSnapshot.catalog.teams.find((candidate) => candidate.teamId === selectedTeamId)
      ?? teamSnapshot.catalog.teams[0];
    setSelectedTeamId(team?.teamId ?? '');
    setTeamGoal(team?.defaultGoal?.outcome ?? '');
    setTeamGoalCriteria(team?.defaultGoal?.acceptanceCriteria ?? ['']);
    setTeamConstraints('');
    setTeamWarningAcknowledged(false);
    setTeamError(null);
    setTeamBaseState('loading');
    const status = await (onReadGitStatus ?? readNothing)(project.primaryRoot).catch(() => null);
    setTeamBaseState(status?.availability === 'ready'
      ? status.changes.length > 0 ? 'dirty' : 'clean'
      : 'unavailable');
  }, [onReadGitStatus, selectedTeamId, teamSnapshot.catalog.teams]);

  const failTeamMember = useCallback(async (
    run: AgentTeamRun,
    personaId: string,
    error: string,
    binding?: AgentTeamMemberBinding,
  ): Promise<AgentTeamRun> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop) return run;
    const submit = (candidate: AgentTeamRun) => desktop.failAgentTeamMember({
      runId: candidate.runId,
      personaId,
      expectedRevision: candidate.revision,
      error,
      ...(binding ? { binding } : {}),
    });
    let candidate = run;
    let result = await submit(candidate).catch(() => null);
    for (let attempt = 0;
      result && !result.ok && result.error === 'stale' && attempt < MAX_AGENT_TEAM_MEMBERS;
      attempt += 1) {
      const refreshed = await desktop.getAgentTeamSnapshot().catch(() => null);
      const current = refreshed?.runs.find((candidate) => candidate.runId === run.runId);
      if (!current) break;
      candidate = current;
      result = await submit(candidate).catch(() => null);
    }
    if (result?.ok) return result.value;
    setTeamError(result && !result.ok ? result.message : error);
    return run;
  }, []);

  const launchTeamMember = useCallback(async (
    run: AgentTeamRun,
    personaId: string,
    project: AgentProjectSummary,
  ): Promise<AgentTeamRun> => {
    const desktop = window.ezterminalDesktop;
    const persona = run.personas.find((candidate) => candidate.personaId === personaId);
    const slot = run.slots.find((candidate) => candidate.personaId === personaId);
    if (!desktop || !persona || !slot || !onLaunchAgent) {
      return failTeamMember(run, personaId, t('agentTeams.launchUnavailable'));
    }
    if (slot.state === 'active' || slot.state === 'excluded') return run;

    let branch = slot.branch;
    let worktreeId = slot.worktreeId;
    let worktreePath = slot.worktreePath;
    if (!branch || !worktreeId || !worktreePath) {
      const slug = persona.name
        .normalize('NFKD')
        .toLocaleLowerCase('en-US')
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 32) || 'agent';
      branch = `ez/team-${run.runId.slice(0, 8)}-${slug}-${persona.personaId.slice(0, 6)}`;
      if (!isSafeLocalBranch(branch)) {
        return failTeamMember(run, personaId, t('agentTeams.worktreeCreateFailed'));
      }
      const created = await window.ezterminal.executeWorktree({
        action: 'create',
        cwd: project.primaryRoot,
        branch,
        base: run.baseHead ?? run.targetBranch,
        ...(run.baseDirty && run.warningAcknowledged ? { allowDirtyBase: true } : {}),
      }).catch(() => null);
      if (!created?.ok || !created.opened) {
        const detail = created && !created.ok ? ` ${created.message}` : '';
        return failTeamMember(run, personaId, `${t('agentTeams.worktreeCreateFailed')}${detail}`);
      }
      worktreeId = created.opened.worktreeId;
      worktreePath = created.opened.path;
    }

    const described = await desktop.describeProjectWorkspace(project.projectId).catch(() => null);
    const workspace = described?.ok
      ? described.project.workspaces?.find((candidate) => (
          candidate.workspaceId === worktreeId
          || candidate.displayPath.toLocaleLowerCase('en-US') === worktreePath?.toLocaleLowerCase('en-US')
        ))
      : undefined;
    const partialBinding: AgentTeamMemberBinding = { branch, worktreeId, worktreePath };
    if (!workspace) {
      return failTeamMember(
        run,
        personaId,
        t('agentTeams.worktreePreserved', { path: worktreePath }),
        partialBinding,
      );
    }
    const binding: AgentTeamMemberBinding = {
      ...partialBinding,
      rootId: workspace.rootId,
      workspaceId: workspace.workspaceId,
    };
    const preparation = await desktop.prepareAgentTeamMemberLaunch({
      runId: run.runId,
      personaId,
      expectedRevision: run.revision,
      target: {
        kind: 'project',
        projectId: project.projectId,
        rootId: workspace.rootId,
        workspaceId: workspace.workspaceId,
      },
      binding,
    }).catch(() => null);
    if (!preparation?.ok) {
      return failTeamMember(
        run,
        personaId,
        preparation && !preparation.ok ? preparation.message : t('agentTeams.launchUnavailable'),
        binding,
      );
    }
    const preparedRun = preparation.value.run;
    const prepared = preparation.value.preparation;
    onLaunchAgent({
      kind: 'new-chat',
      target: prepared.target,
      launcherId: prepared.launcherId,
      provider: prepared.provider,
      name: persona.name,
      cwd: prepared.cwd,
      revision: prepared.revision,
      teamMemberRequest: { runId: run.runId, personaId },
    }, {
      projectId: project.projectId,
      rootId: workspace.rootId,
      workspaceId: workspace.workspaceId,
      projectName: project.name,
      titleMode: 'generated',
    });
    return preparedRun;
  }, [failTeamMember, onLaunchAgent, t]);

  const startTeamRun = useCallback(async (): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || !teamProject || !selectedTeamId || !teamGoal.trim()
      || !validTeamRunCriteria(teamGoalCriteria) || teamBusy) return;
    setTeamBusy(true);
    setTeamError(null);
    const created = await desktop.createAgentTeamRun({
      projectId: teamProject.projectId,
      teamId: selectedTeamId,
      goal: teamGoal.trim(),
      acceptanceCriteria: teamGoalCriteria.map((criterion) => criterion.trim()),
      ...(teamConstraints.trim() ? { constraints: teamConstraints.trim() } : {}),
      warningAcknowledged: teamBaseState !== 'dirty' || teamWarningAcknowledged,
    }).catch(() => null);
    if (!created?.ok) {
      setTeamBusy(false);
      setTeamError(created && !created.ok ? created.message : t('agentTeams.startFailed'));
      return;
    }
    await launchTeamMember(created.value, created.value.plannerPersonaId, teamProject);
    setTeamBusy(false);
  }, [
    launchTeamMember,
    selectedTeamId,
    t,
    teamBaseState,
    teamBusy,
    teamConstraints,
    teamGoal,
    teamGoalCriteria,
    teamProject,
    teamWarningAcknowledged,
  ]);

  const approveTeamPlan = useCallback(async (): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || !teamProject || !activeTeamRun?.proposal || teamBusy) return;
    setTeamBusy(true);
    setTeamError(null);
    const approved = await desktop.approveAgentTeamPlan({
      runId: activeTeamRun.runId,
      expectedRevision: activeTeamRun.revision,
      proposal: activeTeamRun.proposal,
    }).catch(() => null);
    if (!approved?.ok) {
      setTeamBusy(false);
      setTeamError(approved && !approved.ok ? approved.message : t('agentTeams.approveFailed'));
      return;
    }
    let current = approved.value;
    for (const assignment of approved.value.proposal?.assignments ?? []) {
      if (assignment.personaId === approved.value.plannerPersonaId) continue;
      current = await launchTeamMember(current, assignment.personaId, teamProject);
    }
    setTeamBusy(false);
  }, [activeTeamRun, launchTeamMember, t, teamBusy, teamProject]);

  const decideTeamRun = useCallback(async (decision: 'complete' | 'cancel'): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || !activeTeamRun || teamBusy) return;
    setTeamBusy(true);
    const result = await desktop.decideAgentTeamRun({
      runId: activeTeamRun.runId,
      expectedRevision: activeTeamRun.revision,
      decision,
    }).catch(() => null);
    setTeamBusy(false);
    if (!result?.ok) {
      setTeamError(result && !result.ok ? result.message : t('agentTeams.decisionFailed'));
    }
  }, [activeTeamRun, t, teamBusy]);

  const retryTeamMember = useCallback(async (personaId: string): Promise<void> => {
    if (!activeTeamRun || !teamProject || teamBusy) return;
    setTeamBusy(true);
    setTeamError(null);
    await launchTeamMember(activeTeamRun, personaId, teamProject);
    setTeamBusy(false);
  }, [activeTeamRun, launchTeamMember, teamBusy, teamProject]);

  const openMergeRequest = useCallback((activity: AgentActivity): void => {
    const project = activity.participant
      ? coordinationProjects.get(activity.participant.projectId)
      : undefined;
    setMergeActivity(activity);
    setMergeTargetBranch(project?.defaultTargetBranch ?? 'main');
    setMergeError(null);
  }, [coordinationProjects]);

  const requestMerge = useCallback(async (): Promise<void> => {
    if (!mergeActivity || !onRequestManagedMerge || mergeBusy) return;
    setMergeBusy(true);
    setMergeError(null);
    const result = await onRequestManagedMerge(mergeActivity.id, mergeTargetBranch.trim()).catch(() => ({
      ok: false as const,
      error: 'unavailable' as const,
      message: 'Managed merge is unavailable.',
    }));
    setMergeBusy(false);
    if (!result.ok) {
      setMergeError(result.message);
      return;
    }
    setMergeActivity(null);
  }, [mergeActivity, mergeBusy, mergeTargetBranch, onRequestManagedMerge]);

  const decideMerge = useCallback(async (
    request: ManagedMergeRequest,
    decision: 'approve' | 'deny',
    overrideReasonValue?: string,
  ): Promise<void> => {
    if (!onDecideManagedMerge || mergeBusy) return;
    setMergeBusy(true);
    setMergeError(null);
    const result = await onDecideManagedMerge({
      requestId: request.requestId,
      revision: request.revision,
      decision,
      actor: 'desktop',
      ...(overrideReasonValue ? { overrideReason: overrideReasonValue } : {}),
    }).catch(() => ({
      ok: false as const,
      error: 'unavailable' as const,
      message: 'Managed merge is unavailable.',
    }));
    setMergeBusy(false);
    if (!result.ok) {
      setMergeError(result.message);
      return;
    }
    setOverrideRequest(null);
    setOverrideReason('');
  }, [mergeBusy, onDecideManagedMerge]);

  const grantNextMerge = useCallback(async (): Promise<void> => {
    const participant = grantActivity?.participant;
    if (!participant || !onGrantNextManagedMerge || mergeBusy) return;
    const project = coordinationProjects.get(participant.projectId);
    setMergeBusy(true);
    setMergeError(null);
    const result = await onGrantNextManagedMerge({
      participantId: participant.participantId,
      sourceWorkspaceId: participant.workspaceId,
      targetBranch: project?.defaultTargetBranch ?? 'main',
      durationMs: grantDuration,
    }).catch(() => ({
      ok: false as const,
      error: 'unavailable' as const,
      message: 'Managed merge is unavailable.',
    }));
    setMergeBusy(false);
    if (!result.ok) {
      setMergeError(result.message);
      return;
    }
    setGrantActivity(null);
  }, [coordinationProjects, grantActivity, grantDuration, mergeBusy, onGrantNextManagedMerge]);

  const renderGroup = (
    group: 'attention' | 'active' | 'recent',
    title: string,
    items: readonly AgentActivity[],
  ): JSX.Element | null => {
    if (items.length === 0) return null;
    return (
      <section className="agent-group" data-testid={`agent-group-${group}`}>
        {/* The count belongs in the heading: a queue you are meant to work
            through should say how deep it is before you read the first card. */}
        <h2 className={`status-section-title agent-group-title agent-group-title--${group}`}>
          {`${title} · ${numberFormatter.format(items.length)}`}
        </h2>
        {group === 'recent' && items.every((item) => !item.live) ? (
          // Ended work is a log. A live idle/unknown Agent remains a full card
          // so it can still be focused and, when ready, prompted.
          <ol className="agent-timeline">
            {items.map((item) => (
              <li className="agent-timeline-row" key={item.id}>
                <time
                  className="agent-timeline-time"
                  dateTime={new Date(item.updatedAt).toISOString()}
                >
                  {timeFormatter.format(new Date(item.updatedAt))}
                </time>
                <span className="agent-timeline-provider">{PROVIDER_LABEL[item.provider]}</span>
                <span className="agent-timeline-cwd" title={item.cwd}>{formatCwd(item.cwd)}</span>
                <span className={`agent-status agent-status--${item.status}`}>
                  {t(STATUS_LABEL_KEY[item.status])}
                </span>
              </li>
            ))}
          </ol>
        ) : (
        <div className="agent-list">
          {items.map((item) => (
            <article className="agent-row" data-status={item.status} key={item.id} data-testid="agent-row">
              {/* Identity and age on one line, the working directory on its own
                  as machine text, then the action. Reading order matches the
                  question being answered: who, where, what can I do. */}
              <div className="agent-row-main">
                <span className={`agent-status-dot agent-status-dot--${item.status}`} aria-hidden="true" />
                <span className="agent-provider">{PROVIDER_LABEL[item.provider]}</span>
                <span className={`agent-status agent-status--${item.status}`}>
                  {t(STATUS_LABEL_KEY[item.status])}
                </span>
                <time className="agent-age" dateTime={new Date(item.updatedAt).toISOString()}>
                  <AgentRelativeAge updatedAt={item.updatedAt} formatter={relativeTime} currentTime={currentTime} />
                </time>
              </div>
              <div className="agent-cwd" title={item.cwd}>
                {branches.get(item.cwd) ?? formatCwd(item.cwd)}
              </div>
              {item.participant && (
                <dl className="agent-participant" data-testid="agent-participant">
                  <div><dt>{t('agentHub.collaboration.alias')}</dt><dd>{item.participant.alias}</dd></div>
                  <div><dt>{t('agentHub.collaboration.role')}</dt><dd>{item.participant.role}</dd></div>
                  <div><dt>{t('agentHub.collaboration.task')}</dt><dd>{item.participant.task}</dd></div>
                </dl>
              )}
              {item.approval && (
                <div className="agent-approval" data-risk={item.approval.risk} data-testid="agent-approval">
                  <div className="agent-approval-head">
                    {/* Risk is spelled out as well as coloured: status must
                        never depend on colour alone (a11y hard gate). */}
                    <span className="agent-approval-risk">{t(RISK_LABEL_KEY[item.approval.risk])}</span>
                    <span className="agent-approval-tool">{item.approval.toolName}</span>
                    {item.approval.pending && (
                      <AgentApprovalCountdown expiresAt={item.approval.expiresAt} currentTime={currentTime} />
                    )}
                  </div>
                  {item.approval.command && (
                    <code className="agent-approval-command">{item.approval.command}</code>
                  )}
                  {!item.approval.pending ? (
                    <p className="agent-approval-expired" role="status">{t('agentHub.approvalExpired')}</p>
                  ) : (
                    <div className="agent-approval-actions">
                      <Button
                        variant="primary"
                        size="sm"
                        leadingIcon={<Check aria-hidden="true" />}
                        disabled={disconnected || !onDecideApproval}
                        loading={decidingId === item.id}
                        onClick={() => void decide(item, 'allow')}
                        data-testid="agent-approve"
                      >
                        {t('agentHub.approve')}
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        leadingIcon={<X aria-hidden="true" />}
                        disabled={disconnected || decidingId !== null || !onDecideApproval}
                        onClick={() => void decide(item, 'deny')}
                        data-testid="agent-deny"
                      >
                        {t('agentHub.deny')}
                      </Button>
                      {(onLoadDiff || onOpenProjectReview) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          leadingIcon={<GitCompareArrows aria-hidden="true" />}
                          onClick={() => void openDiff(item.cwd)}
                          data-testid="agent-view-diff"
                        >
                          {t('agentHub.viewDiff')}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className="agent-row-actions">
                <button
                  type="button"
                  className="btn btn-split agent-focus"
                  onClick={() => onFocusSession(item.sessionId)}
                  data-testid="agent-focus"
                >
                  {item.status === 'blocked' ? t('agentHub.review') : t('agentHub.focus')}
                </button>
                {item.live && item.provider !== 'generic' && onJoinCollaboration && (
                  <Button
                    variant="ghost"
                    size="sm"
                    leadingIcon={<Users aria-hidden="true" />}
                    onClick={() => openCollaboration(item)}
                    data-testid="agent-collaboration"
                  >
                    {item.participant
                      ? t('agentHub.collaboration.edit')
                      : t('agentHub.collaboration.join')}
                  </Button>
                )}
                {item.participant?.worktreeId && onRequestManagedMerge && (
                  <Button
                    variant="secondary"
                    size="sm"
                    leadingIcon={<GitMerge aria-hidden="true" />}
                    onClick={() => openMergeRequest(item)}
                    data-testid="agent-request-merge"
                  >
                    {t('agentHub.managedMerge.request')}
                  </Button>
                )}
                {item.participant?.worktreeId && onGrantNextManagedMerge && (
                  <Button
                    variant="ghost"
                    size="sm"
                    leadingIcon={<ShieldCheck aria-hidden="true" />}
                    onClick={() => {
                      setGrantActivity(item);
                      setMergeError(null);
                    }}
                    data-testid="agent-grant-next-merge"
                  >
                    {t('agentHub.managedMerge.grantNext')}
                  </Button>
                )}
              </div>
              {group === 'active' && (
                <div className="agent-progress">
                  <span className="agent-progress-track" aria-hidden="true">
                    <span className="agent-progress-sweep" />
                  </span>
                  <span className="agent-elapsed">
                    <AgentElapsed startedAt={item.createdAt} currentTime={currentTime} />
                  </span>
                </div>
              )}
              {(item.status === 'done' || item.status === 'idle') && item.live && (
                <AgentFollowupComposer
                  activityId={item.id}
                  providerLabel={PROVIDER_LABEL[item.provider]}
                  variant="desktop"
                  disconnected={disconnected}
                  sending={sendingId === item.id}
                  anotherSending={sendingId !== null && sendingId !== item.id}
                  onSend={send}
                />
              )}
              {errors[item.id] && (
                <div className="agent-followup-error" role="alert">{errors[item.id]}</div>
              )}
            </article>
          ))}
        </div>
        )}
      </section>
    );
  };

  const renderProjectHistory = (project: AgentProjectSummary): JSX.Element => {
    const sessions = projectSessions[project.projectId];
    const sessionsLoading = loadingSessionProjects.has(project.projectId);
    const sessionsFailed = projectSessionErrors.has(project.projectId);
    const nextCursor = projectSessionCursors[project.projectId];
    return (
      <section
        className="agent-project-history"
        data-testid="agent-project-history"
        aria-labelledby="agent-project-history-title"
      >
        <header className="agent-project-history__header">
          <IconButton
            icon={ArrowLeft}
            aria-label={t('common.back')}
            onClick={() => setHistoryProject(null)}
            data-testid="agent-project-history-back"
          />
          <div>
            <h2 id="agent-project-history-title">{t('agentHub.projects.sessionHistory')}</h2>
            <small title={project.primaryRoot}>{project.name}</small>
          </div>
        </header>
        <ol
          className="agent-history-list agent-project-history__list"
          aria-busy={sessionsLoading || undefined}
        >
          {!sessions && sessionsLoading && (
            <li className="agent-project-note">
              {t('agentHub.projects.sessionsLoading')}
            </li>
          )}
          {sessionsFailed && (
            <li className="agent-project-error">
              <span>{t('agentHub.projects.sessionsFailed')}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setProjectSessions((previous) => {
                    const next = { ...previous };
                    delete next[project.projectId];
                    return next;
                  });
                  void loadInitialProjectSessions(project.projectId);
                }}
              >
                {t('common.retry')}
              </Button>
            </li>
          )}
          {!sessionsFailed && sessions?.length === 0 && (
            <li className="agent-project-note">
              {t('agentHub.projects.sessionsEmpty')}
            </li>
          )}
          {sessions?.map((session) => (
            <li key={session.historyId} className="agent-history-item">
              <button
                type="button"
                className="agent-history-row"
                data-provider={session.provider}
                title={session.title}
                onClick={() => onOpenHistorySession?.(session, project)}
              >
                <span className="agent-provider-badge">
                  {PROVIDER_LABEL[session.provider]}
                </span>
                <strong>{session.title}</strong>
                <small>
                  <AgentRelativeAge updatedAt={session.updatedAt} formatter={relativeTime} currentTime={currentTime} />
                </small>
                {session.preview && <p>{session.preview}</p>}
              </button>
              {onOpenHistoryReview && (
                <button
                  type="button"
                  className="agent-history-review"
                  aria-label={`Review changes from ${session.title}`}
                  title={t('agentHub.viewDiff')}
                  onClick={() => onOpenHistoryReview(session, project)}
                >
                  <GitCompareArrows aria-hidden="true" size={15} />
                </button>
              )}
            </li>
          ))}
          {nextCursor && (
            <li>
              <button
                type="button"
                className="agent-history-more"
                disabled={sessionsLoading}
                onClick={() => void loadMoreSessions(project.projectId)}
              >
                {sessionsLoading
                  ? t('agentHub.projects.sessionsLoading')
                  : t('agentHub.projects.moreSessions')}
              </button>
            </li>
          )}
        </ol>
      </section>
    );
  };

  return (
    <div
      className={mobile
        ? 'mobile-agent-hub'
        : `status-drawer agent-hub${drillProject ? ' agent-hub--project' : ''}`}
      data-testid="agent-hub"
      aria-label={t('agentHub.activity')}
    >
      {/* On desktop the sidebar shell already draws the title and the close
          control, so a second header here would stack two of each. Mobile has
          no such shell and still needs its own. */}
      {mobile && (
        <header className="agent-hub-head">
          {onClose && (
            <IconButton
              icon={ArrowLeft}
              aria-label={t('agentHub.closeHub')}
              onClick={onClose}
              data-testid="mobile-agent-close"
            />
          )}
          <div>
            <h1 className="agent-hub-title">{t('rail.agents')}</h1>
            <span className="agent-hub-summary">
              {t('agentHub.tracked', { value: numberFormatter.format(snapshot.items.length) })}
            </span>
          </div>
        </header>
      )}
      {disconnected && <div className="agent-offline" role="status">{t('agentHub.reconnecting')}</div>}
      <div className="agent-live-region" aria-live="polite" aria-atomic="true">
        {groups.attention.length === 1
          ? t('agentHub.oneNeedsAttention')
          : groups.attention.length > 1
            ? t('agentHub.manyNeedAttention', {
              value: numberFormatter.format(groups.attention.length),
            })
            : ''}
      </div>
      <div className="agent-hub-body">
        {historyProject ? renderProjectHistory(historyProject) : drillProject && onOpenProjectDocument ? (
          <ProjectWorkspacePanel
            project={drillProject}
            onBack={() => selectDrillProject(null)}
            onOpenDocument={onOpenProjectDocument}
            onOpenProjectMap={onOpenProjectMap}
            onOpenTeam={window.ezterminalDesktop ? () => void openTeamProject(drillProject) : undefined}
            onNewSession={(target, locationLabel) => openLaunchPicker(
              drillProject,
              target,
              locationLabel,
            )}
            onManage={() => openProjectEditor(drillProject)}
            explorerState={projectWorkspaceState}
            onExplorerStateChange={onProjectWorkspaceStateChange}
          />
        ) : (
          <>
          {pendingMergeRequests.length > 0 && (
            <section className="agent-group agent-managed-merges" data-testid="managed-merge-requests">
              <h2 className="status-section-title agent-group-title agent-group-title--attention">
                {t('agentHub.managedMerge.queue', {
                  value: numberFormatter.format(pendingMergeRequests.length),
                })}
              </h2>
              <div className="agent-list">
                {pendingMergeRequests.map((request) => {
                  const activity = coordinatedActivities.find((item) => item.id === request.activityId);
                  return (
                    <article
                      className="agent-row agent-managed-merge"
                      key={request.requestId}
                      data-status={request.state}
                      data-testid="managed-merge-card"
                    >
                      <div className="agent-row-main">
                        <GitMerge aria-hidden="true" size={15} />
                        <span className="agent-provider">{activity?.participant?.alias ?? activity?.providerLabel ?? PROVIDER_LABEL[activity?.provider ?? 'generic']}</span>
                        <span className="agent-status">
                          {t(`agentHub.managedMerge.state.${request.state}`)}
                        </span>
                      </div>
                      <div className="agent-cwd">
                        <code>{request.sourceBranch}</code> → <code>{request.targetBranch}</code>
                      </div>
                      {request.validations.length > 0 && (
                        <ol className="agent-managed-merge-validations">
                          {request.validations.map((validation) => (
                            <li key={validation.id} data-status={validation.status}>
                              <span>{validation.name}</span>
                              <strong>{t(`agentHub.managedMerge.validation.${validation.status}`)}</strong>
                            </li>
                          ))}
                        </ol>
                      )}
                      {request.warning && <p className="agent-project-note">{request.warning}</p>}
                      <div className="agent-row-actions">
                        {request.candidateHead && onLoadManagedMergeDiff && (
                          <Button
                            variant="ghost"
                            size="sm"
                            leadingIcon={<GitCompareArrows aria-hidden="true" />}
                            onClick={() => void openManagedMergeDiff(request)}
                            data-testid="managed-merge-review"
                          >
                            {t('agentHub.review')}
                          </Button>
                        )}
                        {activity && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onFocusSession(activity.sessionId)}
                          >
                            {t('agentHub.managedMerge.openAgent')}
                          </Button>
                        )}
                        {request.state === 'approval-required' && (
                          <>
                            <Button
                              variant="primary"
                              size="sm"
                              disabled={mergeBusy || disconnected}
                              onClick={() => void decideMerge(request, 'approve')}
                              data-testid="managed-merge-approve"
                            >
                              {t('agentHub.approve')}
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={mergeBusy || disconnected}
                              onClick={() => void decideMerge(request, 'deny')}
                              data-testid="managed-merge-deny"
                            >
                              {t('agentHub.deny')}
                            </Button>
                          </>
                        )}
                        {request.state === 'override-required' && (
                          <>
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={mergeBusy || disconnected}
                              onClick={() => void decideMerge(request, 'deny')}
                            >
                              {t('agentHub.deny')}
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={mergeBusy || disconnected}
                              onClick={() => {
                                setOverrideRequest(request);
                                setOverrideReason('');
                                setMergeError(null);
                              }}
                              data-testid="managed-merge-override"
                            >
                              {t('agentHub.managedMerge.override')}
                            </Button>
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
              {mergeError && <p className="agent-project-error" role="alert">{mergeError}</p>}
            </section>
          )}
          {renderGroup('attention', t('agentHub.groups.attention'), groups.attention)}
          <section className="agent-group agent-projects" data-testid="agent-projects">
            <div className="agent-projects-heading">
              <h2 className="status-section-title agent-group-title">
                {t('agentHub.projects.title')}
              </h2>
              {window.ezterminalDesktop && (
                <IconButton
                  icon={FolderPlus}
                  aria-label={t('agentHub.projects.add')}
                  onClick={() => void addProject()}
                  data-testid="agent-add-project"
                />
              )}
            </div>
            <Field
              className="agent-project-search"
              label={t('agentHub.projects.searchLabel')}
              labelHidden
            >
              <span className="agent-project-search__control">
                <Search aria-hidden="true" />
                <DeferredSearchInput
                  variant="ui"
                  value={projectQuery}
                  placeholder={t('agentHub.projects.searchPlaceholder')}
                  onQueryChange={setProjectQuery}
                  testId="agent-project-search"
                />
              </span>
            </Field>
            {projectActionError && (
              <p className="agent-project-error" role="alert">{projectActionError}</p>
            )}
            {projectsLoading && (
              <p className="agent-project-note">{t('agentHub.projects.loading')}</p>
            )}
            {projectsError && (
              <div className="agent-project-error" role="alert">
                <span>{t('agentHub.projects.loadFailed')}</span>
                <Button variant="ghost" size="sm" onClick={() => void refreshProjects(true)}>
                  {t('common.retry')}
                </Button>
              </div>
            )}
            {!projectsLoading && !projectsError && projects.length === 0 && (
              <p className="agent-project-note">
                {debouncedProjectQuery.trim()
                  ? t('agentHub.projects.noMatches')
                  : t('agentHub.projects.empty')}
              </p>
            )}
            <ol className="agent-project-list">
              {projects.map((project) => {
                const coordination = coordinationProjects.get(project.projectId);
                const activeParticipants = coordination?.participants.length ?? 0;
                return (
                  <li className="agent-project" key={project.projectId}>
                    <div className="agent-project-row">
                      <button
                        type="button"
                        className="agent-project-open"
                        onClick={() => {
                          if (onOpenProjectDocument) selectDrillProject(project);
                        }}
                        data-testid={`agent-project-open-${project.projectId}`}
                      >
                        <span>
                          <strong>
                            {project.pinned && <Pin aria-hidden="true" />}
                            {project.name}
                          </strong>
                          <small title={[project.primaryRoot, ...project.additionalRoots].join('\n')}>
                            {formatCwd(project.primaryRoot)}
                            {project.additionalRoots.length > 0
                              ? ` · +${numberFormatter.format(project.additionalRoots.length)}`
                              : ''}
                          </small>
                        </span>
                        {project.sessionCount > 0 && (
                          <span className="agent-project-count">
                            {numberFormatter.format(project.sessionCount)}
                          </span>
                        )}
                      </button>
                      {(onLaunchAgent || onOpenProjectTerminal) && (
                        <Button
                          variant="secondary"
                          size="sm"
                          leadingIcon={<MessageSquarePlus aria-hidden="true" />}
                          onClick={() => openLaunchPicker(project)}
                          data-testid={`agent-project-new-chat-${project.projectId}`}
                        >
                          {t('agentHub.projects.newSession')}
                        </Button>
                      )}
                      <Menu
                        label={t('agentHub.projects.manage', { name: project.name })}
                        placement="bottom-end"
                        trigger={(
                          <IconButton
                            icon={MoreHorizontal}
                            aria-label={t('agentHub.projects.manage', { name: project.name })}
                          />
                        )}
                      >
                        <MenuItem
                          icon={History}
                          onSelect={() => openProjectHistory(project)}
                        >
                          {t('agentHub.projects.sessionHistory')}
                        </MenuItem>
                        <MenuItem
                          icon={Pin}
                          onSelect={() => void saveProject(project, { pinned: !project.pinned })}
                        >
                          {project.pinned
                            ? t('agentHub.projects.unpin')
                            : t('agentHub.projects.pin')}
                        </MenuItem>
                        {window.ezterminalDesktop && (
                          <MenuItem icon={Settings} onSelect={() => openProjectEditor(project)}>
                            {t('agentHub.projects.edit')}
                          </MenuItem>
                        )}
                        <MenuItem
                          icon={Trash2}
                          destructive
                          onSelect={() => {
                            setProjectActionError(null);
                            setProjectToDelete(project);
                          }}
                        >
                          {t('agentHub.projects.delete')}
                        </MenuItem>
                      </Menu>
                    </div>
                    {coordination ? (
                      <div className="agent-project-coordination" data-testid="agent-project-coordination">
                        <p>{coordination.goal}</p>
                        <span>
                          {t('agentHub.collaboration.projectRollup', {
                            participants: numberFormatter.format(activeParticipants),
                            merges: numberFormatter.format(coordination.pendingMergeCount),
                            branch: coordination.defaultTargetBranch,
                          })}
                        </span>
                        {onSaveCoordinationProject && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openCoordinationProject(project)}
                          >
                            {t('agentHub.collaboration.configure')}
                          </Button>
                        )}
                      </div>
                    ) : onSaveCoordinationProject ? (
                      <Button
                        className="agent-project-coordination-start"
                        variant="ghost"
                        size="sm"
                        leadingIcon={<Users aria-hidden="true" />}
                        onClick={() => openCoordinationProject(project)}
                      >
                        {t('agentHub.collaboration.configure')}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            {projectCursor && (
              <Button
                className="agent-projects-more"
                variant="ghost"
                size="sm"
                disabled={projectsLoadingMore}
                onClick={() => void refreshProjects(false, projectCursor, true)}
              >
                {projectsLoadingMore
                  ? t('agentHub.projects.loading')
                  : t('agentHub.projects.loadMore')}
              </Button>
            )}
          </section>
          {snapshot.items.length === 0 && (
            <div className="agent-empty">{t('agentHub.empty')}</div>
          )}
          {renderGroup('active', t('agentHub.groups.active'), groups.active)}
          {renderGroup('recent', t('agentHub.groups.recent'), groups.recent)}
          </>
        )}
      </div>
      {!drillProject && !historyProject && (onLaunchAgent || onOpenAgentSettings) && (
        <footer className="agent-hub-footer">
          {onLaunchAgent && (
            <Button
              variant="primary"
              size="sm"
              leadingIcon={<Plus aria-hidden="true" />}
              onClick={() => openLaunchPicker()}
              data-testid="agent-new-run"
            >
              {t('agentHub.newAgentRun')}
            </Button>
          )}
          {onOpenAgentSettings && (
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<Settings aria-hidden="true" />}
              onClick={onOpenAgentSettings}
              data-testid="agent-open-settings"
            >
              {t('agentHub.openAgentSettings')}
            </Button>
          )}
        </footer>
      )}
      <Dialog
        open={teamProject !== null}
        onOpenChange={(open) => { if (!open && !teamBusy) setTeamProject(null); }}
        title={t('agentTeams.runTitle', { project: teamProject?.name ?? '' })}
        description={activeTeamRun
          ? t('agentTeams.runDescriptionActive')
          : t('agentTeams.runDescription')}
        closeLabel={t('common.close')}
        dismissible={!teamBusy}
        size="lg"
        testId="agent-team-run-dialog"
        footer={coordinationProjects.get(teamProject?.projectId ?? '') === undefined ? (
          <>
            <Button variant="ghost" disabled={teamBusy} onClick={() => setTeamProject(null)}>{t('common.close')}</Button>
            {teamProject && onSaveCoordinationProject && (
              <Button
                variant="primary"
                onClick={() => {
                  const project = teamProject;
                  setTeamProject(null);
                  openCoordinationProject(project);
                }}
              >
                {t('agentTeams.configureProject')}
              </Button>
            )}
          </>
        ) : activeTeamRun ? (
          <>
            <Button variant="ghost" disabled={teamBusy} onClick={() => setTeamProject(null)}>{t('common.close')}</Button>
            <Button variant="danger" disabled={teamBusy} onClick={() => void decideTeamRun('cancel')}>{t('agentTeams.cancelRun')}</Button>
            {activeTeamRun.phase === 'awaiting-review' && (
              <Button variant="primary" loading={teamBusy} onClick={() => void approveTeamPlan()} data-testid="agent-team-approve-plan">
                {t('agentTeams.approveAndLaunch')}
              </Button>
            )}
            {(activeTeamRun.phase === 'active' || activeTeamRun.phase === 'partial') && (
              <Button variant="primary" loading={teamBusy} onClick={() => void decideTeamRun('complete')}>
                {t('agentTeams.completeRun')}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="ghost" disabled={teamBusy} onClick={() => setTeamProject(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              leadingIcon={<Play aria-hidden="true" />}
              loading={teamBusy}
              disabled={
                !selectedTeamId
                || !teamGoal.trim()
                || !validTeamRunCriteria(teamGoalCriteria)
                || selectedTeamUnavailable
                || teamBaseState === 'loading'
                || teamBaseState === 'unavailable'
                || (teamBaseState === 'dirty' && !teamWarningAcknowledged)
              }
              onClick={() => void startTeamRun()}
              data-testid="agent-team-start"
            >
              {t('agentTeams.startPlanner')}
            </Button>
          </>
        )}
      >
        {coordinationProjects.get(teamProject?.projectId ?? '') === undefined ? (
          <div className="agent-team-run-empty">
            <Users aria-hidden="true" />
            <p>{t('agentTeams.projectConfigRequired')}</p>
          </div>
        ) : activeTeamRun ? (
          <div className="agent-team-run">
            <div className="agent-team-run__status" data-phase={activeTeamRun.phase}>
              <strong>{activeTeamRun.team.name}</strong>
              <span>{t(`agentTeams.phase.${activeTeamRun.phase}`)}</span>
              <small>{t('agentTeams.targetBranch')}: {activeTeamRun.targetBranch}</small>
            </div>
            <section className="agent-team-run-goal-summary" aria-label={t('agentTeams.runGoalSummary')}>
              {activeTeamRun.projectGoal && (
                <div>
                  <strong>{t('agentTeams.projectPurpose')}</strong>
                  <p>{activeTeamRun.projectGoal}</p>
                </div>
              )}
              <div>
                <strong>{t('agentTeams.desiredOutcome')}</strong>
                <p>{activeTeamRun.goal}</p>
              </div>
              <div>
                <strong>{t('agentTeams.completionCriteria')}</strong>
                {activeTeamRun.goalAcceptanceCriteria ? (
                  <ul>
                    {activeTeamRun.goalAcceptanceCriteria.map((criterion, index) => (
                      <li key={`run-criterion-${String(index)}`}>{criterion}</li>
                    ))}
                  </ul>
                ) : <p>{t('agentTeams.legacyRunCriteria')}</p>}
              </div>
            </section>
            {activeTeamRun.phase === 'awaiting-review' && activeTeamRun.proposal && (
              <section className="agent-team-plan-review" data-testid="agent-team-plan-review">
                <h3>{t('agentTeams.proposedPlan')}</h3>
                <p>{activeTeamRun.proposal.summary}</p>
                <div className="agent-team-plan-list">
                  {activeTeamRun.proposal.assignments.map((assignment) => {
                    const persona = activeTeamRun.personas.find((candidate) => candidate.personaId === assignment.personaId);
                    return (
                      <article className="agent-team-plan-card" key={assignment.taskId}>
                        <div>
                          <strong>{assignment.title}</strong>
                          <span>{persona?.name ?? t('agentTeams.missingPersona')}</span>
                        </div>
                        <p>{assignment.outcome}</p>
                        <div className="agent-team-plan-card__brief">
                          <small>{t('agentTeams.assignmentInstructions')}</small>
                          <p>{assignment.brief}</p>
                        </div>
                        {assignment.scopeHints.length > 0 && (
                          <small>{t('agentTeams.scope')}: {assignment.scopeHints.join(' · ')}</small>
                        )}
                        {assignment.validationIds.length > 0 && (
                          <small>
                            {t('agentTeams.validations')}: {assignment.validationIds.map((validationId) => (
                              activeTeamRun.validationCommands.find((command) => command.id === validationId)?.name
                              ?? validationId
                            )).join(' · ')}
                          </small>
                        )}
                        <small>{t('agentTeams.acceptance')}</small>
                        <ul>
                          {assignment.acceptanceCriteria.map((criterion, index) => (
                            <li key={`${assignment.taskId}-criterion-${String(index)}`}>{criterion}</li>
                          ))}
                        </ul>
                      </article>
                    );
                  })}
                </div>
                {activeTeamRun.proposal.excludedMembers.length > 0 && (
                  <div className="agent-team-plan-excluded">
                    <strong>{t('agentTeams.notLaunching')}</strong>
                    {activeTeamRun.proposal.excludedMembers.map((excluded) => {
                      const persona = activeTeamRun.personas.find((candidate) => candidate.personaId === excluded.personaId);
                      return <span key={excluded.personaId}>{persona?.name}: {excluded.reason}</span>;
                    })}
                  </div>
                )}
              </section>
            )}
            {(activeTeamRun.phase === 'preparing-planner' || activeTeamRun.phase === 'planning') && (
              <p className="agent-team-run__notice">{t('agentTeams.plannerWorking')}</p>
            )}
            <section className="agent-team-run-members">
              <h3>{t('agentTeams.members')}</h3>
              {activeTeamRun.slots.map((slot) => {
                const persona = activeTeamRun.personas.find((candidate) => candidate.personaId === slot.personaId);
                const ActiveIcon = slot.state === 'active'
                  ? CheckCircle2
                  : slot.state === 'failed'
                    ? CircleAlert
                    : Play;
                return (
                  <article className="agent-team-run-member" data-state={slot.state} key={slot.personaId}>
                    <ActiveIcon aria-hidden="true" />
                    <div>
                      <strong>{persona?.name ?? t('agentTeams.missingPersona')}</strong>
                      <span>{t(`agentTeams.memberState.${slot.state}`)}</span>
                      {slot.error && <small>{slot.error}</small>}
                    </div>
                    {slot.state === 'failed' && (
                      <Button size="sm" variant="secondary" disabled={teamBusy} onClick={() => void retryTeamMember(slot.personaId)}>
                        {t('common.retry')}
                      </Button>
                    )}
                  </article>
                );
              })}
            </section>
            <p className="settings-hint">{t('agentTeams.endRunHint')}</p>
          </div>
        ) : (
          <div className="agent-team-run-form">
            <section className="agent-team-run-context" aria-label={t('agentTeams.projectContext')}>
              <div>
                <strong>{t('agentTeams.projectPurpose')}</strong>
                <span>{t('agentTeams.readOnlyContext')}</span>
              </div>
              <p>{coordinationProjects.get(teamProject?.projectId ?? '')?.goal}</p>
              <dl>
                <div>
                  <dt>{t('agentTeams.targetBranch')}</dt>
                  <dd>{coordinationProjects.get(teamProject?.projectId ?? '')?.defaultTargetBranch}</dd>
                </div>
                <div>
                  <dt>{t('agentTeams.linkedValidations')}</dt>
                  <dd>
                    {coordinationProjects.get(teamProject?.projectId ?? '')?.validationCommands.length
                      ? coordinationProjects.get(teamProject?.projectId ?? '')?.validationCommands.map((command) => command.name).join(' · ')
                      : t('agentTeams.noLinkedValidations')}
                  </dd>
                </div>
              </dl>
            </section>
            <Field label={t('agentTeams.team')} required>
              <Select value={selectedTeamId} onChange={(event) => {
                const teamId = event.currentTarget.value;
                const team = teamSnapshot.catalog.teams.find((candidate) => candidate.teamId === teamId);
                setSelectedTeamId(teamId);
                setTeamGoal(team?.defaultGoal?.outcome ?? '');
                setTeamGoalCriteria(team?.defaultGoal?.acceptanceCriteria ?? ['']);
              }}>
                <option value="">{t('agentTeams.chooseTeam')}</option>
                {teamSnapshot.catalog.teams.map((team) => (
                  <option key={team.teamId} value={team.teamId}>{team.name}</option>
                ))}
              </Select>
            </Field>
            {teamSnapshot.catalog.teams.length === 0 && (
              <p className="settings-agent-warning">{t('agentTeams.createTeamFirst')}</p>
            )}
            {selectedTeamUnavailable && (
              <p className="settings-agent-warning" role="alert">{t('agentTeams.enableHooksFirst')}</p>
            )}
            {selectedTeam?.defaultGoal && <p className="agent-team-run__notice">{t('agentTeams.defaultGoalCopied')}</p>}
            <Field label={t('agentTeams.desiredOutcome')} description={t('agentTeams.goalHint')} required>
              <textarea className="ui-textarea" rows={4} maxLength={2000} value={teamGoal} onChange={(event) => setTeamGoal(event.currentTarget.value)} />
            </Field>
            <fieldset className="agent-team-criteria-editor agent-team-run-criteria">
              <legend>{t('agentTeams.completionCriteria')}</legend>
              <p>{t('agentTeams.runCriteriaHint')}</p>
              {teamGoalCriteria.map((criterion, index) => (
                <div className="agent-team-criterion-row" key={index}>
                  <Input
                    aria-label={t('agentTeams.completionCriterionNumber', { number: index + 1 })}
                    value={criterion}
                    maxLength={500}
                    onChange={(event) => setTeamGoalCriteria(teamGoalCriteria.map((candidate, candidateIndex) => (
                      candidateIndex === index ? event.currentTarget.value : candidate
                    )))}
                  />
                  <IconButton
                    icon={X}
                    aria-label={t('agentTeams.removeCriterion', { number: index + 1 })}
                    disabled={teamGoalCriteria.length === 1}
                    onClick={() => setTeamGoalCriteria(teamGoalCriteria.filter((_, candidateIndex) => candidateIndex !== index))}
                  />
                </div>
              ))}
              <Button
                size="sm"
                variant="ghost"
                leadingIcon={<Plus />}
                disabled={teamGoalCriteria.length >= MAX_AGENT_TEAM_GOAL_CRITERIA}
                onClick={() => setTeamGoalCriteria([...teamGoalCriteria, ''])}
              >
                {t('agentTeams.addCriterion')}
              </Button>
            </fieldset>
            <details className="agent-team-editor__advanced">
              <summary>{t('agentTeams.advancedRunSettings')}</summary>
              <div className="agent-team-editor__advanced-body">
                <Field label={t('agentTeams.constraints')} description={t('agentTeams.constraintsHint')}>
                  <textarea className="ui-textarea" rows={3} maxLength={2000} value={teamConstraints} onChange={(event) => setTeamConstraints(event.currentTarget.value)} />
                </Field>
              </div>
            </details>
            {teamBaseState === 'loading' && <p className="agent-team-run__notice">{t('agentTeams.checkingGit')}</p>}
            {teamBaseState === 'unavailable' && <p className="settings-agent-warning" role="alert">{t('agentTeams.gitRequired')}</p>}
            {teamBaseState === 'clean' && <p className="agent-team-run__clean"><Check aria-hidden="true" />{t('agentTeams.cleanBase')}</p>}
            {teamBaseState === 'dirty' && (
              <label className="agent-team-run__warning">
                <input type="checkbox" checked={teamWarningAcknowledged} onChange={(event) => setTeamWarningAcknowledged(event.currentTarget.checked)} />
                <span>{t('agentTeams.dirtyBaseWarning')}</span>
              </label>
            )}
            <p className="settings-hint">{t('agentTeams.launchOrderHint')}</p>
          </div>
        )}
        {teamError && <p className="agent-project-error" role="alert">{teamError}</p>}
      </Dialog>
      <Dialog
        open={collaborationActivity !== null}
        onOpenChange={(open) => {
          if (!open && !collaborationBusy) {
            setCollaborationActivity(null);
            setCollaborationError(null);
          }
        }}
        title={collaborationActivity?.participant
          ? t('agentHub.collaboration.editTitle')
          : t('agentHub.collaboration.joinTitle')}
        description={t('agentHub.collaboration.joinDescription')}
        closeLabel={t('common.cancel')}
        testId="agent-collaboration-dialog"
        footer={(
          <>
            {collaborationActivity?.participant && onLeaveCollaboration && (
              <Button
                variant="danger"
                disabled={collaborationBusy}
                onClick={() => {
                  const activity = collaborationActivity;
                  setCollaborationActivity(null);
                  void leaveCollaboration(activity);
                }}
              >
                {t('agentHub.collaboration.leave')}
              </Button>
            )}
            <Button variant="ghost" disabled={collaborationBusy} onClick={() => setCollaborationActivity(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={collaborationBusy}
              disabled={!collaborationAlias.trim() || !collaborationRole.trim() || !collaborationTask.trim()}
              onClick={() => void joinCollaboration()}
              data-testid="agent-collaboration-submit"
            >
              {t('common.save')}
            </Button>
          </>
        )}
      >
        <div className="agent-coordination-form">
          <Field label={t('agentHub.collaboration.alias')} required>
            <Input value={collaborationAlias} maxLength={48} onChange={(event) => setCollaborationAlias(event.currentTarget.value)} />
          </Field>
          <Field label={t('agentHub.collaboration.role')} required>
            <Input value={collaborationRole} maxLength={120} onChange={(event) => setCollaborationRole(event.currentTarget.value)} />
          </Field>
          <Field label={t('agentHub.collaboration.task')} required>
            <textarea
              className="ui-textarea"
              value={collaborationTask}
              maxLength={1000}
              rows={5}
              onChange={(event) => setCollaborationTask(event.currentTarget.value)}
            />
          </Field>
          {collaborationError && <p className="agent-project-error" role="alert">{collaborationError}</p>}
        </div>
      </Dialog>
      <Dialog
        open={briefDraft !== null}
        onOpenChange={(open) => {
          if (!open && !collaborationBusy) {
            setBriefDraft(null);
            setCollaborationError(null);
          }
        }}
        title={t('agentHub.collaboration.briefTitle')}
        description={t('agentHub.collaboration.briefDescription')}
        closeLabel={t('common.close')}
        testId="agent-collaboration-brief"
        footer={(
          <>
            <Button
              variant="ghost"
              onClick={() => {
                const activity = coordinatedActivities.find((item) => item.id === briefDraft?.activityId);
                if (activity) onFocusSession(activity.sessionId);
              }}
            >
              {t('agentHub.focus')}
            </Button>
            <Button variant="ghost" disabled={collaborationBusy} onClick={() => setBriefDraft(null)}>
              {t('agentHub.collaboration.sendLater')}
            </Button>
            <Button
              variant="primary"
              loading={collaborationBusy}
              disabled={!briefDraft?.text.trim()}
              onClick={() => void sendBrief()}
              data-testid="agent-collaboration-send-brief"
            >
              {t('agentHub.send')}
            </Button>
          </>
        )}
      >
        <textarea
          className="ui-textarea agent-coordination-brief"
          value={briefDraft?.text ?? ''}
          rows={12}
          onChange={(event) => setBriefDraft((current) => current
            ? { ...current, text: event.currentTarget.value }
            : current)}
        />
        {collaborationError && <p className="agent-project-error" role="alert">{collaborationError}</p>}
      </Dialog>
      <Dialog
        open={coordinationProject !== null}
        onOpenChange={(open) => {
          if (!open && !coordinationSaving) setCoordinationProject(null);
        }}
        title={t('agentHub.collaboration.projectTitle', { name: coordinationProject?.name ?? '' })}
        description={t('agentHub.collaboration.projectDescription')}
        closeLabel={t('common.cancel')}
        size="lg"
        testId="agent-coordination-project-dialog"
        footer={(
          <>
            <Button variant="ghost" disabled={coordinationSaving} onClick={() => setCoordinationProject(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={coordinationSaving}
              disabled={!coordinationGoal.trim() || !coordinationTarget.trim()
                || coordinationValidations.some((item) => !item.name.trim() || !item.command.trim())}
              onClick={() => void saveCoordinationProject()}
              data-testid="agent-coordination-project-save"
            >
              {t('common.save')}
            </Button>
          </>
        )}
      >
        <div className="agent-coordination-form">
          <Field label={t('agentHub.collaboration.goal')} required>
            <textarea
              className="ui-textarea"
              value={coordinationGoal}
              rows={4}
              maxLength={2000}
              onChange={(event) => setCoordinationGoal(event.currentTarget.value)}
            />
          </Field>
          <Field label={t('agentHub.collaboration.targetBranch')} required>
            <Input value={coordinationTarget} maxLength={200} onChange={(event) => setCoordinationTarget(event.currentTarget.value)} />
          </Field>
          <section className="agent-validation-editor">
            <div className="agent-validation-editor__head">
              <h3>{t('agentHub.collaboration.validations')}</h3>
              <Button
                variant="secondary"
                size="sm"
                disabled={coordinationValidations.length >= 8}
                onClick={() => setCoordinationValidations((current) => [...current, {
                  id: globalThis.crypto?.randomUUID?.() ?? `validation-${Date.now()}-${current.length}`,
                  name: '',
                  command: '',
                  timeoutMs: 300000,
                }])}
              >
                {t('agentHub.collaboration.addValidation')}
              </Button>
            </div>
            {coordinationValidations.map((validation, index) => (
              <fieldset className="agent-validation-row" key={validation.id}>
                <legend>{t('agentHub.collaboration.validationNumber', { value: index + 1 })}</legend>
                <Field label={t('agentHub.collaboration.validationName')} required>
                  <Input
                    value={validation.name}
                    maxLength={120}
                    onChange={(event) => setCoordinationValidations((current) => current.map((item) => (
                      item.id === validation.id ? { ...item, name: event.currentTarget.value } : item
                    )))}
                  />
                </Field>
                <Field label={t('agentHub.collaboration.validationCommand')} required>
                  <textarea
                    className="ui-textarea"
                    value={validation.command}
                    rows={3}
                    maxLength={8192}
                    onChange={(event) => setCoordinationValidations((current) => current.map((item) => (
                      item.id === validation.id ? { ...item, command: event.currentTarget.value } : item
                    )))}
                  />
                </Field>
                <Field label={t('agentHub.collaboration.validationTimeout')}>
                  <Input
                    type="number"
                    min={1}
                    max={1800}
                    value={Math.round(validation.timeoutMs / 1000)}
                    onChange={(event) => setCoordinationValidations((current) => current.map((item) => (
                      item.id === validation.id
                        ? { ...item, timeoutMs: Number(event.currentTarget.value) * 1000 }
                        : item
                    )))}
                  />
                </Field>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => setCoordinationValidations((current) => current.filter((item) => item.id !== validation.id))}
                >
                  {t('common.remove')}
                </Button>
              </fieldset>
            ))}
          </section>
          {coordinationError && <p className="agent-project-error" role="alert">{coordinationError}</p>}
        </div>
      </Dialog>
      <Dialog
        open={mergeActivity !== null}
        onOpenChange={(open) => {
          if (!open && !mergeBusy) setMergeActivity(null);
        }}
        title={t('agentHub.managedMerge.requestTitle')}
        description={t('agentHub.managedMerge.requestDescription')}
        closeLabel={t('common.cancel')}
        testId="managed-merge-request-dialog"
        footer={(
          <>
            <Button variant="ghost" disabled={mergeBusy} onClick={() => setMergeActivity(null)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={mergeBusy}
              disabled={!mergeTargetBranch.trim()}
              onClick={() => void requestMerge()}
            >
              {t('agentHub.managedMerge.request')}
            </Button>
          </>
        )}
      >
        <Field label={t('agentHub.collaboration.targetBranch')} required>
          <Input value={mergeTargetBranch} maxLength={200} onChange={(event) => setMergeTargetBranch(event.currentTarget.value)} />
        </Field>
        {mergeError && <p className="agent-project-error" role="alert">{mergeError}</p>}
      </Dialog>
      <Dialog
        open={grantActivity !== null}
        onOpenChange={(open) => {
          if (!open && !mergeBusy) setGrantActivity(null);
        }}
        title={t('agentHub.managedMerge.grantTitle')}
        description={t('agentHub.managedMerge.grantDescription')}
        closeLabel={t('common.cancel')}
        testId="managed-merge-grant-dialog"
        footer={(
          <>
            <Button variant="ghost" disabled={mergeBusy} onClick={() => setGrantActivity(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={mergeBusy} onClick={() => void grantNextMerge()}>
              {t('agentHub.managedMerge.grantNext')}
            </Button>
          </>
        )}
      >
        <Field label={t('agentHub.managedMerge.grantDuration')}>
          <Select value={String(grantDuration)} onChange={(event) => setGrantDuration(Number(event.currentTarget.value) as ManagedMergeGrantInput['durationMs'])}>
            <option value="900000">15 min</option>
            <option value="3600000">1 h</option>
            <option value="14400000">4 h</option>
          </Select>
        </Field>
        <p className="agent-project-note">{t('agentHub.managedMerge.grantScope')}</p>
        {mergeError && <p className="agent-project-error" role="alert">{mergeError}</p>}
      </Dialog>
      <Dialog
        open={overrideRequest !== null}
        onOpenChange={(open) => {
          if (!open && !mergeBusy) setOverrideRequest(null);
        }}
        title={t('agentHub.managedMerge.overrideTitle')}
        description={t('agentHub.managedMerge.overrideDescription')}
        role="alertdialog"
        tone="danger"
        closeLabel={t('common.cancel')}
        testId="managed-merge-override-dialog"
        footer={(
          <>
            <Button variant="ghost" disabled={mergeBusy} onClick={() => setOverrideRequest(null)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              loading={mergeBusy}
              disabled={overrideReason.trim().length < 8}
              onClick={() => {
                if (overrideRequest) void decideMerge(overrideRequest, 'approve', overrideReason.trim());
              }}
              data-testid="managed-merge-override-confirm"
            >
              {t('agentHub.managedMerge.overrideConfirm')}
            </Button>
          </>
        )}
      >
        <Field label={t('agentHub.managedMerge.overrideReason')} required>
          <textarea
            className="ui-textarea"
            value={overrideReason}
            rows={5}
            maxLength={500}
            onChange={(event) => setOverrideReason(event.currentTarget.value)}
          />
        </Field>
        {mergeError && <p className="agent-project-error" role="alert">{mergeError}</p>}
      </Dialog>
      <Dialog
        open={launchPickerOpen}
        onOpenChange={(open) => {
          if (launching) return;
          setLaunchPickerOpen(open);
          if (!open) setLaunchError(null);
        }}
        title={launchProjectSession
          ? t('agentHub.projects.sessionTitle')
          : t('agentHub.projects.launchTitle')}
        description={launchProjectSession
          ? t('agentHub.projects.sessionDescription')
          : t('agentHub.projects.launchDescription')}
        closeLabel={t('common.cancel')}
        testId="agent-launch-picker"
        footer={(
          <>
            <Button
              variant="ghost"
              onClick={() => setLaunchPickerOpen(false)}
              disabled={launching}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void launchAgent()}
              disabled={launching
                || !launchTarget
                || (launchSessionType === 'agent' && (!onLaunchAgent || !selectedLauncherId))
                || (launchSessionType === 'agent'
                  && launchWorkspaceMode === 'managed'
                  && launchTarget?.kind === 'project'
                  && !launchTarget.rootId
                  && !isSafeLocalBranch(launchWorktreeBranch.trim()))
                || (launchSessionType === 'terminal' && !onOpenProjectTerminal)}
              data-testid="agent-launch-submit"
            >
              {launching
                ? t('agentHub.projects.launching')
                : launchSessionType === 'terminal'
                  ? t('agentHub.projects.openTerminal')
                  : t('agentHub.projects.launch')}
            </Button>
          </>
        )}
      >
        <div className="agent-launch-picker">
          {launchProjectSession && (
            <Field label={t('agentHub.projects.sessionType')} required>
              <Select
                value={launchSessionType}
                onChange={(event) => {
                  setLaunchSessionType(event.currentTarget.value as 'agent' | 'terminal');
                  setLaunchError(null);
                }}
                data-testid="agent-launch-session-type"
              >
                <option value="agent">{t('agentHub.projects.sessionTypeAgent')}</option>
                <option value="terminal">{t('agentHub.projects.sessionTypeTerminal')}</option>
              </Select>
            </Field>
          )}
          {launchSessionType === 'agent' && (
            <Field label={t('agentHub.projects.agent')} required>
            <Select
              value={selectedLauncherId}
              onChange={(event) => {
                setSelectedLauncherId(event.currentTarget.value);
                setLaunchError(null);
              }}
              disabled={launchersLoading}
              data-testid="agent-launch-agent"
            >
              <option value="">
                {launchersLoading
                  ? t('agentHub.projects.loadingAgents')
                  : t('agentHub.projects.selectAgent')}
              </option>
              {launchers.map((launcher) => (
                <option key={launcher.launcherId} value={launcher.launcherId}>
                  {launcher.name} · {PROVIDER_LABEL[launcher.provider]}
                </option>
              ))}
            </Select>
            </Field>
          )}
          {launchSessionType === 'agent' && !launchersLoading && launchers.length === 0 && (
            <p className="agent-project-note">{t('agentHub.projects.noAgents')}</p>
          )}
          {launchProjectSession ? (
            <Field label={t('agentHub.projects.location')} required>
              <p className="agent-launch-directory" title={launchLocationLabel}>
                <strong>{launchProjectSession.projectName}</strong>
                <code>{formatCwd(launchLocationLabel)}</code>
              </p>
            </Field>
          ) : (
            <>
          <Field label={t('agentHub.projects.location')} required>
            <DeferredSearchInput
              variant="ui"
              value={launchProjectQuery}
              placeholder={t('agentHub.projects.locationSearch')}
              onQueryChange={setLaunchProjectQuery}
            />
            <Select
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
              data-testid="agent-launch-project"
            >
              <option value="">
                {launchProjectsLoading
                  ? t('agentHub.projects.loading')
                  : t('agentHub.projects.selectProject')}
              </option>
              {launchTarget?.kind === 'directory' && (
                <option value="__directory__">
                  {t('agentHub.projects.selectedFolder')} · {formatCwd(launchTarget.directory)}
                </option>
              )}
              {launchProjectOptions.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.name} · {formatCwd(project.primaryRoot)}
                </option>
              ))}
            </Select>
          </Field>
          {window.ezterminalDesktop && (
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<FolderPlus aria-hidden="true" />}
              onClick={() => void chooseLaunchDirectory()}
              data-testid="agent-launch-folder"
            >
              {t('agentHub.projects.chooseFolder')}
            </Button>
          )}
          {launchTarget?.kind === 'directory' && (
            <p className="agent-launch-directory" title={launchTarget.directory}>
              <strong>{t('agentHub.projects.selectedFolder')}</strong>
              <code>{launchTarget.directory}</code>
            </p>
          )}
            </>
          )}
          {launchSessionType === 'agent'
            && launchTarget?.kind === 'project'
            && !launchTarget.rootId
            && launchTargetProject && (
            <fieldset className="agent-launch-workspace">
              <legend>{t('agentHub.projects.workspaceMode')}</legend>
              <label>
                <input
                  type="radio"
                  name="agent-launch-workspace"
                  value="current"
                  checked={launchWorkspaceMode === 'current'}
                  onChange={() => setLaunchWorkspaceMode('current')}
                />
                <span>
                  <strong>{t('agentHub.projects.workspaceCurrent')}</strong>
                  <small>{t('agentHub.projects.workspaceCurrentHint')}</small>
                </span>
              </label>
              <label>
                <input
                  type="radio"
                  name="agent-launch-workspace"
                  value="managed"
                  checked={launchWorkspaceMode === 'managed'}
                  onChange={() => setLaunchWorkspaceMode('managed')}
                />
                <span>
                  <strong>{t('agentHub.projects.workspaceManaged')}</strong>
                  <small>{t('agentHub.projects.workspaceManagedHint')}</small>
                </span>
              </label>
              {launchWorkspaceMode === 'managed' && (
                <Field label={t('agentHub.projects.worktreeBranch')} required>
                  <Input
                    value={launchWorktreeBranch}
                    maxLength={200}
                    aria-invalid={!isSafeLocalBranch(launchWorktreeBranch.trim()) || undefined}
                    onChange={(event) => setLaunchWorktreeBranch(event.currentTarget.value)}
                    data-testid="agent-launch-worktree-branch"
                  />
                </Field>
              )}
            </fieldset>
          )}
          {launchSessionType === 'agent' && ignoredAdditionalRoots > 0 && (
            <p className="agent-launch-warning" role="status">
              {t('agentHub.projects.genericRootsIgnored', {
                value: numberFormatter.format(ignoredAdditionalRoots),
              })}
            </p>
          )}
          {launchError && (
            <p className="agent-project-error" role="alert">{launchError}</p>
          )}
        </div>
      </Dialog>
      <Dialog
        open={projectEditorOpen}
        onOpenChange={(open) => {
          if (projectSaving) return;
          setProjectEditorOpen(open);
          if (!open) setProjectActionError(null);
        }}
        title={editingProject
          ? t('agentHub.projects.editorEditTitle')
          : t('agentHub.projects.editorAddTitle')}
        closeLabel={t('common.cancel')}
        testId="agent-project-editor"
        footer={(
          <>
            <Button
              variant="ghost"
              onClick={() => setProjectEditorOpen(false)}
              disabled={projectSaving}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void commitProjectEditor()}
              disabled={projectSaving || !projectNameDraft.trim() || projectRootsDraft.length === 0}
              data-testid="agent-project-save"
            >
              {projectSaving ? t('agentHub.projects.saving') : t('common.save')}
            </Button>
          </>
        )}
      >
        <div className="agent-project-editor">
          <Field label={t('agentHub.projects.name')} required>
            <Input
              value={projectNameDraft}
              onChange={(event) => setProjectNameDraft(event.currentTarget.value)}
              autoComplete="off"
              data-testid="agent-project-name"
            />
          </Field>
          <div className="agent-project-roots">
            <span className="agent-project-roots__label">{t('agentHub.projects.roots')}</span>
            {projectRootsDraft.length === 0 && (
              <p className="agent-project-error" role="alert">
                {t('agentHub.projects.selectPrimary')}
              </p>
            )}
            <ol>
              {projectRootsDraft.map((root, index) => (
                <li key={root}>
                  <div>
                    <strong>
                      {index === 0 ? t('agentHub.projects.primary') : `+${index}`}
                    </strong>
                    <span title={root}>{root}</span>
                  </div>
                  {index > 0 && (
                    <div className="agent-project-root-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setProjectRootsDraft((previous) => [
                            root,
                            ...previous.filter((candidate) => candidate !== root),
                          ]);
                        }}
                      >
                        {t('agentHub.projects.setPrimary')}
                      </Button>
                      <IconButton
                        icon={X}
                        aria-label={`${t('agentHub.projects.removeFolder')}: ${root}`}
                        onClick={() => {
                          setProjectRootsDraft((previous) => (
                            previous.filter((candidate) => candidate !== root)
                          ));
                        }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ol>
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<FolderPlus aria-hidden="true" />}
              onClick={() => void addProjectFolders()}
            >
              {t('agentHub.projects.addFolder')}
            </Button>
          </div>
          {projectActionError && (
            <p className="agent-project-error" role="alert">{projectActionError}</p>
          )}
        </div>
      </Dialog>
      <Dialog
        open={projectToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setProjectToDelete(null);
        }}
        title={t('agentHub.projects.deleteTitle', { name: projectToDelete?.name ?? '' })}
        description={t('agentHub.projects.deleteDescription')}
        role="alertdialog"
        tone="danger"
        size="sm"
        closeLabel={t('common.cancel')}
        testId="agent-project-delete"
        footer={(
          <>
            <Button variant="ghost" onClick={() => setProjectToDelete(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => void removeProject()}>
              {t('agentHub.projects.deleteConfirm')}
            </Button>
          </>
        )}
      >
        {projectActionError && (
          <p className="agent-project-error" role="alert">{projectActionError}</p>
        )}
      </Dialog>
      <Dialog
        open={diffView !== null}
        onOpenChange={(next) => {
          if (!next) {
            diffRequestGeneration.current += 1;
            setDiffView(null);
          }
        }}
        title={t('agentHub.diffTitle')}
        size="lg"
        closeLabel={t('agentHub.diffClose')}
        testId="agent-diff-dialog"
      >
        {diffView?.state === 'loading' && <p className="agent-diff-note">{t('agentHub.diffTitle')}…</p>}
        {diffView?.state === 'error' && <p className="agent-diff-note" role="alert">{diffView.message}</p>}
        {diffView?.state === 'ready' && (
          <>
            {diffView.text.trim().length > 0 && (
              <pre className="agent-diff" data-testid="agent-diff-text">{diffView.text}</pre>
            )}
            {diffView.text.trim().length === 0
              && !diffView.truncated
              && diffView.omissions.length === 0 && (
              <p className="agent-diff-note">{t('agentHub.diffEmpty')}</p>
            )}
            {diffView.truncated && (
              <p className="agent-diff-note" role="status">{t('agentHub.diffTruncated')}</p>
            )}
            {diffView.omissions.length > 0 && (
              <ul className="agent-diff-omissions" data-testid="agent-diff-omissions">
                {diffView.omissions.map((omission) => (
                  <li key={`${omission.path}\0${omission.reason}`}>
                    <code>{omission.path}</code>
                    {' — '}
                    {t(`agentHub.diffOmissionReason.${omission.reason}`)}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Dialog>
    </div>
  );
}
