import { Columns2, Rows2, Save, Star, Trash2 } from 'lucide-react';

import { useAppTranslation } from '../i18n';
import { Button, IconButton, Input } from '../ui';

export function WorkspaceMenu({
  names,
  nameDraft,
  onApply,
  onDelete,
  onNameDraftChange,
  onSave,
  onSetSaving,
  onSplitDown,
  onSplitRight,
  onToggleStartup,
  saving,
  startupPreset,
}: {
  readonly names: readonly string[];
  readonly nameDraft: string;
  readonly onApply: (name: string) => void;
  readonly onDelete: (name: string) => void;
  readonly onNameDraftChange: (name: string) => void;
  readonly onSave: () => void;
  readonly onSetSaving: (saving: boolean) => void;
  readonly onSplitDown: () => void;
  readonly onSplitRight: () => void;
  readonly onToggleStartup: (name: string) => void;
  readonly saving: boolean;
  readonly startupPreset: string | null;
}): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <div
      id="workspace-menu"
      className="workspace-menu-popover"
      role="dialog"
      aria-label={t('header.workspace')}
      data-testid="preset-menu"
    >
      <div className="workspace-menu-section">
        <div className="workspace-menu-label">{t('workspace.split')}</div>
        <Button leadingIcon={<Columns2 />} variant="ghost" onClick={onSplitRight} data-testid="btn-split-right">
          {t('workspace.splitRight')}
        </Button>
        <Button leadingIcon={<Rows2 />} variant="ghost" onClick={onSplitDown} data-testid="btn-split-down">
          {t('workspace.splitBelow')}
        </Button>
      </div>
      <div className="workspace-menu-section">
        <div className="workspace-menu-label">{t('workspace.presets')}</div>
        {names.length === 0 && <div className="workspace-menu-empty">{t('workspace.noPresets')}</div>}
        {names.map((name) => (
          <div key={name} className="workspace-preset-row">
            <button
              type="button"
              className="workspace-preset-apply"
              onClick={() => onApply(name)}
              data-testid={`preset-apply-${name}`}
            >
              {name}
            </button>
            <IconButton
              icon={Star}
              aria-label={startupPreset === name
                ? t('workspace.stopAtStartup', { name })
                : t('workspace.startAtStartup', { name })}
              aria-pressed={startupPreset === name}
              onClick={() => onToggleStartup(name)}
              data-testid={`preset-star-${name}`}
            />
            <IconButton
              icon={Trash2}
              aria-label={t('workspace.deletePreset', { name })}
              variant="danger"
              onClick={() => onDelete(name)}
              data-testid={`preset-del-${name}`}
            />
          </div>
        ))}
        {saving ? (
          <div className="workspace-preset-save">
            <Input
              value={nameDraft}
              onChange={(event) => onNameDraftChange(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') onSave(); }}
              aria-label={t('workspace.presetName')}
              placeholder={t('workspace.presetName')}
              autoFocus
              data-testid="preset-name-input"
            />
            <Button leadingIcon={<Save />} onClick={onSave} data-testid="preset-save-confirm">
              {t('common.save')}
            </Button>
          </div>
        ) : (
          <Button leadingIcon={<Save />} variant="ghost" onClick={() => onSetSaving(true)} data-testid="btn-save-preset">
            {t('workspace.saveCurrent')}
          </Button>
        )}
      </div>
    </div>
  );
}
