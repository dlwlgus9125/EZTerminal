import { Bot, ChevronRight, MonitorPlay, SquareTerminal, Wrench } from 'lucide-react';

import type { SessionInfo } from '../../src/shared/ipc';
import type { AgentActivitySnapshot } from '../../src/shared/agent';
import type { OpenClawStatus } from '../../src/shared/openclaw';
import { formatCwd } from '../../src/renderer/format-cwd';
import { useAppTranslation } from '../../src/renderer/i18n';
import { formatEndpointHost } from './mobile-endpoint';
import { MobileSignalMark } from './MobileSignalMark';

/** Handoff §2: the home tab shows the three most recent sessions and links
 * out to the terminal tab for the rest. */
const RECENT_SESSION_LIMIT = 3;

const AGENT_BUSY = new Set(['starting', 'working', 'waiting', 'blocked', 'error']);

export interface HomeSessionRow {
  readonly session: SessionInfo;
  readonly open: boolean;
}

/**
 * The Home tab — replaces the old destination grid (MobileRemoteHub) as the
 * shell's root. Summary first, then the three things a phone user actually
 * came for: start PC control, resume a session, clear an agent that is
 * waiting. Every value here is bound to live transport state; nothing is
 * derived from a mock.
 */
export function MobileHomeView({
  connected,
  connectionUrl,
  desktopControlSupported,
  sessions,
  activeSessionId,
  agentSnapshot,
  agentAttention,
  openclawVisible,
  openclawState,
  onOpenPcControl,
  onOpenSession,
  onOpenTerminal,
  onOpenAgents,
  onOpenClaw,
}: {
  readonly connected: boolean;
  readonly connectionUrl: string;
  readonly desktopControlSupported: boolean;
  readonly sessions: readonly HomeSessionRow[];
  readonly activeSessionId: string | null;
  readonly agentSnapshot: AgentActivitySnapshot;
  readonly agentAttention: number;
  readonly openclawVisible: boolean;
  readonly openclawState?: OpenClawStatus['state'];
  readonly onOpenPcControl: () => void;
  readonly onOpenSession: (session: SessionInfo) => void;
  readonly onOpenTerminal: () => void;
  readonly onOpenAgents: () => void;
  readonly onOpenClaw: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const host = connectionUrl ? formatEndpointHost(connectionUrl) : t('mobile.hub.offline');
  const pcControlReason = !connected
    ? t('mobile.pcControl.offline')
    : !desktopControlSupported
      ? t('mobile.pcControl.unsupported')
      : undefined;
  const recent = sessions.slice(0, RECENT_SESSION_LIMIT);
  const firstAttention = agentSnapshot.items.find(
    (item) => item.status === 'blocked' || item.status === 'error' || item.status === 'waiting',
  );
  // Handoff §2: the OpenClaw shortcut appears on Home ONLY while the gateway
  // is actually running. Every other state keeps it in the More sheet, so the
  // existing auto/on/off visibility policy is untouched.
  const showOpenClaw = openclawVisible && openclawState === 'running';

  return (
    <main className="mob-page mob-home" data-testid="mobile-home-view">
      <div className="mob-home__head">
        <div className="mob-home__brand">
          <MobileSignalMark />
          <span className="mob-wordmark">EZTerminal</span>
        </div>
        <span
          className={connected ? 'mob-home__host' : 'mob-home__host mob-home__host--offline'}
          data-testid="home-connection-state"
        >
          <span className={connected ? 'mob-dot mob-dot--live' : 'mob-dot'} aria-hidden="true" />
          <span title={connectionUrl}>{connected ? host : t('mobile.hub.offline')}</span>
        </span>
      </div>

      <div className="mob-home__body">
        <div className="mob-column">
          <section className="mob-hero" aria-labelledby="mobile-home-pc-title">
            <span className="mob-hero__icon" aria-hidden="true"><MonitorPlay /></span>
            <div className="mob-hero__copy">
              <h2 className="mob-hero__title" id="mobile-home-pc-title">
                {t('mobile.pcControl.title')}
                <span className={pcControlReason ? 'mob-badge mob-badge--muted' : 'mob-badge'}>
                  {pcControlReason ? t('common.unavailable') : t('mobile.hub.ready')}
                </span>
              </h2>
              <p className="mob-hero__hint">{pcControlReason ?? t('mobile.home.pcIdleHint')}</p>
            </div>
            <button
              type="button"
              className="mob-cta"
              disabled={Boolean(pcControlReason)}
              onClick={onOpenPcControl}
              title={pcControlReason}
              data-testid="home-pc-control"
            >
              {t('mobile.home.start')}
            </button>
          </section>

          <p className="mob-eyebrow">
            <span>{t('mobile.home.recentSessions')}</span>
            <button type="button" className="mob-eyebrow__link" onClick={onOpenTerminal} data-testid="home-all-sessions">
              {t('mobile.home.allSessions', { value: sessions.length })}
            </button>
          </p>

          {recent.length === 0 ? (
            <p className="mob-empty" data-testid="home-sessions-empty">{t('mobile.sessionManager.empty')}</p>
          ) : recent.map(({ session, open }) => {
            const busy = agentSnapshot.items.some(
              (item) => item.sessionId === session.sessionId && AGENT_BUSY.has(item.status),
            );
            return (
              <button
                key={session.sessionId}
                type="button"
                className={session.sessionId === activeSessionId ? 'mob-row mob-row--active' : 'mob-row'}
                onClick={() => onOpenSession(session)}
                data-testid="home-session-row"
              >
                <span
                  className={busy ? 'mob-row__icon' : 'mob-row__icon mob-row__icon--idle'}
                  aria-hidden="true"
                >
                  <SquareTerminal />
                </span>
                <span className="mob-row__copy">
                  <span className="mob-row__title" title={session.cwd}>{formatCwd(session.cwd, 32)}</span>
                  <span className="mob-row__meta">
                    {open ? t('mobile.home.sessionOpen') : t('mobile.home.sessionOnDesktop')}
                    {busy ? ` · ${t('mobile.home.sessionBusy')}` : ''}
                  </span>
                </span>
                <span className={busy ? 'mob-dot mob-dot--live' : 'mob-dot'} aria-hidden="true" />
              </button>
            );
          })}

          {firstAttention && (
            <>
              <p className="mob-eyebrow mob-eyebrow--warning">
                <span>{t('mobile.home.agentAttention')}</span>
                <span className="mob-eyebrow__link" aria-hidden="true">{agentAttention}</span>
              </p>
              <button
                type="button"
                className="mob-row mob-row--attention"
                onClick={onOpenAgents}
                data-testid="home-agent-attention"
              >
                <span className="mob-row__icon mob-row__icon--warning" aria-hidden="true"><Bot /></span>
                <span className="mob-row__copy">
                  <span className="mob-row__title mob-row__title--body">
                    {t(`agentHub.status.${firstAttention.status}`)}
                  </span>
                  <span className="mob-row__meta mob-row__meta--warning" title={firstAttention.cwd}>
                    {formatCwd(firstAttention.cwd, 32)}
                  </span>
                </span>
                <span className="mob-row__cta">{t('agentHub.review')} →</span>
              </button>
            </>
          )}

          {showOpenClaw && (
            <button
              type="button"
              className="mob-row mob-row--openclaw"
              onClick={onOpenClaw}
              data-testid="home-openclaw"
            >
              <span className="mob-row__icon" aria-hidden="true"><Wrench /></span>
              <span className="mob-row__copy">
                <span className="mob-row__title mob-row__title--body">OpenClaw</span>
                <span className="mob-row__meta">{t('mobile.home.openClawRunning')}</span>
              </span>
              <span className="mob-row__state">
                <span className="mob-dot mob-dot--live" aria-hidden="true" />
                {t('mobile.openClaw.stateRunning')}
              </span>
              <ChevronRight className="mob-row__chevron" aria-hidden="true" />
            </button>
          )}

          <p className="mob-signal" aria-hidden="true">
            <span>EZT://REMOTE</span><span>SECURE LINK</span>
          </p>
        </div>
      </div>
    </main>
  );
}
