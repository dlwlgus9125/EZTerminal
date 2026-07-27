import {
  Activity,
  ArrowRight,
  Bot,
  Files,
  List,
  Monitor,
  Palette,
  Settings,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { RefObject } from 'react';

import type { ThemeName } from '../../src/shared/layout-schema';
import type { OpenClawStatus } from '../../src/shared/openclaw';
import { useAppTranslation } from '../../src/renderer/i18n';
import { Badge, Button, Status } from '../../src/renderer/ui';

interface HubActionProps {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly hint: string;
  readonly testId: string;
  readonly badge?: number;
  readonly status?: string;
  readonly buttonRef?: RefObject<HTMLButtonElement>;
  readonly onClick: () => void;
}

function HubAction({
  icon: Icon,
  label,
  hint,
  testId,
  badge,
  status,
  buttonRef,
  onClick,
}: HubActionProps): JSX.Element {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="mobile-hub-action"
      onClick={onClick}
      data-testid={testId}
    >
      <span className="mobile-hub-action__icon" aria-hidden="true"><Icon /></span>
      <span className="mobile-hub-action__copy">
        <span className="mobile-hub-action__title">
          {label}
          {badge !== undefined && badge > 0 && (
            <Badge size="sm" variant="warning">{badge}</Badge>
          )}
          {status && <span className="mobile-hub-action__status">{status}</span>}
        </span>
        <span className="mobile-hub-action__hint">{hint}</span>
      </span>
      <ArrowRight className="mobile-hub-action__arrow" aria-hidden="true" />
    </button>
  );
}

export function MobileRemoteHub({
  connected,
  connectionUrl,
  desktopControlSupported,
  sessionCount,
  agentAttention,
  openclawVisible,
  openclawState,
  currentTheme,
  appearanceButtonRef,
  onOpenPcControl,
  onOpenTerminal,
  onOpenSessions,
  onOpenAgents,
  onOpenFiles,
  onOpenStats,
  onOpenAppearance,
  onOpenClaw,
  onOpenSettings,
}: {
  readonly connected: boolean;
  readonly connectionUrl: string;
  readonly desktopControlSupported: boolean;
  readonly sessionCount: number;
  readonly agentAttention: number;
  readonly openclawVisible: boolean;
  readonly openclawState?: OpenClawStatus['state'];
  readonly currentTheme: ThemeName;
  readonly appearanceButtonRef?: RefObject<HTMLButtonElement>;
  readonly onOpenPcControl: () => void;
  readonly onOpenTerminal: () => void;
  readonly onOpenSessions: () => void;
  readonly onOpenAgents: () => void;
  readonly onOpenFiles: () => void;
  readonly onOpenStats: () => void;
  readonly onOpenAppearance: () => void;
  readonly onOpenClaw: () => void;
  readonly onOpenSettings: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const pcControlDisabled = !connected || !desktopControlSupported;
  const pcControlReason = !connected
    ? t('mobile.pcControl.offline')
    : !desktopControlSupported
      ? t('mobile.pcControl.unsupported')
      : undefined;

  return (
    <main className="mobile-remote-hub" data-testid="mobile-remote-hub">
      <div className="mobile-remote-hub__signal" aria-hidden="true">
        <span>EZT://REMOTE</span><span>SECURE LINK</span>
      </div>

      <header className="mobile-remote-hub__header">
        <div>
          <p className="mobile-remote-hub__eyebrow">{t('mobile.hub.eyebrow')}</p>
          <h1>{t('mobile.hub.title')}</h1>
          <p>{t('mobile.hub.description')}</p>
        </div>
        <div className="mobile-remote-hub__connection">
          <Status variant={connected ? 'success' : 'danger'} live="polite">
            {connected ? t('mobile.hub.connected') : t('mobile.hub.offline')}
          </Status>
          {connectionUrl && <span title={connectionUrl}>{connectionUrl}</span>}
        </div>
      </header>

      <section className="mobile-hub-pc-card" aria-labelledby="mobile-hub-pc-title">
        <div className="mobile-hub-pc-card__visual" aria-hidden="true">
          <Monitor />
          <span className={connected && desktopControlSupported ? 'is-ready' : undefined} />
        </div>
        <div className="mobile-hub-pc-card__copy">
          <Badge size="sm" variant={connected && desktopControlSupported ? 'success' : 'neutral'}>
            {connected && desktopControlSupported ? t('mobile.hub.ready') : t('common.unavailable')}
          </Badge>
          <h2 id="mobile-hub-pc-title">{t('mobile.pcControl.title')}</h2>
          <p>{pcControlReason ?? t('mobile.pcControl.entryHint')}</p>
        </div>
        <Button
          variant="primary"
          size="lg"
          fullWidth
          disabled={pcControlDisabled}
          onClick={onOpenPcControl}
          title={pcControlReason}
          data-testid="hub-pc-control"
        >
          {t('mobile.hub.startPcControl')}
        </Button>
      </section>

      <dl className="mobile-hub-summary" aria-label={t('mobile.hub.summary')}>
        <div>
          <dt>{t('mobile.hub.connection')}</dt>
          <dd data-testid="hub-connection-state">{connected ? t('mobile.hub.online') : t('mobile.hub.offline')}</dd>
        </div>
        <div>
          <dt>{t('mobile.hub.activeSessions')}</dt>
          <dd data-testid="hub-session-count">{sessionCount}</dd>
        </div>
        <div>
          <dt>{t('mobile.hub.agentAttention')}</dt>
          <dd data-testid="hub-agent-attention">{agentAttention}</dd>
        </div>
      </dl>

      <section className="mobile-hub-section" aria-labelledby="mobile-hub-work-title">
        <div className="mobile-hub-section__heading">
          <p>{t('mobile.hub.workEyebrow')}</p>
          <h2 id="mobile-hub-work-title">{t('mobile.hub.work')}</h2>
        </div>
        <div className="mobile-hub-grid mobile-hub-grid--primary">
          <HubAction icon={SquareTerminal} label={t('mobile.terminal')} hint={t('mobile.hub.terminalHint')} testId="hub-terminal" onClick={onOpenTerminal} />
          <HubAction icon={List} label={t('mobile.sessions')} hint={t('mobile.moreActions.sessionsHint')} testId="hub-sessions" onClick={onOpenSessions} />
          <HubAction icon={Bot} label={t('mobile.agents')} hint={t('mobile.hub.agentsHint')} badge={agentAttention} testId="hub-agents" onClick={onOpenAgents} />
          <HubAction icon={Files} label={t('mobile.files')} hint={t('mobile.moreActions.filesHint')} testId="hub-files" onClick={onOpenFiles} />
        </div>
      </section>

      <section className="mobile-hub-section" aria-labelledby="mobile-hub-tools-title">
        <div className="mobile-hub-section__heading">
          <p>{t('mobile.hub.systemEyebrow')}</p>
          <h2 id="mobile-hub-tools-title">{t('mobile.hub.tools')}</h2>
        </div>
        <div className="mobile-hub-grid">
          <HubAction icon={Activity} label={t('mobile.moreActions.stats')} hint={t('mobile.moreActions.statsHint')} testId="hub-stats" onClick={onOpenStats} />
          {openclawVisible && (
            <HubAction icon={Wrench} label="OpenClaw" hint={t('mobile.moreActions.openClawHint')} status={openclawState} testId="hub-openclaw" onClick={onOpenClaw} />
          )}
          <HubAction buttonRef={appearanceButtonRef} icon={Palette} label={t('mobile.moreActions.theme')} hint={`${t('mobile.hub.currentTheme')}: ${currentTheme}`} testId="hub-appearance" onClick={onOpenAppearance} />
          <HubAction icon={Settings} label={t('common.settings')} hint={t('mobile.moreActions.settingsHint')} testId="hub-settings" onClick={onOpenSettings} />
        </div>
      </section>
    </main>
  );
}
