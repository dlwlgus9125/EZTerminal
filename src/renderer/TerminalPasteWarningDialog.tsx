import { TriangleAlert } from 'lucide-react';
import { useCallback, useMemo, useRef } from 'react';

import type { TerminalPasteRisk } from '../shared/terminal-clipboard';
import { useAppTranslation } from './i18n';
import { Button, Dialog } from './ui';

export interface TerminalPasteWarningDialogProps {
  readonly risk: TerminalPasteRisk;
  readonly ownerDocument?: Document;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function TerminalPasteWarningDialog({
  risk,
  ownerDocument,
  onCancel,
  onConfirm,
}: TerminalPasteWarningDialogProps): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language),
    [i18n.language, i18n.resolvedLanguage],
  );
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cancelCallbackRef = useRef(onCancel);
  cancelCallbackRef.current = onCancel;
  const handleOpenChange = useCallback((open: boolean): void => {
    if (!open) cancelCallbackRef.current();
  }, []);

  return (
    <Dialog
      open
      ownerDocument={ownerDocument}
      onOpenChange={handleOpenChange}
      title={t('terminalPasteWarning.title')}
      description={t('terminalPasteWarning.description')}
      role="alertdialog"
      size="md"
      icon={<TriangleAlert aria-hidden="true" />}
      tone="warning"
      initialFocusRef={cancelRef}
      closeLabel={t('terminalPasteWarning.close')}
      testId="terminal-paste-warning-dialog"
      footer={(
        <>
          <Button
            ref={cancelRef}
            variant="secondary"
            onClick={onCancel}
            data-testid="terminal-paste-warning-cancel"
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            data-testid="terminal-paste-warning-confirm"
          >
            {t('terminalPasteWarning.confirm')}
          </Button>
        </>
      )}
    >
      {/* All three figures are measured from the same text, so the block always
          shows all three and marks which ones actually tripped a threshold.
          Listing only the breaches left the dialog unable to answer "how big is
          it, then?" when just one of them fired. */}
      <dl className="terminal-paste-warning__details">
        <div className="terminal-paste-warning__stat" data-breach={risk.multiline ? 'true' : undefined}>
          <dt>{t('terminalPasteWarning.statLines')}</dt>
          <dd>{numberFormatter.format(risk.lineCount)}</dd>
        </div>
        <div className="terminal-paste-warning__stat" data-breach={risk.large ? 'true' : undefined}>
          <dt>{t('terminalPasteWarning.statSize')}</dt>
          <dd>{t('terminalPasteWarning.bytes', { value: numberFormatter.format(risk.byteLength) })}</dd>
        </div>
        <div
          className="terminal-paste-warning__stat terminal-paste-warning__stat--prose"
          data-breach={risk.multiline ? 'true' : undefined}
        >
          <dt>{t('terminalPasteWarning.statShape')}</dt>
          <dd>
            {risk.multiline
              ? t('terminalPasteWarning.shapeMultiline')
              : t('terminalPasteWarning.shapeSingle')}
          </dd>
        </div>
      </dl>
    </Dialog>
  );
}
