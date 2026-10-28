import { Glyph } from './ui/Glyph';
import { AppChatInbox } from './AppChatInbox';
import type { AppChatInboxEntry } from '../shared/app-chat-inbox';
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
  type ManagedMergeDecisionInput,
  type ManagedMergeRequest,
} from '../shared/agent-coordination';
import {
  EMPTY_AGENT_ORCHESTRATION_SNAPSHOT,
  orchestrationWorkerActivityIds,
  type AgentOrchestrationSnapshot,
} from '../shared/agent-orchestration';
import type { AgentProjectSummary } from '../shared/agent-history';
import type { DaemonAuthorityAvailability } from '../shared/daemon-authority';
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
import { AgentApprovalCountdown, AgentRelativeAge } from './AgentTime';
import { rendererCapabilities, type DaemonAccess } from './capability-access';
import { DaemonSafeModeNotice } from './DaemonSafeModeNotice';
import { findAgentProject } from './ProjectDialogs';
import {
  Button,
  Dialog,
  Field,
} from './ui';

/** Used when no Git reader is supplied; every row then shows its directory. */
const readNothing = (): Promise<GitDirectoryStatus> => Promise.resolve(EMPTY_GIT_DIRECTORY_STATUS);

const ATTENTION = new Set<AgentStatus>(['blocked', 'error', 'done']);

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

export interface AgentHubProps {
  /**
   * `inbox`: what asks for the person. `files`: the active project's files and workspaces only
   * (projects are managed in the shell's dialogs).
   */
  readonly view?: 'inbox' | 'files';
  /** App conversations that need the person: shown at the top of the inbox. */
  readonly appChatInbox?: {
    readonly entries: readonly AppChatInboxEntry[];
    readonly onOpen: (entry: AppChatInboxEntry) => void;
    readonly onMarkSeen: (entry: AppChatInboxEntry) => void;
  };
  readonly snapshot: AgentActivitySnapshot;
  readonly coordinationSnapshot?: AgentCoordinationSnapshot;
  readonly orchestrationSnapshot?: AgentOrchestrationSnapshot;
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
  /** The project whose files the drill-in shows. */
  readonly activeProjectId?: string | null;
  readonly onActiveProjectIdChange?: (projectId: string | null) => void;
  /** Controlled explorer state, suitable for restoration across sidebar remounts. */
  readonly projectWorkspaceState?: ProjectExplorerState;
  readonly onProjectWorkspaceStateChange?: (state: ProjectExplorerState) => void;
  /** Opens a normal structured Agent draft tab. No daemon session exists yet. */
  readonly onOpenStructuredAgentDraft?: (
    project?: AgentProjectSummary,
    target?: ProjectSessionTarget,
    locationLabel?: string,
  ) => void;
  /** Injectable seam for deterministic component stories and tests. */
  readonly daemonAgentSessionAccess?: Pick<DaemonAccess, 'getAvailability'>;
  readonly onOpenProjectTerminal?: (projectSession: ProjectSessionPanelMetadata) => void;
  /** The project's settings open in the shell's project dialog. */
  readonly onEditProject?: (project: AgentProjectSummary) => void;
  readonly onDecideManagedMerge?: (
    input: ManagedMergeDecisionInput,
  ) => Promise<AgentCoordinationMutationResult<ManagedMergeRequest>>;
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
  view = 'inbox',
  appChatInbox,
  snapshot,
  coordinationSnapshot = EMPTY_AGENT_COORDINATION_SNAPSHOT,
  orchestrationSnapshot = EMPTY_AGENT_ORCHESTRATION_SNAPSHOT,
  onFocusSession,
  onSendFollowup,
  onDecideApproval,
  onLoadDiff,
  onOpenProjectReview,
  onLoadManagedMergeDiff,
  onReadGitStatus,
  onOpenProjectDocument,
  onOpenProjectMap,
  activeProjectId,
  onActiveProjectIdChange,
  projectWorkspaceState,
  onProjectWorkspaceStateChange,
  onOpenStructuredAgentDraft,
  daemonAgentSessionAccess,
  onOpenProjectTerminal,
  onEditProject,
  onDecideManagedMerge,
  currentTime,
}: AgentHubProps): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [daemonAvailability, setDaemonAvailability] = useState<DaemonAuthorityAvailability | null>();
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [diffView, setDiffView] = useState<DiffView | null>(null);
  const [projects, setProjects] = useState<readonly AgentProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  // The files view's project when the loaded list page does not hold it.
  const [drillLookup, setDrillLookup] = useState<{ readonly projectId: string; readonly project: AgentProjectSummary | null } | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [overrideRequest, setOverrideRequest] = useState<ManagedMergeRequest | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const daemonAccess = daemonAgentSessionAccess ?? rendererCapabilities.daemon;

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(() => daemonAccess.getAvailability())
      .then((next) => {
        if (!cancelled) setDaemonAvailability(next);
      })
      .catch(() => {
        if (!cancelled) setDaemonAvailability(null);
      });
    return () => { cancelled = true; };
  }, [daemonAccess]);

  const diffRequestGeneration = useRef(0);
  const allCoordinatedActivities = useMemo(() => {
    const enriched = new Map(coordinationSnapshot.activities.map((item) => [item.id, item]));
    return snapshot.items.map((item) => enriched.get(item.id) ?? item);
  }, [coordinationSnapshot.activities, snapshot.items]);
  const workerActivityIds = useMemo(
    () => orchestrationWorkerActivityIds(orchestrationSnapshot),
    [orchestrationSnapshot],
  );
  const coordinatedActivities = useMemo(
    () => allCoordinatedActivities.filter((item) => !workerActivityIds.has(item.id)),
    [allCoordinatedActivities, workerActivityIds],
  );
  const pendingMergeRequests = useMemo(() => coordinationSnapshot.mergeRequests.filter((request) => (
    ['preparing', 'validating', 'approval-required', 'override-required', 'merging'].includes(request.state)
  )), [coordinationSnapshot.mergeRequests]);
  const branches = useGitBranches(
    coordinatedActivities.map((item) => item.cwd),
    onReadGitStatus ?? readNothing,
  );
  const listedDrillProject = activeProjectId
    ? projects.find((project) => project.projectId === activeProjectId) ?? null
    : null;
  const drillProject = activeProjectId
    ? listedDrillProject ?? (drillLookup?.projectId === activeProjectId ? drillLookup.project : null)
    : null;
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const relativeTime = useMemo(
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' }),
    [locale],
  );
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  // The first page of projects, where the files view's project usually is.
  useEffect(() => {
    const read = window.ezterminal?.listAgentProjects;
    if (!read) {
      setProjectsLoading(false);
      return undefined;
    }
    let alive = true;
    void read(false, undefined, 40)
      .catch(() => null)
      .then((result) => {
        if (!alive) return;
        setProjectsLoading(false);
        if (result) setProjects(result.items);
      });
    return () => { alive = false; };
  }, []);

  // The files view of a project past the loaded page reads it on its own.
  useEffect(() => {
    if (!activeProjectId || listedDrillProject || projectsLoading || drillLookup?.projectId === activeProjectId) return undefined;
    const read = window.ezterminal?.listAgentProjects;
    if (!read) return undefined;
    let alive = true;
    void findAgentProject(read, activeProjectId)
      .catch(() => null)
      .then((project) => { if (alive) setDrillLookup({ projectId: activeProjectId, project }); });
    return () => { alive = false; };
  }, [activeProjectId, listedDrillProject, projectsLoading, drillLookup]);

  const attention = useMemo(() => coordinatedActivities
    .filter((item) => ATTENTION.has(item.status))
    .sort((a, b) => {
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
    }), [coordinatedActivities]);

  // A pending approval needs the fast tick for its display countdown.
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

  const renderAttention = (): JSX.Element | null => {
    if (attention.length === 0) return null;
    return (
      <section className="agent-group" data-testid="agent-group-attention">
        {/* The count belongs in the heading: a queue you are meant to work
            through should say how deep it is before you read the first card. */}
        <h2 className="status-section-title agent-group-title agent-group-title--attention">
          {`${t('agentHub.groups.attention')} · ${numberFormatter.format(attention.length)}`}
        </h2>
        <div className="agent-list">
          {attention.map((item) => (
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
                        leadingIcon={<Glyph name="check" />}
                        disabled={!onDecideApproval}
                        loading={decidingId === item.id}
                        onClick={() => void decide(item, 'allow')}
                        data-testid="agent-approve"
                      >
                        {t('agentHub.approve')}
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        leadingIcon={<Glyph name="x" />}
                        disabled={decidingId !== null || !onDecideApproval}
                        onClick={() => void decide(item, 'deny')}
                        data-testid="agent-deny"
                      >
                        {t('agentHub.deny')}
                      </Button>
                      {(onLoadDiff || onOpenProjectReview) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          leadingIcon={<Glyph name="diff" />}
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
              </div>
              {item.status === 'done' && item.live && (
                <AgentFollowupComposer
                  activityId={item.id}
                  providerLabel={PROVIDER_LABEL[item.provider]}
                  variant="desktop"
                  disconnected={false}
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
      </section>
    );
  };

  return (
    <div
      className={`status-drawer agent-hub${drillProject ? ' agent-hub--project' : ''}`}
      data-testid="agent-hub"
      aria-label={t('agentHub.activity')}
    >
      <div className="agent-live-region" aria-live="polite" aria-atomic="true">
        {attention.length === 1
          ? t('agentHub.oneNeedsAttention')
          : attention.length > 1
            ? t('agentHub.manyNeedAttention', {
              value: numberFormatter.format(attention.length),
            })
            : ''}
      </div>
      <div className="agent-hub-body">
        {daemonAvailability?.state === 'legacy-only-safe-mode' && (
          <DaemonSafeModeNotice
            availability={daemonAvailability}
            showRecoveryPath
            compact
          />
        )}
        {drillProject && onOpenProjectDocument ? (
          <ProjectWorkspacePanel
            project={drillProject}
            {...(view === 'files' ? {} : { onBack: () => onActiveProjectIdChange?.(null) })}
            onOpenDocument={onOpenProjectDocument}
            onOpenProjectMap={onOpenProjectMap}
            onNewSession={(target) => {
              onOpenProjectTerminal?.({ ...target, projectName: drillProject.name, titleMode: 'generated' });
            }}
            onNewAgent={onOpenStructuredAgentDraft ? (target, locationLabel) => onOpenStructuredAgentDraft(drillProject, target, locationLabel) : undefined}
            onManage={() => onEditProject?.(drillProject)}
            explorerState={projectWorkspaceState}
            onExplorerStateChange={onProjectWorkspaceStateChange}
          />
        ) : view === 'files' ? (
          <p className="agent-project-note" role="status" data-testid="agent-files-unavailable">
            {activeProjectId && drillLookup?.projectId !== activeProjectId
              ? t('agentHub.projects.loading')
              : t('agentHub.projects.loadFailed')}
          </p>
        ) : (
          <>
          {appChatInbox && (
            <AppChatInbox items={appChatInbox.entries} onOpen={appChatInbox.onOpen} onMarkSeen={appChatInbox.onMarkSeen} />
          )}
          {pendingMergeRequests.length > 0 && (
            <section className="agent-group agent-managed-merges" data-testid="managed-merge-requests">
              <h2 className="status-section-title agent-group-title agent-group-title--attention">
                {t('agentHub.managedMerge.queue', {
                  value: numberFormatter.format(pendingMergeRequests.length),
                })}
              </h2>
              <div className="agent-list">
                {pendingMergeRequests.map((request) => {
                  const activity = allCoordinatedActivities.find((item) => item.id === request.activityId);
                  return (
                    <article
                      className="agent-row agent-managed-merge"
                      key={request.requestId}
                      data-status={request.state}
                      data-testid="managed-merge-card"
                    >
                      <div className="agent-row-main">
                        <Glyph name="merge" size={15} />
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
                            leadingIcon={<Glyph name="diff" />}
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
                              disabled={mergeBusy}
                              onClick={() => void decideMerge(request, 'approve')}
                              data-testid="managed-merge-approve"
                            >
                              {t('agentHub.approve')}
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={mergeBusy}
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
                              disabled={mergeBusy}
                              onClick={() => void decideMerge(request, 'deny')}
                            >
                              {t('agentHub.deny')}
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={mergeBusy}
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
          {renderAttention()}
          {pendingMergeRequests.length === 0 && attention.length === 0 && !appChatInbox?.entries.length && <p className="agent-empty">{i18n.language.startsWith('ko') ? '확인이 필요한 요청이 없습니다.' : 'No requests need your attention.'}</p>}
          </>
        )}
      </div>
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
        <Field id="managed-merge-override-reason" label={t('agentHub.managedMerge.overrideReason')} required>
          <textarea
            id="managed-merge-override-reason"
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
