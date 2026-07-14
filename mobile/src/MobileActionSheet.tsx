import { useCallback, useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';

import { useAppTranslation } from '../../src/renderer/i18n';
import { useMobileNavigationHistory } from './MobileNavigationHistory';

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function MobileActionSheet({
  title,
  description,
  onClose,
  returnFocusRef,
  children,
  className,
  contentClassName,
  closeLabel,
  focusKey = title,
  role = 'dialog',
  showCloseButton = true,
  variant = 'sheet',
  testId = 'mobile-action-sheet',
  backdropTestId = `${testId}-backdrop`,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly onClose: () => void;
  readonly returnFocusRef?: RefObject<HTMLElement>;
  readonly children: ReactNode;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly closeLabel?: string;
  readonly focusKey?: string | number;
  readonly role?: 'dialog' | 'alertdialog';
  readonly showCloseButton?: boolean;
  readonly variant?: 'sheet' | 'fullscreen';
  readonly testId?: string;
  readonly backdropTestId?: string;
}): JSX.Element {
  const { t } = useAppTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const layerId = `mobile-sheet-${useId()}`;
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const navigation = useMobileNavigationHistory();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const finishDismiss = useCallback(() => {
    onCloseRef.current();
    requestAnimationFrame(() => returnFocusRef?.current?.focus());
  }, [returnFocusRef]);

  const dismiss = useCallback(() => {
    navigation.closeLayer(layerId, 'ui');
  }, [layerId, navigation]);

  useEffect(() => {
    const sheet = sheetRef.current;
    const first = sheet?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    first?.focus();
  }, [focusKey]);

  useEffect(() => {
    return navigation.pushLayer({ id: layerId, kind: 'sheet', onBack: finishDismiss });
  }, [finishDismiss, layerId, navigation]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []);
    if (focusable.length === 0) {
      event.preventDefault();
      sheetRef.current?.focus();
      return;
    }
    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && activeIndex <= 0) {
      event.preventDefault();
      focusable[focusable.length - 1]?.focus();
    } else if (!event.shiftKey && activeIndex === focusable.length - 1) {
      event.preventDefault();
      focusable[0]?.focus();
    }
  };

  return (
    <div
      className={`mobile-action-sheet-backdrop mobile-action-sheet-backdrop--${variant}`}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
      data-testid={backdropTestId}
    >
      <div
        ref={sheetRef}
        className={`mobile-action-sheet mobile-action-sheet--${variant}${className ? ` ${className}` : ''}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        data-testid={testId}
      >
        <h2 id={titleId} className="mobile-action-sheet-title">{title}</h2>
        {description !== undefined && (
          <p id={descriptionId} className="mobile-action-sheet-description">{description}</p>
        )}
        <div className={`mobile-action-sheet-list${contentClassName ? ` ${contentClassName}` : ''}`}>{children}</div>
        {showCloseButton && (
          <button type="button" className="mobile-action-sheet-row mobile-action-sheet-cancel" onClick={dismiss}>
            <span className="mobile-action-sheet-row-label">{closeLabel ?? t('common.close')}</span>
          </button>
        )}
      </div>
    </div>
  );
}
