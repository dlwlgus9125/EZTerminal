import { useEffect, useId, useRef } from 'react';

import { useAppTranslation } from './i18n';

export interface RiskyCloseDialogProps {
  readonly title: string;
  readonly description: string;
  readonly details?: readonly string[];
  readonly confirmLabel: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function RiskyCloseDialog({
  title,
  description,
  details = [],
  confirmLabel,
  onCancel,
  onConfirm,
}: RiskyCloseDialogProps): JSX.Element {
  const { t } = useAppTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const previous = previousFocusRef.current;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [])];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      requestAnimationFrame(() => {
        if (previous?.isConnected) previous.focus();
      });
    };
  }, []);

  return (
    <div
      className={'risky-close-backdrop'}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      data-testid={'risky-close-backdrop'}
    >
      <div
        ref={dialogRef}
        className={'risky-close-dialog'}
        role={'alertdialog'}
        aria-modal={'true'}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-testid={'risky-close-dialog'}
      >
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        {details.length > 0 && (
          <ul className={'risky-close-details'}>
            {details.map((detail) => <li key={detail}>{detail}</li>)}
          </ul>
        )}
        <div className={'risky-close-actions'}>
          <button
            type={'button'}
            className={'btn btn-split'}
            onClick={onCancel}
            autoFocus
            data-testid={'risky-close-cancel'}
          >
            {t('common.cancel')}
          </button>
          <button
            type={'button'}
            className={'btn risky-close-confirm'}
            onClick={onConfirm}
            data-testid={'risky-close-confirm'}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
