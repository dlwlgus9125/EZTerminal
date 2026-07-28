import type { RemoteDesktopHostStatus } from '../../shared/ipc';
import { useAppTranslation } from '../i18n';
import { useUiPreferences } from '../ui-preferences';

export interface StatusBarProps {
  readonly attentionCount: number;
  /** Remote desktop host status, or null while it is still unknown. */
  readonly remoteDesktop: RemoteDesktopHostStatus | null;
  readonly effectIntensity: number;
}

/**
 * Always-visible footer strip.
 *
 * Deliberately carries only values the app actually has. The design also drew
 * instantaneous network throughput and a GPU-acceleration flag; throughput is
 * collected only while the Monitor panel is open, so a footer field for it
 * would read empty almost always, and nothing in the renderer reports the GPU
 * state at all. Rather than render dashes, those fields are absent — a status
 * bar that shows blanks teaches people to stop reading it.
 */
export function StatusBar({
  attentionCount,
  remoteDesktop,
  effectIntensity,
}: StatusBarProps): JSX.Element {
  const { i18n, t } = useAppTranslation();
  const { updatePreferences } = useUiPreferences();
  const korean = (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith('ko');
  const rtt = remoteDesktop?.roundTripTimeMs ?? null;

  return (
    <footer className="workbench-status-bar" data-testid="workbench-status-bar">
      <span
        className="workbench-status-bar__item workbench-status-bar__item--live"
        data-state={remoteDesktop?.state ?? 'idle'}
      >
        <i className="workbench-status-bar__dot" aria-hidden="true" />
        {remoteDesktop
          ? t(`remote.pcControlState.${remoteDesktop.state}` as 'remote.pcControlState.idle')
          : t('statusBar.local')}
      </span>

      {remoteDesktop?.controllerName && (
        <span className="workbench-status-bar__item" data-testid="status-bar-mirror">
          {t('statusBar.mirror', { name: remoteDesktop.controllerName })}
        </span>
      )}

      {rtt !== null && (
        <span className="workbench-status-bar__item" data-testid="status-bar-rtt">
          {`${rtt} ms`}
        </span>
      )}

      {attentionCount > 0 && (
        <span className="workbench-status-bar__item workbench-status-bar__item--attention">
          {t('statusBar.attention', { count: attentionCount })}
        </span>
      )}

      {/* The one control in the strip. The design put language a click away at
          all times rather than buried in Settings, and the preference already
          exists, so this is a second entry point to one setting — not a second
          implementation of it. */}
      <button
        type="button"
        className="workbench-status-bar__toggle"
        onClick={() => void updatePreferences({ locale: korean ? 'en' : 'ko' })}
        data-testid="status-bar-locale"
      >
        {korean ? '한국어' : 'EN'}
      </button>

      <span className="workbench-status-bar__item workbench-status-bar__item--fx">
        {`FX · NEON ${effectIntensity}`}
      </span>
    </footer>
  );
}
