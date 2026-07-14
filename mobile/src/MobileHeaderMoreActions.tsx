import type { RefObject } from 'react';
import { flushSync } from 'react-dom';

import type { OpenClawStatus } from '../../src/shared/openclaw';
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
  const choose = (action: () => void): void => {
    flushSync(onClose);
    action();
  };
  const remoteState = connected ? undefined : 'Offline';

  return (
    <MobileActionSheet title="More actions" onClose={onClose} returnFocusRef={triggerRef} testId="workspace-more-sheet">
      {!wide && (
        <MoreAction
          label="Sessions"
          hint="Open or create a desktop session"
          disabled={!connected}
          state={remoteState}
          onSelect={() => choose(onOpenSessions)}
          testId="more-sessions"
        />
      )}
      {!wide && (
        <MoreAction
          label="Files"
          hint="Browse the active session directory"
          disabled={!connected}
          state={remoteState}
          onSelect={() => choose(onOpenFiles)}
          testId="more-files"
        />
      )}
      <MoreAction
        label="Stats"
        hint="View remote system metrics"
        disabled={!connected}
        state={remoteState}
        onSelect={() => choose(onOpenStats)}
        testId="more-stats"
      />
      <MoreAction
        label="Theme"
        hint="Change the mobile appearance"
        state={themeName}
        onSelect={() => choose(onOpenTheme)}
        testId="more-theme"
      />
      {openclawVisible && (
        <MoreAction
          label="OpenClaw"
          hint="Open the desktop OpenClaw service"
          disabled={!connected}
          state={connected ? (openclawState ?? 'Checking') : 'Offline'}
          onSelect={() => choose(onOpenClaw)}
          testId="more-openclaw"
        />
      )}
      <MoreAction
        label="Settings"
        hint="Mobile and connection preferences"
        onSelect={() => choose(onOpenSettings)}
        testId="more-settings"
      />
    </MobileActionSheet>
  );
}
