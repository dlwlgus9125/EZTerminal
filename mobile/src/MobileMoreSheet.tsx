import { Activity, ChevronRight, Files, List, Palette, Settings, Wrench } from 'lucide-react';
import type { RefObject } from 'react';

import type { ThemeName } from '../../src/shared/layout-schema';
import type { OpenClawStatus } from '../../src/shared/openclaw';
import { useAppTranslation } from '../../src/renderer/i18n';
import { MobileActionSheet } from './MobileActionSheet';
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

  return (
    <MobileActionSheet
      title={t('mobile.tabs.more')}
      className="mob-sheet"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      testId="mobile-more-sheet"
    >
      <button type="button" className="mobile-action-sheet-row" onClick={onOpenSessions} data-testid="more-sessions">
        <List aria-hidden="true" />
        <span className="mobile-action-sheet-row-label">{t('mobile.sessions')}</span>
      </button>
      <button type="button" className="mobile-action-sheet-row" onClick={onOpenFiles} data-testid="more-files">
        <Files aria-hidden="true" />
        <span className="mobile-action-sheet-row-label">{t('mobile.files')}</span>
      </button>
      <button type="button" className="mobile-action-sheet-row" onClick={onOpenStats} data-testid="more-stats">
        <Activity aria-hidden="true" />
        <span className="mobile-action-sheet-row-label">{t('mobile.moreActions.stats')}</span>
      </button>
      {openclawVisible && (
        <button type="button" className="mobile-action-sheet-row" onClick={onOpenClaw} data-testid="more-openclaw">
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
        onClick={(event) => onOpenTheme(event.currentTarget)}
        data-testid="more-theme"
      >
        <Palette aria-hidden="true" />
        <span className="mobile-action-sheet-row-label">{t('mobile.moreActions.theme')}</span>
        <span className="mob-sheet__value">{currentTheme}</span>
      </button>
      <button type="button" className="mobile-action-sheet-row" onClick={onOpenSettings} data-testid="more-settings">
        <Settings aria-hidden="true" />
        <span className="mobile-action-sheet-row-label">{t('common.settings')}</span>
        <ChevronRight aria-hidden="true" />
      </button>
    </MobileActionSheet>
  );
}
