import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useNativeOverlayRegistration } from './native-overlay';
import { isDomNode, isFocusableHTMLElement } from './ui/utils';

export interface TerminalContextMenuItem {
  /** Used verbatim in `data-testid="term-ctx-<action>"` — keep these stable, e2e depends on them. */
  readonly action: string;
  readonly label: string;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}

export type TerminalContextMenuCloseDetail =
  | {
    readonly reason: 'action';
    readonly action: string;
    readonly target: EventTarget | null;
  }
  | {
    readonly reason: 'escape' | 'outside';
    readonly target: EventTarget | null;
  };

export interface TerminalContextMenuInvocation {
  readonly x: number;
  readonly y: number;
  readonly invoker: HTMLElement | null;
  readonly originPane: Element | null;
}

interface TerminalContextMenuProps {
  /** Cursor position at the triggering `contextmenu` event (viewport coordinates). */
  readonly x: number;
  readonly y: number;
  readonly items: readonly TerminalContextMenuItem[];
  readonly onClose: (detail: TerminalContextMenuCloseDetail) => void;
  readonly ariaLabel?: string;
  readonly shortcutLabel?: (shortcut: string) => string;
  readonly testId?: string;
  readonly itemTestIdPrefix?: string;
  readonly ownerDocument?: Document;
}

export function isTerminalContextMenuKey(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey'>,
): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
}

/** The close event is known before browser focus follows an outside
 * mousedown. Check both that target and the latest active element so an async
 * unmount/rAF can never drag focus back from another pane. */
export function mayRestoreTerminalContextMenuFocus(
  originPane: Element | null,
  detail: TerminalContextMenuCloseDetail,
  activeElement: Element | null = originPane?.ownerDocument.activeElement ?? document.activeElement,
): boolean {
  if (!originPane?.isConnected) return false;
  const ownerDocument = originPane.ownerDocument;
  if (
    detail.reason === 'outside'
    && isDomNode(detail.target)
    && !originPane.contains(detail.target)
  ) {
    return false;
  }
  if (activeElement === null || activeElement === ownerDocument.body) return true;
  const activePane = activeElement.closest('.pane');
  return activePane === null || activePane === originPane;
}

export function captureTerminalContextMenuInvocation(
  host: HTMLElement,
  x: number,
  y: number,
): TerminalContextMenuInvocation {
  const originPane = host.closest('.pane');
  const active = host.ownerDocument.activeElement;
  return {
    x,
    y,
    invoker: isFocusableHTMLElement(active) && originPane?.contains(active) ? active : null,
    originPane,
  };
}

export function keyboardTerminalContextMenuInvocation(
  host: HTMLElement,
): TerminalContextMenuInvocation {
  const rect = host.getBoundingClientRect();
  return captureTerminalContextMenuInvocation(
    host,
    rect.left + Math.min(24, Math.max(8, rect.width / 2)),
    rect.top + Math.min(24, Math.max(8, rect.height / 2)),
  );
}

export function closeTerminalContextMenu(
  invocation: TerminalContextMenuInvocation,
  detail: TerminalContextMenuCloseDetail,
  clear: () => void,
  fallbackFocus: () => void,
  afterFocus?: () => void,
): void {
  const shouldRestore = mayRestoreTerminalContextMenuFocus(invocation.originPane, detail);
  clear();
  if (!shouldRestore) return;
  const ownerDocument = invocation.originPane?.ownerDocument ?? document;
  const ownerWindow = ownerDocument.defaultView ?? window;
  ownerWindow.requestAnimationFrame(() => {
    if (!mayRestoreTerminalContextMenuFocus(invocation.originPane, detail)) return;
    const active = ownerDocument.activeElement;
    if (
      active !== null
      && active !== ownerDocument.body
      && active !== invocation.invoker
      && !active.closest('.terminal-context-menu')
    ) {
      return;
    }
    if (invocation.invoker?.isConnected) invocation.invoker.focus();
    else fallbackFocus();
    afterFocus?.();
  });
}

/**
 * Custom React context menu for the terminal (WT-parity M2) — modeled on
 * FileContextMenu.tsx's pattern (fixed-position menu driven by React state,
 * not Electron's native `Menu`, so it's e2e-testable and themed like the
 * rest of the app). Closes on an outside click, Escape, or picking any item.
 */
export function TerminalContextMenu({
  x,
  y,
  items,
  onClose,
  ariaLabel = 'Terminal actions',
  shortcutLabel = (shortcut) => `Shortcut ${shortcut}`,
  testId = 'terminal-context-menu',
  itemTestIdPrefix = 'term-ctx',
  ownerDocument = document,
}: TerminalContextMenuProps): JSX.Element {
  useNativeOverlayRegistration();
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Rendered at the raw cursor position first, then clamped to the viewport
  // once we know the menu's actual size (can't know it before first paint).
  const [pos, setPos] = useState({ left: x, top: y });
  const [activeIndex, setActiveIndex] = useState(() => items.findIndex((item) => !item.disabled));

  const enabledIndexes = items.reduce<number[]>((indexes, item, index) => {
    if (!item.disabled) indexes.push(index);
    return indexes;
  }, []);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ownerWindow = ownerDocument.defaultView ?? window;
    const left = Math.max(4, Math.min(x, ownerWindow.innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(y, ownerWindow.innerHeight - rect.height - 4));
    setPos({ left, top });
  }, [ownerDocument, x, y]);

  useLayoutEffect(() => {
    if (activeIndex >= 0 && !items[activeIndex]?.disabled) return;
    setActiveIndex(enabledIndexes[0] ?? -1);
  }, [activeIndex, enabledIndexes, items]);

  useLayoutEffect(() => {
    if (activeIndex >= 0) itemRefs.current[activeIndex]?.focus();
    else menuRef.current?.focus();
  }, [activeIndex]);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose({ reason: 'outside', target: e.target });
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose({ reason: 'escape', target: e.target });
      }
    };
    const ownerWindow = ownerDocument.defaultView ?? window;
    ownerDocument.addEventListener('mousedown', onDocMouseDown);
    ownerWindow.addEventListener('keydown', onKey);
    return () => {
      ownerDocument.removeEventListener('mousedown', onDocMouseDown);
      ownerWindow.removeEventListener('keydown', onKey);
    };
  }, [onClose, ownerDocument]);

  const activate = (index: number, target: EventTarget | null): void => {
    const item = items[index];
    if (!item || item.disabled) return;
    item.onClick();
    onClose({ reason: 'action', action: item.action, target });
  };

  const move = (direction: 1 | -1): void => {
    if (enabledIndexes.length === 0) return;
    const current = enabledIndexes.indexOf(activeIndex);
    const next = current < 0
      ? (direction > 0 ? 0 : enabledIndexes.length - 1)
      : (current + direction + enabledIndexes.length) % enabledIndexes.length;
    setActiveIndex(enabledIndexes[next]);
  };

  return createPortal((
    <div
      ref={menuRef}
      className="terminal-context-menu"
      data-testid={testId}
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={(event) => {
        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault();
            event.stopPropagation();
            move(1);
            break;
          case 'ArrowUp':
            event.preventDefault();
            event.stopPropagation();
            move(-1);
            break;
          case 'Home':
            event.preventDefault();
            event.stopPropagation();
            if (enabledIndexes.length > 0) setActiveIndex(enabledIndexes[0]);
            break;
          case 'End':
            event.preventDefault();
            event.stopPropagation();
            if (enabledIndexes.length > 0) setActiveIndex(enabledIndexes[enabledIndexes.length - 1] ?? -1);
            break;
          case 'Enter':
          case ' ':
            event.preventDefault();
            event.stopPropagation();
            activate(activeIndex, event.target);
            break;
          case 'Escape':
            // The window listener owns Escape so there is exactly one close.
            event.stopPropagation();
            event.preventDefault();
            onClose({ reason: 'escape', target: event.target });
            break;
        }
      }}
    >
      {items.map((item, index) => (
        <button
          key={item.action}
          ref={(element) => {
            itemRefs.current[index] = element;
          }}
          className="terminal-context-menu-item"
          data-testid={`${itemTestIdPrefix}-${item.action}`}
          role="menuitem"
          tabIndex={index === activeIndex ? 0 : -1}
          disabled={item.disabled}
          aria-disabled={item.disabled || undefined}
          onFocus={() => {
            if (!item.disabled) setActiveIndex(index);
          }}
          onClick={(event) => activate(index, event.currentTarget)}
        >
          <span>{item.label}</span>
          {item.shortcut && <kbd aria-label={shortcutLabel(item.shortcut)}>{item.shortcut}</kbd>}
        </button>
      ))}
    </div>
  ), ownerDocument.body);
}
