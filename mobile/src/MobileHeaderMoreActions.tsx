import type { RefObject } from 'react';
import { flushSync } from 'react-dom';

import type { OpenClawStatus } from '../../src/shared/openclaw';
import { useAppTranslation } from '../../src/renderer/i18n';
import { MobileActionSheet } from './MobileActionSheet';

interface MoreActionProps {
  readonly label: string;
  readonly hint: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly state?: string;
  readonly testId: string;
}

function MoreAction({ label, hint, onSelect, disabled = false, state, testId }: MoreActionProps): JSX.Element {
  return (
    <button
      type="button"
      className="mobile-action-sheet-row"
      onClick={onSelect}
      disabled={disabled}
      aria-describedby={`${testId}-hint`}
      data-testid={testId}
    >
      <span className="mobile-action-sheet-row-copy">
        <span className="mobile-action-sheet-row-label">{label}</span>
        <span id={`${testId}-hint`} className="mobile-action-sheet-row-hint">{hint}</span>
      </span>
      {state && <span className="mobile-action-sheet-row-state">{state}</span>}
    </button>
  );
}

export function MobileHeaderMoreActions({
  wide,
  connected,
  themeName,
  openclawVisible,
  openclawState,
  triggerRef,
  onClose,
  onOpenSessions,
  onOpenFiles,
  onOpenStats,
  onOpenTheme,
  onOpenClaw,
  onOpenSettings,
}: {
  readonly wide: boolean;
  readonly connected: boolean;
  readonly themeName: string;
  readonly openclawVisible: boolean;
  readonly openclawState?: OpenClawStatus['state'];
  readonly triggerRef: RefObject<HTMLElement>;
  readonly onClose: () => void;
  readonly onOpenSessions: () => void;
  readonly onOpenFiles: () => void;
  readonly onOpenStats: () => void;
  readonly onOpenTheme: () => void;
  readonly onOpenClaw: () => void;
  readonly onOpenSettings: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const choose = (action: () => void): void => {
    flushSync(onClose);
    action();
  };
  const remoteState = connected ? undefined : t('state.offline');

  return (
    <MobileActionSheet title={t('mobile.moreActions.title')} onClose={onClose} returnFocusRef={triggerRef} testId="workspace-more-sheet">
      {!wide && (
        <MoreAction
          label={t('mobile.sessions')}
          hint={t('mobile.moreActions.sessionsHint')}
          disabled={!connected}
          state={remoteState}
          onSelect={() => choose(onOpenSessions)}
          testId="more-sessions"
        />
      )}
      {!wide && (
        <MoreAction
          label={t('mobile.files')}
          hint={t('mobile.moreActions.filesHint')}
          disabled={!connected}
          state={remoteState}
          onSelect={() => choose(onOpenFiles)}
          testId="more-files"
        />
      )}
      <MoreAction
        label={t('mobile.moreActions.stats')}
        hint={t('mobile.moreActions.statsHint')}
        disabled={!connected}
        state={remoteState}
        onSelect={() => choose(onOpenStats)}
        testId="more-stats"
      />
      <MoreAction
        label={t('mobile.moreActions.theme')}
        hint={t('mobile.moreActions.themeHint')}
        state={themeName}
        onSelect={() => choose(onOpenTheme)}
        testId="more-theme"
      />
      {openclawVisible && (
        <MoreAction
          label="OpenClaw"
          hint={t('mobile.moreActions.openClawHint')}
          disabled={!connected}
          state={connected ? (openclawState ?? t('mobile.moreActions.checking')) : t('state.offline')}
          onSelect={() => choose(onOpenClaw)}
          testId="more-openclaw"
        />
      )}
      <MoreAction
        label={t('common.settings')}
        hint={t('mobile.moreActions.settingsHint')}
        onSelect={() => choose(onOpenSettings)}
        testId="more-settings"
      />
    </MobileActionSheet>
  );
}
