import { useEffect, useMemo, useState } from 'react';

import type {
  AgentActivity,
  AgentActivitySnapshot,
  AgentFollowupResult,
  AgentProvider,
  AgentStatus,
} from '../shared/agent';
import { formatCwd } from './format-cwd';
import { useAppTranslation } from './i18n';

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

export interface AgentHubProps {
  readonly snapshot: AgentActivitySnapshot;
  readonly onFocusSession: (sessionId: string) => void;
  readonly onSendFollowup: (activityId: string, text: string) => Promise<AgentFollowupResult>;
  readonly onClose?: () => void;
  readonly mobile?: boolean;
  readonly disconnected?: boolean;
}

export function AgentHub({
  snapshot,
  onFocusSession,
  onSendFollowup,
  onClose,
  mobile = false,
  disconnected = false,
}: AgentHubProps): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const [now, setNow] = useState(() => Date.now());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sendingId, setSendingId] = useState<string | null>(null);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const relativeTime = useMemo(
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' }),
    [locale],
  );
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

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
      const rank = (status: AgentStatus): number => status === 'blocked' ? 0 : status === 'error' ? 1 : 2;
      return rank(a.status) - rank(b.status) || sortRecent(a, b);
    });
    active.sort(sortRecent);
    recent.sort(sortRecent);
    return { attention, active, recent };
  }, [snapshot]);

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
        <h2 className="status-section-title">{title}</h2>
        <div className="agent-list">
          {items.map((item) => (
            <article className="agent-row" data-status={item.status} key={item.id} data-testid="agent-row">
              <div className="agent-row-main">
                <span className={`agent-status-dot agent-status-dot--${item.status}`} aria-hidden="true" />
                <span className="agent-provider">{PROVIDER_LABEL[item.provider]}</span>
                <span className="agent-cwd" title={item.cwd}>{formatCwd(item.cwd)}</span>
                <time className="agent-age" dateTime={new Date(item.updatedAt).toISOString()}>
                  {ageLabel(item.updatedAt, now, relativeTime)}
                </time>
              </div>
              <div className="agent-row-actions">
                <span className={`agent-status agent-status--${item.status}`}>
                  {t(STATUS_LABEL_KEY[item.status])}
                </span>
                <button
                  type="button"
                  className="btn btn-split agent-focus"
                  onClick={() => onFocusSession(item.sessionId)}
                  data-testid="agent-focus"
                >
                  {item.status === 'blocked' ? t('agentHub.review') : t('agentHub.focus')}
                </button>
              </div>
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
      </section>
    );
  };

  return (
    <div
      className={mobile ? 'mobile-agent-hub' : 'status-drawer agent-hub'}
      data-testid="agent-hub"
      aria-label={t('agentHub.activity')}
    >
      <header className="agent-hub-head">
        <div>
          <h1 className="agent-hub-title">{t('rail.agents')}</h1>
          <span className="agent-hub-summary">
            {t('agentHub.tracked', { value: numberFormatter.format(snapshot.items.length) })}
          </span>
        </div>
        {onClose && (
          <button type="button" className="btn btn-split" onClick={onClose} aria-label={t('agentHub.closeHub')}>
            {t('common.close')}
          </button>
        )}
      </header>
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
      {snapshot.items.length === 0 ? (
        <div className="agent-empty">{t('agentHub.empty')}</div>
      ) : (
        <div className="agent-hub-body">
          {renderGroup('attention', t('agentHub.groups.attention'), groups.attention)}
          {renderGroup('active', t('agentHub.groups.active'), groups.active)}
          {renderGroup('recent', t('agentHub.groups.recent'), groups.recent)}
        </div>
      )}
    </div>
  );
}

export function countAgentAttention(snapshot: AgentActivitySnapshot): number {
  return snapshot.items.filter((item) => ATTENTION.has(item.status)).length;
}

export function agentStatusClass(status: AgentStatus | undefined): string {
  return status ? `agent-status-dot agent-status-dot--${status}` : 'agent-status-dot';
}
