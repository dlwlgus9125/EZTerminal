import { useEffect, useMemo, useState } from 'react';

import type {
  AgentActivity,
  AgentActivitySnapshot,
  AgentFollowupResult,
  AgentProvider,
  AgentStatus,
} from '../shared/agent';
import { formatCwd } from './format-cwd';

const ATTENTION = new Set<AgentStatus>(['blocked', 'error', 'waiting']);
const ACTIVE = new Set<AgentStatus>(['starting', 'working']);

const STATUS_LABEL: Record<AgentStatus, string> = {
  starting: 'Starting',
  working: 'Working',
  waiting: 'Waiting',
  blocked: 'Needs approval',
  done: 'Done',
  error: 'Error',
};

const PROVIDER_LABEL: Record<AgentProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  generic: 'CLI',
};

function ageLabel(updatedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
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
  const [now, setNow] = useState(() => Date.now());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sendingId, setSendingId] = useState<string | null>(null);

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
      ? 'The agent is no longer waiting.'
      : result.error === 'invalid-text'
        ? 'Use one line of 1-8192 characters.'
        : result.error === 'session-ended'
          ? 'The terminal session has ended.'
          : 'Could not deliver the follow-up.';
    setErrors((previous) => ({ ...previous, [item.id]: message }));
  };

  const renderGroup = (title: string, items: readonly AgentActivity[]): JSX.Element | null => {
    if (items.length === 0) return null;
    return (
      <section className="agent-group" data-testid={`agent-group-${title.toLowerCase()}`}>
        <h2 className="status-section-title">{title}</h2>
        <div className="agent-list">
          {items.map((item) => (
            <article className="agent-row" data-status={item.status} key={item.id} data-testid="agent-row">
              <div className="agent-row-main">
                <span className={`agent-status-dot agent-status-dot--${item.status}`} aria-hidden="true" />
                <span className="agent-provider">{PROVIDER_LABEL[item.provider]}</span>
                <span className="agent-cwd" title={item.cwd}>{formatCwd(item.cwd)}</span>
                <time className="agent-age" dateTime={new Date(item.updatedAt).toISOString()}>
                  {ageLabel(item.updatedAt, now)}
                </time>
              </div>
              <div className="agent-row-actions">
                <span className={`agent-status agent-status--${item.status}`}>{STATUS_LABEL[item.status]}</span>
                <button
                  type="button"
                  className="btn btn-split agent-focus"
                  onClick={() => onFocusSession(item.sessionId)}
                  data-testid="agent-focus"
                >
                  {item.status === 'blocked' ? 'Review' : 'Focus'}
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
                    aria-label={`Follow up with ${PROVIDER_LABEL[item.provider]}`}
                    aria-describedby={errors[item.id] ? `agent-error-${item.id}` : undefined}
                    placeholder="Send a follow-up…"
                    onChange={(event) => {
                      const value = event.target.value.replace(/[\r\n]+/g, ' ');
                      setDrafts((previous) => ({ ...previous, [item.id]: value }));
                    }}
                  />
                  <button
                    type="submit"
                    className="btn btn-split"
                    disabled={disconnected || sendingId !== null || !(drafts[item.id] ?? '').trim()}
                    aria-label="Send follow-up"
                  >
                    Send
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
      aria-label="Agent activity"
    >
      <header className="agent-hub-head">
        <div>
          <h1 className="agent-hub-title">Agents</h1>
          <span className="agent-hub-summary">{snapshot.items.length} tracked</span>
        </div>
        {onClose && (
          <button type="button" className="btn btn-split" onClick={onClose} aria-label="Close Agent Hub">
            Close
          </button>
        )}
      </header>
      {disconnected && <div className="agent-offline" role="status">Reconnecting to desktop…</div>}
      <div className="agent-live-region" aria-live="polite" aria-atomic="true">
        {groups.attention.length > 0 ? `${groups.attention.length} agents need attention` : ''}
      </div>
      {snapshot.items.length === 0 ? (
        <div className="agent-empty">No agent activity yet. Launch Codex, Claude, or a configured CLI in a terminal.</div>
      ) : (
        <div className="agent-hub-body">
          {renderGroup('Attention', groups.attention)}
          {renderGroup('Active', groups.active)}
          {renderGroup('Recent', groups.recent)}
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
