import { Activity, ChevronRight, Files, List, Palette, Settings, Wrench } from 'lucide-react';
import { flushSync } from 'react-dom';
import type { RefObject } from 'react';

import type { ThemeName } from '../../src/shared/layout-schema';
import type { OpenClawStatus } from '../../src/shared/openclaw';
import { useAppTranslation } from '../../src/renderer/i18n';
import { MobileActionSheet } from './MobileActionSheet';
import { useMobileNavigationHistory } from './MobileNavigationHistory';
import { OPENCLAW_STATE_LABEL_KEY } from './openclaw-mode';

/**
 * The "More" tab's bottom sheet. Everything the five-item bar cannot hold
 * lives here; OpenClaw is ALWAYS listed (unlike the conditional Home row) so
 * the auto/on/off visibility policy still has a reachable entry point.
 */
export function MobileMoreSheet({
  currentTheme,
  openclawVisible,
  openclawState,
  updateAvailable = false,
  returnFocusRef,
  onClose,
  onOpenSessions,
  onOpenFiles,
  onOpenStats,
  onOpenClaw,
  onOpenTheme,
  onOpenSettings,
}: {
  readonly currentTheme: ThemeName;
  readonly openclawVisible: boolean;
  readonly openclawState?: OpenClawStatus['state'];
  readonly updateAvailable?: boolean;
  readonly returnFocusRef?: RefObject<HTMLElement>;
  readonly onClose: () => void;
  readonly onOpenSessions: () => void;
  readonly onOpenFiles: () => void;
  readonly onOpenStats: () => void;
  readonly onOpenClaw: () => void;
  readonly onOpenTheme: (trigger: HTMLElement) => void;
  readonly onOpenSettings: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const navigation = useMobileNavigationHistory();

  // Every row here turns this SHEET into a PAGE. Without `replaceTopLayer`
  // the sheet's release and the page's push each touch history independently,
  // which leaks one entry per transition — after a few rounds Android Back
  // walks past the app root and Capacitor exits the app. This is exactly the
  // case the coordinator's sheet-to-page test pins down: pop the sheet's stop
  // first, unmount it synchronously, then let the page REPLACE its entry.
  const replaceWith = (open: () => void) => (): void => {
    navigation.replaceTopLayer(() => {
      flushSync(onClose);
      open();
    });
  };

  return (
    <MobileActionSheet
      title={t('mobile.tabs.more')}
      className="mob-sheet"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      testId="mobile-more-sheet"
    >
      <button type="button" className="mobile-action-sheet-row" onClick={replaceWith(onOpenSessions)} data-testid="more-sessions">
        <List aria-hidden="true" />
        <span className="mobile-action-sheet-row-label">{t('mobile.sessions')}</span>
      </button>
      <button type="button" className="mobile-action-sheet-row" onClick={replaceWith(onOpenFiles)} data-testid="more-files">
        <Files aria-hidden="true" />
        <span className="mobile-action-sheet-row-label">{t('mobile.files')}</span>
      </button>
      <button type="button" className="mobile-action-sheet-row" onClick={replaceWith(onOpenStats)} data-testid="more-stats">
        <Activity aria-hidden="true" />
        <span className="mobile-action-sheet-row-label">{t('mobile.moreActions.stats')}</span>
      </button>
      {openclawVisible && (
        <button type="button" className="mobile-action-sheet-row" onClick={replaceWith(onOpenClaw)} data-testid="more-openclaw">
          <Wrench aria-hidden="true" />
          <span className="mobile-action-sheet-row-label">OpenClaw</span>
          <span className="mob-sheet__state" data-testid="more-openclaw-state">
            {openclawState === 'running' && <span className="mob-dot mob-dot--live" aria-hidden="true" />}
            {openclawState ? t(OPENCLAW_STATE_LABEL_KEY[openclawState]) : t('mobile.moreActions.checking')}
          </span>
        </button>
      )}
      <button
        type="button"
        className="mobile-action-sheet-row"
        onClick={(event) => { const trigger = event.currentTarget; replaceWith(() => onOpenTheme(trigger))(); }}
        data-testid="more-theme"
      >
        <Palette aria-hidden="true" />
        <span className="mobile-action-sheet-row-label">{t('mobile.moreActions.theme')}</span>
        <span className="mob-sheet__value">{currentTheme}</span>
      </button>
      <button
        type="button"
        className="mobile-action-sheet-row"
        onClick={replaceWith(onOpenSettings)}
        aria-label={updateAvailable
          ? `${t('common.settings')}. ${t('settings.update.badge')}`
          : undefined}
        data-testid="more-settings"
      >
        <Settings aria-hidden="true" />
        <span className="mobile-action-sheet-row-label">{t('common.settings')}</span>
        {updateAvailable && <span className="mobile-update-dot" aria-hidden="true" />}
        <ChevronRight aria-hidden="true" />
      </button>
    </MobileActionSheet>
  );
}
