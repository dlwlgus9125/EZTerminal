import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  GitCompareArrows,
  Pin,
  Plus,
  Settings,
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
import type {
  AgentHistorySessionSummary,
  AgentProjectSummary,
} from '../shared/agent-history';
import {
  EMPTY_GIT_DIRECTORY_STATUS,
  type GitDiffOmission,
  type GitDiffResult,
  type GitDirectoryStatus,
} from '../shared/git-status';
import { formatCwd } from './format-cwd';
import { useGitBranches } from './use-git-branch';
import { useAppTranslation } from './i18n';
import { Button, Dialog, IconButton } from './ui';

/** Used when no Git reader is supplied; every row then shows its directory. */
const readNothing = (): Promise<GitDirectoryStatus> => Promise.resolve(EMPTY_GIT_DIRECTORY_STATUS);

const ATTENTION = new Set<AgentStatus>(['blocked', 'error', 'waiting']);
const ACTIVE = new Set<AgentStatus>(['starting', 'working']);

const STATUS_LABEL_KEY = {
  starting: 'agentHub.status.starting',
  working: 'agentHub.status.working',
  waiting: 'agentHub.status.waiting',
  blocked: 'agentHub.status.blocked',
  done: 'agentHub.status.done',
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

function ageLabel(
  updatedAt: number,
  now: number,
  formatter: Intl.RelativeTimeFormat,
): string {
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (seconds < 60) return formatter.format(-seconds, 'second');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return formatter.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatter.format(-hours, 'hour');
  return formatter.format(-Math.floor(hours / 24), 'day');
}

function sortRecent(a: AgentActivity, b: AgentActivity): number {
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

/** Wall-clock run time for an in-flight agent, as mm:ss (hh:mm:ss past an hour).
 * Deliberately not a percentage: AgentActivity carries no progress field, and
 * inventing one would put a number on screen that nothing measures. */
/** Time left before the gate lets go, as mm:ss. */
function remainingLabel(expiresAt: number, now: number): string {
  const total = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function elapsedLabel(startedAt: number, now: number): string {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${String(minutes).padStart(2, '0')}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

export interface AgentHubProps {
  readonly snapshot: AgentActivitySnapshot;
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
  /** Resolves each activity's branch. Absent leaves the working directory. */
  readonly onReadGitStatus?: (directory: string) => Promise<GitDirectoryStatus>;
  /** Opens the real agent launcher; absent means no launch verb is rendered. */
  readonly onNewAgentRun?: () => void;
  /** Opens a singleton read-only history tab without disturbing live terminals. */
  readonly onOpenHistorySession?: (
    session: AgentHistorySessionSummary,
    project: AgentProjectSummary,
  ) => void;
  readonly onOpenAgentSettings?: () => void;
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
  onFocusSession,
  onSendFollowup,
  onDecideApproval,
  onLoadDiff,
  onReadGitStatus,
  onNewAgentRun,
  onOpenHistorySession,
  onOpenAgentSettings,
  onClose,
  mobile = false,
  disconnected = false,
  currentTime,
}: AgentHubProps): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const [now, setNow] = useState(() => currentTime ?? Date.now());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [diffView, setDiffView] = useState<DiffView | null>(null);
  const [projects, setProjects] = useState<readonly AgentProjectSummary[]>([]);
  const [projectSessions, setProjectSessions] = useState<
    Readonly<Record<string, readonly AgentHistorySessionSummary[]>>
  >({});
  const [projectSessionCursors, setProjectSessionCursors] = useState<
    Readonly<Record<string, string | null>>
  >({});
  const [loadingSessionProjects, setLoadingSessionProjects] = useState<ReadonlySet<string>>(new Set());
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(new Set());
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState(false);
  const diffRequestGeneration = useRef(0);
  const branches = useGitBranches(
    snapshot.items.map((item) => item.cwd),
    onReadGitStatus ?? readNothing,
  );
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

  const refreshProjects = useCallback(async (force = false): Promise<void> => {
    setProjectsLoading(true);
    setProjectsError(false);
    const read = window.ezterminal?.listAgentProjects;
    if (!read) {
      setProjects([]);
      setProjectsLoading(false);
      return;
    }
    const result = await read(force).catch(() => null);
    setProjectsLoading(false);
    if (!result) {
      setProjectsError(true);
      return;
    }
    setProjects(result.items);
  }, []);

  useEffect(() => {
    void refreshProjects(false);
  }, [refreshProjects]);

  const toggleProject = useCallback(async (projectId: string): Promise<void> => {
    const willExpand = !expandedProjects.has(projectId);
    setExpandedProjects((previous) => {
      const next = new Set(previous);
      if (willExpand) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
    if (!willExpand || projectSessions[projectId] || loadingSessionProjects.has(projectId)) return;
    const read = window.ezterminal?.listAgentHistorySessions;
    if (!read) return;
    setLoadingSessionProjects((previous) => new Set(previous).add(projectId));
    const result = await read(projectId, undefined, 10).catch(() => null);
    setLoadingSessionProjects((previous) => {
      const next = new Set(previous);
      next.delete(projectId);
      return next;
    });
    if (!result) return;
    setProjectSessions((previous) => ({ ...previous, [projectId]: result.items }));
    setProjectSessionCursors((previous) => ({ ...previous, [projectId]: result.nextCursor }));
  }, [expandedProjects, loadingSessionProjects, projectSessions]);

  const loadMoreSessions = useCallback(async (projectId: string): Promise<void> => {
    const cursor = projectSessionCursors[projectId];
    if (!cursor || loadingSessionProjects.has(projectId)) return;
    const read = window.ezterminal?.listAgentHistorySessions;
    if (!read) return;
    setLoadingSessionProjects((previous) => new Set(previous).add(projectId));
    const result = await read(projectId, cursor, 10).catch(() => null);
    setLoadingSessionProjects((previous) => {
      const next = new Set(previous);
      next.delete(projectId);
      return next;
    });
    if (!result) return;
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
    const desktop = window.ezterminalDesktop;
    if (!desktop) return;
    const result = await desktop.saveAgentProject({
      projectId: project.saved ? project.projectId : undefined,
      name: patch.name ?? project.name,
      primaryRoot: patch.primaryRoot ?? project.primaryRoot,
      additionalRoots: patch.additionalRoots ?? project.additionalRoots,
      pinned: patch.pinned ?? project.pinned,
    });
    if (result.ok) void refreshProjects(true);
  }, [refreshProjects]);

  const addProject = useCallback(async (): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop) return;
    const selection = await desktop.selectAgentProjectFolders(true);
    const [primaryRoot, ...additionalRoots] = selection.paths;
    if (selection.canceled || !primaryRoot) return;
    const name = primaryRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? primaryRoot;
    const result = await desktop.saveAgentProject({
      name,
      primaryRoot,
      additionalRoots,
      pinned: false,
    });
    if (result.ok) void refreshProjects(true);
  }, [refreshProjects]);

  const editProjectFolders = useCallback(async (
    project: AgentProjectSummary,
  ): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop) return;
    const selection = await desktop.selectAgentProjectFolders(true);
    const [primaryRoot, ...additionalRoots] = selection.paths;
    if (selection.canceled || !primaryRoot) return;
    await saveProject(project, { primaryRoot, additionalRoots });
  }, [saveProject]);

  const groups = useMemo(() => {
    const attention: AgentActivity[] = [];
    const active: AgentActivity[] = [];
    const recent: AgentActivity[] = [];
    for (const item of snapshot.items) {
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
  }, [snapshot]);

  // A running agent shows a ticking mm:ss, so the clock has to move every
  // second while one exists. With nothing running the coarse relative ages only
  // need the original slow tick. Neither is announced: elapsed time is on the
  // accessibility exclusion list for live regions.
  // A pending approval also needs the fast tick for its display countdown.
  // The host's `pending` bit, rather than this renderer's wall clock, is the
  // authority for whether the decision buttons remain actionable.
  const hasPendingApproval = snapshot.items.some((item) => item.approval?.pending === true);
  const hasActive = groups.active.length > 0;
  useEffect(() => {
    if (currentTime !== undefined) {
      setNow(currentTime);
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), hasActive || hasPendingApproval ? 1_000 : 30_000);
    return () => clearInterval(timer);
  }, [currentTime, hasActive, hasPendingApproval]);

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
    [onLoadDiff, t],
  );

  useEffect(() => () => {
    diffRequestGeneration.current += 1;
  }, []);

  const send = async (item: AgentActivity): Promise<void> => {
    const text = (drafts[item.id] ?? '').trim();
    if (!text || sendingId !== null) return;
    setSendingId(item.id);
    setErrors((previous) => ({ ...previous, [item.id]: '' }));
    const result = await onSendFollowup(item.id, text).catch((): AgentFollowupResult => ({
      ok: false,
      error: 'delivery-failed',
    }));
    setSendingId(null);
    if (result.ok) {
      setDrafts((previous) => ({ ...previous, [item.id]: '' }));
      return;
    }
    const message = result.error === 'not-waiting'
      ? t('agentHub.errorNotWaiting')
      : result.error === 'invalid-text'
        ? t('agentHub.errorInvalidText')
        : result.error === 'session-ended'
          ? t('agentHub.errorSessionEnded')
          : t('agentHub.errorDeliveryFailed');
    setErrors((previous) => ({ ...previous, [item.id]: message }));
  };

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
        {group === 'recent' ? (
          // Finished work is a log, not a queue: one dense monospace line each,
          // newest first, with nothing to act on.
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
                  {ageLabel(item.updatedAt, now, relativeTime)}
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
                    {item.approval.pending && item.approval.expiresAt > now && (
                      <span className="agent-approval-countdown">
                        {remainingLabel(item.approval.expiresAt, now)}
                      </span>
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
                      {onLoadDiff && (
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
              </div>
              {group === 'active' && (
                <div className="agent-progress">
                  <span className="agent-progress-track" aria-hidden="true">
                    <span className="agent-progress-sweep" />
                  </span>
                  <span className="agent-elapsed">{elapsedLabel(item.createdAt, now)}</span>
                </div>
              )}
              {item.status === 'waiting' && (
                <form
                  className="agent-followup"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send(item);
                  }}
                >
                  <input
                    className="agent-followup-input"
                    value={drafts[item.id] ?? ''}
                    maxLength={8192}
                    disabled={disconnected || sendingId === item.id}
                    aria-label={t('agentHub.followupWith', { provider: PROVIDER_LABEL[item.provider] })}
                    aria-describedby={errors[item.id] ? `agent-error-${item.id}` : undefined}
                    placeholder={t('agentHub.followupPlaceholder')}
                    onChange={(event) => {
                      const value = event.target.value.replace(/[\r\n]+/g, ' ');
                      setDrafts((previous) => ({ ...previous, [item.id]: value }));
                    }}
                  />
                  <button
                    type="submit"
                    className="btn btn-split"
                    disabled={disconnected || sendingId !== null || !(drafts[item.id] ?? '').trim()}
                    aria-label={t('agentHub.sendFollowup')}
                  >
                    {t('agentHub.send')}
                  </button>
                  {errors[item.id] && (
                    <div className="agent-followup-error" id={`agent-error-${item.id}`} role="alert">
                      {errors[item.id]}
                    </div>
                  )}
                </form>
              )}
            </article>
          ))}
        </div>
        )}
      </section>
    );
  };

  return (
    <div
      className={mobile ? 'mobile-agent-hub' : 'status-drawer agent-hub'}
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
          {snapshot.items.length === 0 && (
            <div className="agent-empty">{t('agentHub.empty')}</div>
          )}
          {renderGroup('attention', t('agentHub.groups.attention'), groups.attention)}
          {renderGroup('active', t('agentHub.groups.active'), groups.active)}
          <section className="agent-group agent-projects" data-testid="agent-projects">
            <div className="agent-projects-heading">
              <h2 className="status-section-title agent-group-title">Projects</h2>
              {window.ezterminalDesktop && (
                <IconButton
                  icon={FolderPlus}
                  aria-label="Add project"
                  onClick={() => void addProject()}
                  data-testid="agent-add-project"
                />
              )}
            </div>
            {projectsLoading && <p className="agent-project-note">Loading projects…</p>}
            {projectsError && (
              <button type="button" className="agent-project-note" onClick={() => void refreshProjects(true)}>
                Could not load projects. Retry
              </button>
            )}
            {!projectsLoading && !projectsError && projects.length === 0 && (
              <p className="agent-project-note">No local Agent projects yet.</p>
            )}
            <ol className="agent-project-list">
              {projects.map((project) => {
                const expanded = expandedProjects.has(project.projectId);
                const sessions = projectSessions[project.projectId];
                const sessionsLoading = loadingSessionProjects.has(project.projectId);
                const nextCursor = projectSessionCursors[project.projectId];
                return (
                  <li className="agent-project" key={project.projectId}>
                    <div className="agent-project-row">
                      <button
                        type="button"
                        className="agent-project-toggle"
                        onClick={() => void toggleProject(project.projectId)}
                        aria-expanded={expanded}
                      >
                        {expanded
                          ? <ChevronDown aria-hidden="true" />
                          : <ChevronRight aria-hidden="true" />}
                        <span>
                          <strong>{project.name}</strong>
                          <small title={[project.primaryRoot, ...project.additionalRoots].join('\n')}>
                            {formatCwd(project.primaryRoot)}
                            {project.additionalRoots.length > 0
                              ? ` · +${numberFormatter.format(project.additionalRoots.length)}`
                              : ''}
                          </small>
                        </span>
                        {sessions && (
                          <span className="agent-project-count">
                            {sessions.length}{nextCursor ? '+' : ''}
                          </span>
                        )}
                      </button>
                      {window.ezterminalDesktop && (
                        <>
                          <IconButton
                            icon={Pin}
                            aria-label={project.pinned ? 'Unpin project' : 'Pin project'}
                            className={project.pinned ? 'agent-project-pin is-active' : 'agent-project-pin'}
                            onClick={() => void saveProject(project, { pinned: !project.pinned })}
                          />
                          <button
                            type="button"
                            className="agent-project-edit"
                            aria-label={`Rename ${project.name}`}
                            onClick={() => {
                              const name = window.prompt('Project name', project.name)?.trim();
                              if (name) void saveProject(project, { name });
                            }}
                          >
                            Name
                          </button>
                          <button
                            type="button"
                            className="agent-project-edit"
                            aria-label={`Edit folders for ${project.name}`}
                            onClick={() => void editProjectFolders(project)}
                          >
                            Folders
                          </button>
                        </>
                      )}
                    </div>
                    {expanded && (
                      <ol className="agent-history-list">
                        {!sessions && sessionsLoading && <li className="agent-project-note">Loading sessions…</li>}
                        {sessions?.length === 0 && <li className="agent-project-note">No previous sessions.</li>}
                        {sessions?.map((session) => (
                          <li key={session.historyId}>
                            <button
                              type="button"
                              className="agent-history-row"
                              title={session.title}
                              onClick={() => {
                                if (mobile) onOpenHistorySession?.(session, project);
                              }}
                              onDoubleClick={() => {
                                if (!mobile) onOpenHistorySession?.(session, project);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') onOpenHistorySession?.(session, project);
                              }}
                            >
                              <span>{PROVIDER_LABEL[session.provider]}</span>
                              <strong>{session.title}</strong>
                              <small>{ageLabel(session.updatedAt, now, relativeTime)}</small>
                              {session.preview && <p>{session.preview}</p>}
                            </button>
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
                              {sessionsLoading ? 'Loading…' : 'More'}
                            </button>
                          </li>
                        )}
                      </ol>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
      </div>
      {(onNewAgentRun || onOpenAgentSettings) && (
        <footer className="agent-hub-footer">
          {onNewAgentRun && (
            <Button
              variant="primary"
              size="sm"
              leadingIcon={<Plus aria-hidden="true" />}
              onClick={onNewAgentRun}
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

export function countAgentAttention(snapshot: AgentActivitySnapshot): number {
  return snapshot.items.filter((item) => ATTENTION.has(item.status)).length;
}

export function agentStatusClass(status: AgentStatus | undefined): string {
  return status ? `agent-status-dot agent-status-dot--${status}` : 'agent-status-dot';
}
