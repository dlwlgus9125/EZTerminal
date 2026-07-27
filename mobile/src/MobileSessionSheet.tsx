import { Plus, SquareTerminal } from 'lucide-react';
import type { RefObject } from 'react';

import type { SessionInfo } from '../../src/shared/ipc';
import { formatCwd } from '../../src/renderer/format-cwd';
import { useAppTranslation } from '../../src/renderer/i18n';
import { MobileActionSheet } from './MobileActionSheet';
import type { HomeSessionRow } from './MobileHomeView';

/**
 * The terminal header's session picker (handoff §3). Replaces the always-on
 * tab strip with an on-demand sheet; the underlying tab state and the
 * bridge's session list are unchanged, only how they are reached.
 */
export function MobileSessionSheet({
  sessions,
  activeSessionId,
  canCreate,
  returnFocusRef,
  onClose,
  onSelect,
  onCreate,
}: {
  readonly sessions: readonly HomeSessionRow[];
  readonly activeSessionId: string | null;
  readonly canCreate: boolean;
  readonly returnFocusRef?: RefObject<HTMLElement>;
  readonly onClose: () => void;
  readonly onSelect: (session: SessionInfo) => void;
  readonly onCreate: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();

  return (
    <MobileActionSheet
      title={`${t('mobile.sessions')} · ${sessions.length}`}
      className="mob-sheet"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      showCloseButton={false}
      testId="mobile-session-sheet"
    >
      {sessions.length === 0 && (
        <p className="mob-empty" data-testid="session-sheet-empty">{t('mobile.sessionManager.empty')}</p>
      )}
      {sessions.map(({ session, open }) => (
        <button
          key={session.sessionId}
          type="button"
          className={
            session.sessionId === activeSessionId
              ? 'mob-row mob-row--active'
              : 'mob-row'
          }
          onClick={() => onSelect(session)}
          data-testid="session-sheet-row"
        >
          <span className="mob-row__icon" aria-hidden="true"><SquareTerminal /></span>
          <span className="mob-row__copy">
            <span className="mob-row__title" title={session.cwd}>{formatCwd(session.cwd, 30)}</span>
            <span className="mob-row__meta">
              {open ? t('mobile.home.sessionOpen') : t('mobile.home.sessionOnDesktop')}
            </span>
          </span>
          <span className={open ? 'mob-dot mob-dot--live' : 'mob-dot'} aria-hidden="true" />
        </button>
      ))}
      <button
        type="button"
        className="mob-sheet__new"
        onClick={onCreate}
        disabled={!canCreate}
        data-testid="session-sheet-create"
      >
        <Plus aria-hidden="true" />
        {t('mobile.home.newSession')}
      </button>
    </MobileActionSheet>
  );
}
