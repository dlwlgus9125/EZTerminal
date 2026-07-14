import { useCallback, useEffect, useId, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const activeHistoryMarkers = new Set<string>();

export function MobileActionSheet({
  title,
  onClose,
  returnFocusRef,
  children,
  testId = 'mobile-action-sheet',
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly returnFocusRef?: RefObject<HTMLElement>;
  readonly children: React.ReactNode;
  readonly testId?: string;
}): JSX.Element {
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const dismiss = useCallback(() => {
    onCloseRef.current();
    requestAnimationFrame(() => returnFocusRef?.current?.focus());
  }, [returnFocusRef]);

  useEffect(() => {
    const sheet = sheetRef.current;
    const first = sheet?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    first?.focus();

    const marker = `ezterminal-sheet-${titleId}`;
    let historyMarkerPushed = false;
    let closedFromHistory = false;
    activeHistoryMarkers.add(marker);
    try {
      if (window.history.state?.ezterminalSheet !== marker) {
        window.history.pushState({ ...window.history.state, ezterminalSheet: marker }, '');
      }
      historyMarkerPushed = true;
    } catch {
      // History can be unavailable in an embedded/test context; Escape and the
      // explicit Cancel action remain complete dismissal paths.
    }

    const onPopState = (): void => {
      closedFromHistory = true;
      dismiss();
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      activeHistoryMarkers.delete(marker);
      // StrictMode immediately runs an effect setup/cleanup/setup probe. Delay
      // removal of the synthetic history entry until that probe has had a
      // chance to re-register the same stable marker.
      queueMicrotask(() => {
        if (
          historyMarkerPushed
          && !closedFromHistory
          && !activeHistoryMarkers.has(marker)
          && window.history.state?.ezterminalSheet === marker
        ) window.history.back();
      });
    };
  }, [dismiss, titleId]);

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
      className="mobile-action-sheet-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
      data-testid={`${testId}-backdrop`}
    >
      <div
        ref={sheetRef}
        className="mobile-action-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        data-testid={testId}
      >
        <h2 id={titleId} className="mobile-action-sheet-title">{title}</h2>
        <div className="mobile-action-sheet-list">{children}</div>
        <button type="button" className="mobile-action-sheet-row mobile-action-sheet-cancel" onClick={dismiss}>
          <span className="mobile-action-sheet-row-label">Close</span>
        </button>
      </div>
    </div>
  );
}
