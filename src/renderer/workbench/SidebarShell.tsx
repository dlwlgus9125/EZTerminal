import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '../../shared/ui-preferences';
import { useAppTranslation } from '../i18n';
import { PanelShell } from '../ui';
import type { SidebarDestination } from './types';

function clampWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

export function SidebarShell({
  children,
  destination,
  description,
  onClose,
  onWidthChange,
  title,
  width,
}: {
  readonly children: ReactNode;
  readonly destination: SidebarDestination;
  readonly description?: ReactNode;
  readonly onClose: () => void;
  readonly onWidthChange: (width: number) => void;
  readonly title: ReactNode;
  readonly width: number;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [previewWidth, setPreviewWidth] = useState(() => clampWidth(width));
  const invokerRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);

  useEffect(() => setPreviewWidth(clampWidth(width)), [width]);

  const dismiss = useCallback((): void => {
    onClose();
    requestAnimationFrame(() => invokerRef.current?.focus());
  }, [onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A modal owns Escape while it is mounted. This guard is intentionally
      // independent of document-listener registration order: SidebarShell may
      // receive the event before the dialog has a chance to preventDefault().
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      dismiss();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dismiss]);

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startWidth = previewWidth;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent): void => setPreviewWidth(clampWidth(startWidth + move.clientX - startX));
    const onEnd = (): void => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onEnd);
      target.removeEventListener('pointercancel', onEnd);
      setPreviewWidth((current) => {
        onWidthChange(current);
        return current;
      });
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onEnd);
    target.addEventListener('pointercancel', onEnd);
  };

  const resizeByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = clampWidth(previewWidth + (event.key === 'ArrowRight' ? 8 : -8));
    setPreviewWidth(next);
    onWidthChange(next);
  };

  return (
    <>
      <button className="workbench-sidebar-scrim" aria-label={t('workbench.closePanel')} onClick={dismiss} />
      <PanelShell
        as="aside"
        className="workbench-sidebar"
        data-destination={destination}
        style={{ width: previewWidth }}
        title={title}
        description={description}
        onClose={dismiss}
        closeLabel={t('workbench.closePanel')}
        data-testid="workbench-sidebar"
      >
        {children}
        <div
          className="workbench-sidebar-resizer"
          role="separator"
          aria-label={t('workbench.resizeSidebar')}
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={previewWidth}
          data-testid="sidebar-resizer"
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={resizeByKeyboard}
        />
      </PanelShell>
    </>
  );
}
