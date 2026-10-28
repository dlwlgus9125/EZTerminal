import { Glyph } from '../ui/Glyph';

import { useAppTranslation } from '../i18n';

export interface WorkspaceBarProps {
  /** Applied preset name, or null when the layout is unsaved/ad hoc. */
  readonly presetName: string | null;
  readonly paneCount: number;
  readonly onApplyTwoByOne: () => void;
  readonly onApplyOnePlusTwo: () => void;
  readonly onApplySingle: () => void;
  readonly onApplyRows?: () => void;
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
  onApplyRows,
}: WorkspaceBarProps): JSX.Element {
  const { t, i18n } = useAppTranslation();

  return (
    <div className="workspace-bar" data-testid="workspace-bar">
      {presetName !== null && (
        <span className="workspace-bar__name" data-testid="workspace-bar-name" title={t('workspace.currentLabel')}>
          {presetName}
        </span>
      )}

      <span className="workspace-bar__chips">
        {onApplyRows && <button type="button" className="workspace-bar__chip" onClick={onApplyRows} disabled={paneCount < 2} title={i18n.language.startsWith('ko') ? '위아래' : 'Rows'} aria-label={i18n.language.startsWith('ko') ? '위아래' : 'Rows'} data-testid="workspace-bar-layout-rows"><Glyph name="rows" />{i18n.language.startsWith('ko') ? '위아래' : 'Rows'}</button>}
        <button
          type="button"
          className="workspace-bar__chip"
          onClick={onApplyTwoByOne}
          disabled={paneCount < 2}
          title={t('workspace.layoutTwoByOneDescription')}
          aria-label={t('workspace.layoutTwoByOne')}
          data-testid="workspace-bar-layout-two-by-one"
        >
          <Glyph name="cols" />
          {t('workspace.layoutTwoByOne')}
        </button>
        <button
          type="button"
          className="workspace-bar__chip"
          onClick={onApplyOnePlusTwo}
          disabled={paneCount < 2}
          title={t('workspace.layoutOnePlusTwoDescription')}
          aria-label={t('workspace.layoutOnePlusTwo')}
          data-testid="workspace-bar-layout-one-plus-two"
        >
          <Glyph name="rows" />
          {t('workspace.layoutOnePlusTwo')}
        </button>
        <button
          type="button"
          className="workspace-bar__chip"
          onClick={onApplySingle}
          disabled={paneCount < 2}
          title={t('workspace.layoutSingleDescription')}
          aria-label={t('workspace.layoutSingle')}
          data-testid="workspace-bar-layout-single"
        >
          <Glyph name="stop" />
          {t('workspace.layoutSingle')}
        </button>
      </span>
    </div>
  );
}
