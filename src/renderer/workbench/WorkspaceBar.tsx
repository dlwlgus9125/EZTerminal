import { Columns2, Rows2, Square } from 'lucide-react';

import { useAppTranslation } from '../i18n';

export interface WorkspaceBarProps {
  /** Applied preset name, or null when the layout is unsaved/ad hoc. */
  readonly presetName: string | null;
  readonly paneCount: number;
  readonly onApplyTwoByOne: () => void;
  readonly onApplyOnePlusTwo: () => void;
  readonly onApplySingle: () => void;
}

/**
 * Names the current workspace and puts layout one click away.
 *
 * Splitting already existed in the Workspace dropdown, the Command Center, the
 * tab context menu, and on the keyboard. What did not exist was any surface
 * that says *which* layout you are looking at, or lets you change it without
 * first opening something. These presets move existing Dockview panels; they
 * never create or destroy terminal sessions.
 */
export function WorkspaceBar({
  presetName,
  paneCount,
  onApplyTwoByOne,
  onApplyOnePlusTwo,
  onApplySingle,
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
          onClick={onApplyTwoByOne}
          disabled={paneCount < 2}
          title={t('workspace.layoutTwoByOneDescription')}
          data-testid="workspace-bar-layout-two-by-one"
        >
          <Columns2 aria-hidden="true" />
          {t('workspace.layoutTwoByOne')}
        </button>
        <button
          type="button"
          className="workspace-bar__chip"
          onClick={onApplyOnePlusTwo}
          disabled={paneCount < 2}
          title={t('workspace.layoutOnePlusTwoDescription')}
          data-testid="workspace-bar-layout-one-plus-two"
        >
          <Rows2 aria-hidden="true" />
          {t('workspace.layoutOnePlusTwo')}
        </button>
        <button
          type="button"
          className="workspace-bar__chip"
          onClick={onApplySingle}
          disabled={paneCount < 2}
          title={t('workspace.layoutSingleDescription')}
          data-testid="workspace-bar-layout-single"
        >
          <Square aria-hidden="true" />
          {t('workspace.layoutSingle')}
        </button>
      </span>
    </div>
  );
}
