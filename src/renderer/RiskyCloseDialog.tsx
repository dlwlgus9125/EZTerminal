import { useCallback, useRef } from 'react';

import { useAppTranslation } from './i18n';
import { Button, Dialog } from './ui';

export interface RiskyCloseDialogProps {
  readonly title: string;
  readonly description: string;
  readonly details?: readonly string[];
  readonly confirmLabel: string;
  /** Middle course, offered only when the work can outlive the pane. */
  readonly alternateLabel?: string;
  readonly onAlternate?: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

/**
 * Confirmation for an action that destroys live work.
 *
 * Built on the shared Dialog rather than hand-rolling a second one. It used to
 * carry its own backdrop, focus trap, Escape handling, and z-index, which meant
 * the most consequential dialog in the product was the one that shared none of
 * the system's behaviour — and drifted from it every time the primitive
 * improved.
 */
export function RiskyCloseDialog({
  title,
  description,
  details = [],
  confirmLabel,
  alternateLabel,
  onAlternate,
  onCancel,
  onConfirm,
}: RiskyCloseDialogProps): JSX.Element {
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
      title={title}
      description={description}
      role="alertdialog"
      size="sm"
      tone="danger"
      // Cancel takes focus, so the destructive action is never one stray Enter
      // away, and the close affordance is the same one every dialog has.
      initialFocusRef={cancelRef}
      closeLabel={t('common.cancel')}
      testId="risky-close-dialog"
      footer={(
        <>
          <Button
            ref={cancelRef}
            variant="secondary"
            onClick={onCancel}
            data-testid="risky-close-cancel"
          >
            {t('common.cancel')}
          </Button>
          {alternateLabel && onAlternate && (
            <Button variant="secondary" onClick={onAlternate} data-testid="risky-close-alternate">
              {alternateLabel}
            </Button>
          )}
          <Button variant="danger" onClick={onConfirm} data-testid="risky-close-confirm">
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {details.length > 0 && (
        <ul className="risky-close-details">
          {details.map((detail) => <li key={detail}>{detail}</li>)}
        </ul>
      )}
    </Dialog>
  );
}
