import { useCallback, useRef } from 'react';

import type { TerminalPasteRisk } from '../shared/terminal-clipboard';
import { useAppTranslation } from './i18n';
import { Button, Dialog } from './ui';

export interface TerminalPasteWarningDialogProps {
  readonly risk: TerminalPasteRisk;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function TerminalPasteWarningDialog({
  risk,
  onCancel,
  onConfirm,
}: TerminalPasteWarningDialogProps): JSX.Element {
  const { t } = useAppTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cancelCallbackRef = useRef(onCancel);
  cancelCallbackRef.current = onCancel;
  const handleOpenChange = useCallback((open: boolean): void => {
    if (!open) cancelCallbackRef.current();
  }, []);

  return (
    <Dialog
      open
      onOpenChange={handleOpenChange}
      title={t('terminalPasteWarning.title')}
      description={t('terminalPasteWarning.description')}
      role="alertdialog"
      size="sm"
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
      <ul className="terminal-paste-warning__details">
        {risk.multiline && (
          <li>{t('terminalPasteWarning.multiline', { count: risk.lineCount })}</li>
        )}
        {risk.large && (
          <li>{t('terminalPasteWarning.large', { count: risk.byteLength })}</li>
        )}
      </ul>
    </Dialog>
  );
}
