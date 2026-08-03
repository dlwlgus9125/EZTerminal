import { useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from './i18n';
import { Button, Dialog } from './ui';

export type AuxiliaryCloseChoice = 'terminate' | 'keep';

export interface AuxiliaryRiskyPane {
  readonly panelId: string;
  readonly title: string;
  readonly risk: string;
}

export interface AuxiliaryCloseDialogProps {
  readonly requestId: string;
  readonly paneCount: number;
  readonly riskyPanes: readonly AuxiliaryRiskyPane[];
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (choices: ReadonlyMap<string, AuxiliaryCloseChoice>) => void;
}

export function AuxiliaryCloseDialog({
  requestId,
  paneCount,
  riskyPanes,
  busy,
  onCancel,
  onConfirm,
}: AuxiliaryCloseDialogProps): JSX.Element {
  const { t } = useAppTranslation();
  const [choices, setChoices] = useState<Record<string, AuxiliaryCloseChoice>>({});
  useEffect(() => setChoices({}), [requestId]);
  const complete = useMemo(
    () => riskyPanes.every((pane) => choices[pane.panelId] !== undefined),
    [choices, riskyPanes],
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
      title={t('safetyDialog.closeAuxiliaryTitle')}
      description={t('safetyDialog.closeAuxiliaryDescription', { count: paneCount })}
      role="alertdialog"
      tone="warning"
      dismissible={!busy}
      closeOnBackdrop={false}
      testId="auxiliary-close-dialog"
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={busy || !complete}
            onClick={() => onConfirm(new Map(Object.entries(choices)))}
            data-testid="auxiliary-close-confirm"
          >
            {busy ? t('common.loading') : t('safetyDialog.closeWindow')}
          </Button>
        </>
      )}
    >
      <p className="auxiliary-close-summary">
        {t('safetyDialog.safeSessionsTerminate')}
      </p>
      {riskyPanes.length > 0 && (
        <div className="auxiliary-close-list">
          {riskyPanes.map((pane) => (
            <fieldset className="auxiliary-close-pane" key={pane.panelId}>
              <legend>{pane.title}</legend>
              <p>{pane.risk}</p>
              <label>
                <input
                  type="radio"
                  name={`auxiliary-close-${pane.panelId}`}
                  value="terminate"
                  checked={choices[pane.panelId] === 'terminate'}
                  disabled={busy}
                  onChange={() => setChoices((current) => ({
                    ...current,
                    [pane.panelId]: 'terminate',
                  }))}
                />
                <span>{t('safetyDialog.closeTerminal')}</span>
              </label>
              <label>
                <input
                  type="radio"
                  name={`auxiliary-close-${pane.panelId}`}
                  value="keep"
                  checked={choices[pane.panelId] === 'keep'}
                  disabled={busy}
                  onChange={() => setChoices((current) => ({
                    ...current,
                    [pane.panelId]: 'keep',
                  }))}
                />
                <span>{t('safetyDialog.keepInBackground')}</span>
              </label>
            </fieldset>
          ))}
        </div>
      )}
    </Dialog>
  );
}
