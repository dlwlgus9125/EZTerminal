import { Columns2, Rows2, Square } from 'lucide-react';

import { useAppTranslation } from '../i18n';

export interface WorkspaceBarProps {
  /** Applied preset name, or null when the layout is unsaved/ad hoc. */
  readonly presetName: string | null;
  readonly paneCount: number;
  readonly onSplitRight: () => void;
  readonly onSplitDown: () => void;
  readonly onFocusSingle: () => void;
}

/**
 * Names the current workspace and puts layout one click away.
 *
 * Splitting already existed in the Workspace dropdown, the Command Center, the
 * tab context menu, and on the keyboard. What did not exist was any surface
 * that says *which* layout you are looking at, or lets you change it without
 * first opening something. That is what this strip adds — the same three
 * coordinator calls the other entry points make, not a fourth implementation.
 */
export function WorkspaceBar({
  presetName,
  paneCount,
  onSplitRight,
  onSplitDown,
  onFocusSingle,
}: WorkspaceBarProps): JSX.Element {
  const { t } = useAppTranslation();

  return (
    <div className="workspace-bar" data-testid="workspace-bar">
      <span className="workspace-bar__label">{t('workspace.currentLabel')}</span>
      <span className="workspace-bar__name" data-testid="workspace-bar-name">
        {presetName ?? t('workspace.unsavedLayout')}
      </span>

      <span className="workspace-bar__chips">
        <button
          type="button"
          className="workspace-bar__chip"
          onClick={onSplitRight}
          title={t('workspace.splitRight')}
          data-testid="workspace-bar-split-right"
        >
          <Columns2 aria-hidden="true" />
          {t('workspace.splitRight')}
        </button>
        <button
          type="button"
          className="workspace-bar__chip"
          onClick={onSplitDown}
          title={t('workspace.splitBelow')}
          data-testid="workspace-bar-split-down"
        >
          <Rows2 aria-hidden="true" />
          {t('workspace.splitBelow')}
        </button>
        {/* Focus, not close. Collapsing to a single pane by destroying the
            others would take live PTY sessions with it, so this maximises
            attention on the active pane instead. */}
        <button
          type="button"
          className="workspace-bar__chip"
          onClick={onFocusSingle}
          disabled={paneCount < 2}
          title={t('workspace.focusActive')}
          data-testid="workspace-bar-focus"
        >
          <Square aria-hidden="true" />
          {t('workspace.focusActive')}
        </button>
      </span>
    </div>
  );
}
