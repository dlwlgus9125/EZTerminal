import { Bot, Check, ChevronLeft } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  AgentActivity,
  AgentApprovalRisk,
  AgentActivitySnapshot,
  AgentDecision,
  AgentDecisionResult,
  AgentFollowupResult,
  AgentProvider,
  AgentStatus,
} from '../../src/shared/agent';
import type {
  AgentHistorySessionSummary,
  AgentProjectSummary,
  AgentResumeBootstrap,
} from '../../src/shared/agent-history';
import {
  EMPTY_GIT_DIRECTORY_STATUS,
  type GitDiffOmission,
  type GitDiffResult,
  type GitDirectoryStatus,
} from '../../src/shared/git-status';
import { formatCwd } from '../../src/renderer/format-cwd';
import { useGitBranches } from '../../src/renderer/use-git-branch';
import { useAppTranslation } from '../../src/renderer/i18n';
import { MobileActionSheet } from './MobileActionSheet';
import { MobileAgentHistorySheet } from './MobileAgentHistorySheet';
import { useMobileToast } from './MobileToast';

/** Used when the host predates the Git arms; every card then shows its cwd. */
const readNothing = (): Promise<GitDirectoryStatus> => Promise.resolve(EMPTY_GIT_DIRECTORY_STATUS);

const ATTENTION = new Set<AgentStatus>(['blocked', 'error', 'waiting']);
const RUNNING = new Set<AgentStatus>(['starting', 'working']);

const RISK_RANK = {
  danger: 0,
  write: 1,
  read: 2,
} as const satisfies Record<AgentApprovalRisk, number>;

const PROVIDER_LABEL: Record<AgentProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  generic: 'CLI',
};

const STATUS_LABEL_KEY = {
  starting: 'agentHub.status.starting',
  working: 'agentHub.status.working',
  waiting: 'agentHub.status.waiting',
  blocked: 'agentHub.status.blocked',
  done: 'agentHub.status.done',
  error: 'agentHub.status.error',
} as const satisfies Record<AgentStatus, string>;

type AgentFilter = 'all' | 'attention' | 'running' | 'done';

function bucketOf(status: AgentStatus): AgentFilter {
  if (ATTENTION.has(status)) return 'attention';
  if (RUNNING.has(status)) return 'running';
  return 'done';
}

function ageLabel(updatedAt: number, now: number, formatter: Intl.RelativeTimeFormat): string {
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

function sortAttention(a: AgentActivity, b: AgentActivity): number {
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
}

type MobileDiffView =
  | { readonly state: 'loading' }
  | {
      readonly state: 'ready';
      readonly text: string;
      readonly truncated: boolean;
      readonly omissions: readonly GitDiffOmission[];
    };

/**
 * The mobile Agents tab (handoff §4). A filtered card list rather than the
 * desktop's three fixed groups — the desktop AgentHub is deliberately left
 * alone, since this is a presentation split, not a data one: both read the
 * same `AgentActivitySnapshot` and use the same follow-up call.
 *
 * Approve and deny answer the permission hook the desktop is holding open for
 * that agent; "view diff" shows its uncommitted work. When no hook is parked —
 * an older desktop, an ungated provider, or a window that has already closed —
 * the card falls back to the two affordances that always exist: focus the
 * blocked session, and follow up on a waiting one.
 */
export function MobileAgentView({
  snapshot,
  disconnected = false,
  onBack,
  onFocusSession,
  onSendFollowup,
  onDecideApproval,
  onLoadDiff,
  onReadGitStatus,
  onResumeHistory,
}: {
  readonly snapshot: AgentActivitySnapshot;
  readonly disconnected?: boolean;
  readonly onBack: () => void;
  readonly onFocusSession: (sessionId: string) => void;
  readonly onSendFollowup: (activityId: string, text: string) => Promise<AgentFollowupResult>;
  readonly onDecideApproval?: (
    activityId: string,
    approvalId: string,
    decision: AgentDecision,
  ) => Promise<AgentDecisionResult>;
  readonly onLoadDiff?: (directory: string) => Promise<GitDiffResult>;
  readonly onReadGitStatus?: (directory: string) => Promise<GitDirectoryStatus>;
  readonly onResumeHistory?: (bootstrap: AgentResumeBootstrap, cwd: string) => Promise<void>;
}): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const showToast = useMobileToast();
  const [filter, setFilter] = useState<AgentFilter>('all');
  const [now, setNow] = useState(() => Date.now());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [diff, setDiff] = useState<MobileDiffView | null>(null);
  const [projects, setProjects] = useState<readonly AgentProjectSummary[]>([]);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [projectSessions, setProjectSessions] = useState<
    Readonly<Record<string, readonly AgentHistorySessionSummary[]>>
  >({});
  const [projectSessionCursors, setProjectSessionCursors] = useState<
    Readonly<Record<string, string | null>>
  >({});
  const [loadingSessionProject, setLoadingSessionProject] = useState<string | null>(null);
  const [historySession, setHistorySession] = useState<AgentHistorySessionSummary | null>(null);
  const diffRequestGeneration = useRef(0);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const branches = useGitBranches(
    snapshot.items.map((item) => item.cwd),
    onReadGitStatus ?? readNothing,
    !disconnected,
  );
  const relativeTime = useMemo(
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' }),
    [locale],
  );

  useEffect(() => {
    if (!onResumeHistory) return;
    const readProjects = window.ezterminal?.listAgentProjects;
    if (!readProjects) return;
    let alive = true;
    void readProjects(false).then((result) => {
      if (!alive) return;
      setProjects(result.items);
      void readProjects(true).then((discovered) => {
        if (alive) setProjects(discovered.items);
      }).catch(() => undefined);
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [onResumeHistory]);

  const toggleProject = async (projectId: string): Promise<void> => {
    if (expandedProject === projectId) {
      setExpandedProject(null);
      return;
    }
    setExpandedProject(projectId);
    if (projectSessions[projectId]) return;
    const readSessions = window.ezterminal?.listAgentHistorySessions;
    if (!readSessions) return;
    setLoadingSessionProject(projectId);
    const result = await readSessions(projectId, undefined, 10).catch(() => null);
    setLoadingSessionProject(null);
    if (result) {
      setProjectSessions((previous) => ({ ...previous, [projectId]: result.items }));
      setProjectSessionCursors((previous) => ({ ...previous, [projectId]: result.nextCursor }));
    }
  };

  const loadMoreSessions = async (projectId: string): Promise<void> => {
    const cursor = projectSessionCursors[projectId];
    if (!cursor || loadingSessionProject !== null) return;
    const readSessions = window.ezterminal?.listAgentHistorySessions;
    if (!readSessions) return;
    setLoadingSessionProject(projectId);
    const result = await readSessions(projectId, cursor, 10).catch(() => null);
    setLoadingSessionProject(null);
    if (!result) return;
    setProjectSessions((previous) => ({
      ...previous,
      [projectId]: [...(previous[projectId] ?? []), ...result.items],
    }));
    setProjectSessionCursors((previous) => ({ ...previous, [projectId]: result.nextCursor }));
  };

  // A pending approval expires on a deadline, so while one is open the clock
  // has to move fast enough for the buttons to disappear when it closes.
  const hasPendingApproval = snapshot.items.some((item) => item.approval?.pending === true);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), hasPendingApproval ? 1_000 : 30_000);
    return () => clearInterval(timer);
  }, [hasPendingApproval]);

  const decide = async (item: AgentActivity, decision: AgentDecision): Promise<void> => {
    if (!onDecideApproval || decidingId !== null || !item.approval) return;
    setDecidingId(item.id);
    const result = await onDecideApproval(
      item.id,
      item.approval.approvalId,
      decision,
    ).catch((): AgentDecisionResult => ({
      ok: false,
      error: 'outcome-unknown',
    }));
    setDecidingId(null);
    if (result.ok) {
      showToast(
        decision === 'allow'
          ? t('mobile.agentView.approved', { provider: PROVIDER_LABEL[item.provider] })
          : t('mobile.agentView.denied', { provider: PROVIDER_LABEL[item.provider] }),
      );
      return;
    }
    setErrors((previous) => ({
      ...previous,
      [item.id]: result.error === 'expired' || result.error === 'stale'
        ? t('agentHub.approvalExpired')
        : result.error === 'outcome-unknown'
          ? t('agentHub.approvalOutcomeUnknown')
          : t('agentHub.approvalFailed'),
    }));
  };

  const openDiff = async (directory: string): Promise<void> => {
    if (!onLoadDiff) return;
    const generation = ++diffRequestGeneration.current;
    setDiff({ state: 'loading' });
    const result = await onLoadDiff(directory).catch((): GitDiffResult => ({ ok: false, error: 'git-failed' }));
    if (generation !== diffRequestGeneration.current) return;
    if (!result.ok) {
      setDiff(null);
      showToast(result.error === 'not-a-repository' ? t('agentHub.diffUnavailable') : t('agentHub.approvalFailed'));
      return;
    }
    setDiff({
      state: 'ready',
      text: result.text,
      truncated: result.truncated,
      omissions: result.omissions,
    });
  };

  useEffect(() => () => {
    diffRequestGeneration.current += 1;
  }, []);

  const counts = useMemo(() => {
    const tally = { all: snapshot.items.length, attention: 0, running: 0, done: 0 };
    for (const item of snapshot.items) tally[bucketOf(item.status)] += 1;
    return tally;
  }, [snapshot]);

  const visible = useMemo(() => {
    return snapshot.items
      .filter((item) => filter === 'all' || bucketOf(item.status) === filter)
      .slice()
      .sort((a, b) => {
        const bucketDelta = ['attention', 'running', 'done'].indexOf(bucketOf(a.status))
          - ['attention', 'running', 'done'].indexOf(bucketOf(b.status));
        if (bucketDelta !== 0) return bucketDelta;
        return bucketOf(a.status) === 'attention' ? sortAttention(a, b) : sortRecent(a, b);
      });
  }, [filter, snapshot]);

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
      showToast(t('mobile.agentView.followupSent', { provider: PROVIDER_LABEL[item.provider] }));
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

  const filters: readonly { readonly id: AgentFilter; readonly label: string; readonly count: number }[] = [
    { id: 'all', label: t('mobile.agentView.filterAll'), count: counts.all },
    { id: 'attention', label: t('mobile.agentView.filterAttention'), count: counts.attention },
    { id: 'running', label: t('mobile.agentView.filterRunning'), count: counts.running },
    { id: 'done', label: t('mobile.agentView.filterDone'), count: counts.done },
  ];

  return (
    <main className="mob-page" data-testid="mobile-agent-view" aria-label={t('agentHub.activity')}>
      <header className="mob-page__head">
        <button type="button" className="mob-icon-btn" onClick={onBack} aria-label={t('common.back')} data-testid="mobile-agent-close">
          <ChevronLeft aria-hidden="true" />
        </button>
        <div>
          <h1 className="mob-page__title">{t('mobile.agents')}</h1>
          {counts.attention > 0 && (
            <p className="mob-page__subtitle" data-testid="agent-attention-summary">
              {t('mobile.agentView.waitingCount', { value: counts.attention })}
            </p>
          )}
        </div>
      </header>

      {disconnected && <div className="mob-empty" role="status">{t('agentHub.reconnecting')}</div>}

      <div className="mob-agent-filters" role="group" aria-label={t('mobile.agentView.filterLabel')}>
        {filters.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === 'attention' ? 'mob-chip mob-chip--warning' : 'mob-chip'}
            aria-pressed={filter === entry.id}
            onClick={() => setFilter(entry.id)}
            data-testid={`agent-filter-${entry.id}`}
          >
            {entry.label} {entry.count}
          </button>
        ))}
      </div>

      <div className="mob-page__body">
        <div className="mob-column">
          {visible.length === 0 && (
            <p className="mob-empty" data-testid="agent-empty">
              {snapshot.items.length === 0 ? t('agentHub.empty') : t('mobile.agentView.noMatches')}
            </p>
          )}

          {visible.map((item) => {
            const bucket = bucketOf(item.status);
            const age = ageLabel(item.updatedAt, now, relativeTime);
            // A decision is only offered while the desktop is still holding the
            // provider's hook open. Past that the answer belongs in the terminal.
            const live = item.approval?.pending === true;

            if (bucket === 'done') {
              return (
                <article key={item.id} className="mob-agent-card mob-agent-card--done" data-testid="agent-card" data-status={item.status}>
                  <Check aria-hidden="true" className="mob-row__chevron" />
                  <span className="mob-agent-card__done-copy">
                    <span className="mob-row__title mob-row__title--body">
                      {PROVIDER_LABEL[item.provider]} · {formatCwd(item.cwd, 28)}
                    </span>
                    <span className="mob-row__meta">{t(STATUS_LABEL_KEY[item.status])} · {age}</span>
                  </span>
                </article>
              );
            }

            if (bucket === 'running') {
              return (
                <article key={item.id} className="mob-agent-card mob-agent-card--running" data-testid="agent-card" data-status={item.status}>
                  <div className="mob-agent-card__head">
                    <span className="mob-agent-card__chip" aria-hidden="true">
                      <span className="mob-agent-card__spinner" />
                    </span>
                    <span className="mob-agent-card__name">{PROVIDER_LABEL[item.provider]}</span>
                    <span className="mob-agent-card__time">{age}</span>
                  </div>
                  <p className="mob-agent-card__branch" title={item.cwd}>
                    {formatCwd(item.cwd, 30)} · {t(STATUS_LABEL_KEY[item.status])}
                  </p>
                  <div className="mob-agent-card__progress" aria-hidden="true"><span /></div>
                </article>
              );
            }

            return (
              <article key={item.id} className="mob-agent-card mob-agent-card--attention" data-testid="agent-card" data-status={item.status}>
                <div className="mob-agent-card__head">
                  <span className="mob-agent-card__chip" aria-hidden="true"><Bot /></span>
                  <span className="mob-agent-card__name">{PROVIDER_LABEL[item.provider]}</span>
                  <span className="mob-badge mob-badge--warning">{t(STATUS_LABEL_KEY[item.status])}</span>
                </div>
                <p className="mob-agent-card__branch" title={item.cwd}>
                  {branches.get(item.cwd) ?? formatCwd(item.cwd, 30)}
                </p>
                <p className="mob-agent-card__body">
                  {item.status === 'waiting'
                    ? t('mobile.agentView.waitingBody')
                    : item.status === 'blocked'
                      ? t('mobile.agentView.blockedBody')
                      : t('mobile.agentView.errorBody')}
                </p>
                {live && (
                  <code className="mob-agent-card__command" data-risk={item.approval?.risk}>
                    {item.approval?.command ?? item.approval?.toolName}
                  </code>
                )}
                <div className="mob-agent-card__actions">
                  {live ? (
                    <>
                      <button
                        type="button"
                        className="mob-btn-warning"
                        disabled={disconnected || decidingId !== null}
                        onClick={() => void decide(item, 'allow')}
                        data-testid="agent-approve"
                      >
                        {t('mobile.agentView.approveAndContinue')}
                      </button>
                      <button
                        type="button"
                        className="mob-btn-ghost"
                        disabled={disconnected || decidingId !== null}
                        onClick={() => void decide(item, 'deny')}
                        data-testid="agent-deny"
                      >
                        {t('agentHub.deny')}
                      </button>
                      {onLoadDiff && (
                        <button
                          type="button"
                          className="mob-btn-ghost"
                          disabled={disconnected || diff?.state === 'loading'}
                          onClick={() => void openDiff(item.cwd)}
                          data-testid="agent-view-diff"
                        >
                          {t('agentHub.viewDiff')}
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      type="button"
                      className="mob-btn-warning"
                      onClick={() => onFocusSession(item.sessionId)}
                      data-testid="agent-focus"
                    >
                      {t('agentHub.review')} →
                    </button>
                  )}
                  <span className="mob-agent-card__time">{age}</span>
                </div>
                {item.status === 'waiting' && (
                  <form
                    className="mob-agent-followup"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void send(item);
                    }}
                  >
                    <input
                      value={drafts[item.id] ?? ''}
                      maxLength={8192}
                      disabled={disconnected || sendingId === item.id}
                      aria-label={t('agentHub.followupWith', { provider: PROVIDER_LABEL[item.provider] })}
                      aria-describedby={errors[item.id] ? `mobile-agent-error-${item.id}` : undefined}
                      placeholder={t('agentHub.followupPlaceholder')}
                      onChange={(event) => {
                        const value = event.target.value.replace(/[\r\n]+/g, ' ');
                        setDrafts((previous) => ({ ...previous, [item.id]: value }));
                      }}
                      data-testid="agent-followup-input"
                    />
                    <button
                      type="submit"
                      className="mob-btn-ghost"
                      disabled={disconnected || sendingId !== null || !(drafts[item.id] ?? '').trim()}
                      aria-label={t('agentHub.sendFollowup')}
                    >
                      {t('agentHub.send')}
                    </button>
                  </form>
                )}
                {errors[item.id] && (
                  <p className="mob-agent-error" id={`mobile-agent-error-${item.id}`} role="alert">
                    {errors[item.id]}
                  </p>
                )}
              </article>
            );
          })}
          {onResumeHistory && (
            <section className="mob-agent-projects" data-testid="mobile-agent-projects">
              <h2>Projects</h2>
              {projects.length === 0 && <p className="mob-empty">No local Agent projects yet.</p>}
              {projects.map((project) => (
                <div className="mob-agent-project" key={project.projectId}>
                  <button
                    type="button"
                    className="mob-row"
                    onClick={() => void toggleProject(project.projectId)}
                    aria-expanded={expandedProject === project.projectId}
                  >
                    <span>
                      <strong>{project.name}</strong>
                      <small>{formatCwd(project.primaryRoot, 32)}</small>
                    </span>
                    <span>
                      {projectSessions[project.projectId]
                        ? `${projectSessions[project.projectId]!.length}${projectSessionCursors[project.projectId] ? '+' : ''}`
                        : ''}
                    </span>
                  </button>
                  {expandedProject === project.projectId && (
                    <div className="mob-agent-history-list">
                      {!projectSessions[project.projectId] && <p className="mob-empty">Loading sessions…</p>}
                      {projectSessions[project.projectId]?.map((session) => (
                        <button
                          type="button"
                          className="mob-row"
                          key={session.historyId}
                          onClick={() => setHistorySession(session)}
                        >
                          <span>
                            <strong>{session.title}</strong>
                            <small>{session.provider} · {ageLabel(session.updatedAt, now, relativeTime)}</small>
                          </span>
                        </button>
                      ))}
                      {projectSessionCursors[project.projectId] && (
                        <button
                          type="button"
                          className="mob-btn-ghost"
                          disabled={loadingSessionProject !== null}
                          onClick={() => void loadMoreSessions(project.projectId)}
                        >
                          {loadingSessionProject === project.projectId ? 'Loading…' : 'More'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
      {historySession && onResumeHistory && (
        <MobileAgentHistorySheet
          session={historySession}
          onClose={() => setHistorySession(null)}
          onResume={onResumeHistory}
        />
      )}
      {diff !== null && (
        <MobileActionSheet
          title={t('agentHub.diffTitle')}
          onClose={() => {
            diffRequestGeneration.current += 1;
            setDiff(null);
          }}
          variant="fullscreen"
          testId="mobile-agent-diff"
        >
          {diff.state === 'loading' ? (
            <p className="mob-empty" role="status">{t('common.loading')}</p>
          ) : (
            <>
              {diff.text.trim().length > 0 && <pre className="mob-agent-diff">{diff.text}</pre>}
              {diff.text.trim().length === 0 && !diff.truncated && diff.omissions.length === 0 && (
                <p className="mob-empty">{t('agentHub.diffEmpty')}</p>
              )}
              {diff.truncated && (
                <p
                  className="mob-agent-diff-note"
                  role="status"
                  data-testid="mobile-agent-diff-truncated"
                >
                  {t('agentHub.diffTruncated')}
                </p>
              )}
              {diff.omissions.length > 0 && (
                <ul
                  className="mob-agent-diff-omissions"
                  data-testid="mobile-agent-diff-omissions"
                >
                  {diff.omissions.map((omission) => (
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
        </MobileActionSheet>
      )}
    </main>
  );
}
