import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '../../shared/ui-preferences';
import { useAppTranslation } from '../i18n';
import { PanelShell } from '../ui';
import { isolateModalBackground } from '../ui/modal-isolation';
import { getFocusableElements } from '../ui/utils';
import { ACTIVITY_RAIL_ID } from './ActivityRail';
import type { SidebarDestination } from './types';

function clampWidth(width: number, maximum = MAX_SIDEBAR_WIDTH): number {
  return Math.min(maximum, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function hasNestedModal(sidebar: Element | null): boolean {
  return Array.from(document.querySelectorAll('[aria-modal="true"]'))
    .some((element) => element !== sidebar);
}

function useOverlaySidebar(overlayBelow: number): boolean {
  const query = `(max-width: ${String(Math.max(1, Math.round(overlayBelow)) - 1)}px)`;
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = (event: MediaQueryListEvent): void => setMatches(event.matches);
    setMatches(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}

function getSiblingActivityRail(layer: HTMLElement): HTMLElement | null {
  const rail = layer.parentElement?.querySelector<HTMLElement>(
    `:scope > #${ACTIVITY_RAIL_ID}.activity-rail`,
  );
  return rail ?? null;
}

function getOverlayFocusableElements(
  sidebar: HTMLElement,
  activityRail: HTMLElement | null,
): HTMLElement[] {
  return [
    ...(activityRail ? getFocusableElements(activityRail) : []),
    ...getFocusableElements(sidebar)
      .filter((element) => !element.matches('.workbench-sidebar-resizer')),
  ];
}

function containsOverlayFocus(
  sidebar: HTMLElement,
  activityRail: HTMLElement | null,
): boolean {
  const activeElement = document.activeElement;
  return sidebar.contains(activeElement) || activityRail?.contains(activeElement) === true;
}

export function SidebarShell({
  children,
  destination,
  description,
  onClose,
  onWidthChange,
  overlayBelow = 1200,
  title,
  width,
}: {
  readonly children: ReactNode;
  readonly destination: SidebarDestination;
  readonly description?: ReactNode;
  readonly onClose: () => void;
  readonly onWidthChange: (width: number) => void;
  readonly overlayBelow?: number;
  readonly title: ReactNode;
  readonly width: number;
}): JSX.Element {
  const { t } = useAppTranslation();
  const overlay = useOverlaySidebar(overlayBelow);
  const maximumWidth = overlayBelow === 1024 ? 400 : MAX_SIDEBAR_WIDTH;
  const [previewWidth, setPreviewWidth] = useState(() => clampWidth(width, maximumWidth));
  const layerRef = useRef<HTMLDivElement>(null);
  const invokerRef = useRef<HTMLElement | null>(null);

  useEffect(() => setPreviewWidth(clampWidth(width, maximumWidth)), [maximumWidth, width]);

  // Capture after React has removed the previous overlay. In particular,
  // QuickOpenModal's layout cleanup restores its stable header trigger before
  // this layout effect runs; capturing during render would retain a detached
  // result row instead.
  useLayoutEffect(() => {
    invokerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }, []);

  const dismiss = useCallback((): void => {
    onClose();
    requestAnimationFrame(() => {
      const invoker = invokerRef.current;
      if (invoker?.isConnected) invoker.focus();
    });
  }, [onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A modal owns Escape while it is mounted. This guard is intentionally
      // independent of document-listener registration order: SidebarShell may
      // receive the event before the dialog has a chance to preventDefault().
      const sidebar = layerRef.current?.querySelector('[data-testid="workbench-sidebar"]');
      if (hasNestedModal(sidebar ?? null)) return;
      event.preventDefault();
      dismiss();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dismiss]);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const sidebar = layer?.querySelector<HTMLElement>('[data-testid="workbench-sidebar"]');
    if (!overlay || !layer || !sidebar) return;

    const activityRail = getSiblingActivityRail(layer);
    const releaseBackground = isolateModalBackground(
      layer,
      activityRail ? [activityRail] : [],
    );
    const animationFrame = requestAnimationFrame(() => {
      // A product dialog can mount in the same commit and schedule its own
      // initial-focus frame. Whichever frame runs last, the nested modal owns
      // focus while it remains open.
      if (hasNestedModal(sidebar)) return;
      const focusable = getFocusableElements(sidebar)
        .filter((element) => !element.matches('.workbench-sidebar-resizer'));
      (focusable[0] ?? sidebar).focus();
    });
    const containFocus = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      if (hasNestedModal(sidebar)) return;

      const focusable = getOverlayFocusableElements(sidebar, activityRail);
      if (focusable.length === 0) {
        event.preventDefault();
        sidebar.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!containsOverlayFocus(sidebar, activityRail)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', containFocus);
    return () => {
      cancelAnimationFrame(animationFrame);
      document.removeEventListener('keydown', containFocus);
      releaseBackground();
    };
  }, [overlay]);

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startWidth = previewWidth;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent): void => setPreviewWidth(clampWidth(startWidth + move.clientX - startX, maximumWidth));
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
    const next = clampWidth(previewWidth + (event.key === 'ArrowRight' ? 8 : -8), maximumWidth);
    setPreviewWidth(next);
    onWidthChange(next);
  };

  return (
    <div
      ref={layerRef}
      className="workbench-sidebar-layer"
      data-overlay={overlay || undefined}
      data-overlay-below={overlayBelow}
      data-project-mode={overlayBelow === 1024 || undefined}
    >
      <button
        className="workbench-sidebar-scrim"
        aria-label={t('workbench.closePanel')}
        tabIndex={-1}
        onClick={dismiss}
      />
      <PanelShell
        // Keyed on the destination so swapping panels replays the entry
        // animation. Reconciliation would otherwise keep the same element and
        // the content would change with no transition at all.
        key={destination}
        as="aside"
        className="workbench-sidebar"
        data-destination={destination}
        data-project-mode={overlayBelow === 1024 || undefined}
        style={{ width: previewWidth }}
        role={overlay ? 'dialog' : undefined}
        aria-modal={overlay || undefined}
        aria-owns={overlay ? ACTIVITY_RAIL_ID : undefined}
        tabIndex={overlay ? -1 : undefined}
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
          aria-valuemax={maximumWidth}
          aria-valuenow={previewWidth}
          data-testid="sidebar-resizer"
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={resizeByKeyboard}
        />
      </PanelShell>
    </div>
  );
}
