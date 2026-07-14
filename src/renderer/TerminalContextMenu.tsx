import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface TerminalContextMenuItem {
  /** Used verbatim in `data-testid="term-ctx-<action>"` — keep these stable, e2e depends on them. */
  readonly action: string;
  readonly label: string;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}

export interface TerminalContextMenuCloseDetail {
  readonly reason: 'action' | 'escape' | 'outside';
  readonly target: EventTarget | null;
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
  activeElement: Element | null = document.activeElement,
): boolean {
  if (!originPane?.isConnected) return false;
  if (
    detail.reason === 'outside'
    && detail.target instanceof Node
    && !originPane.contains(detail.target)
  ) {
    return false;
  }
  if (activeElement === null || activeElement === document.body) return true;
  const activePane = activeElement.closest('.pane');
  return activePane === null || activePane === originPane;
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
}: TerminalContextMenuProps): JSX.Element {
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
    const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
    setPos({ left, top });
  }, [x, y]);

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
    document.addEventListener('mousedown', onDocMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const activate = (index: number, target: EventTarget | null): void => {
    const item = items[index];
    if (!item || item.disabled) return;
    item.onClick();
    onClose({ reason: 'action', target });
  };

  const move = (direction: 1 | -1): void => {
    if (enabledIndexes.length === 0) return;
    const current = enabledIndexes.indexOf(activeIndex);
    const next = current < 0
      ? (direction > 0 ? 0 : enabledIndexes.length - 1)
      : (current + direction + enabledIndexes.length) % enabledIndexes.length;
    setActiveIndex(enabledIndexes[next]);
  };

  return (
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
            if (enabledIndexes.length > 0) setActiveIndex(enabledIndexes.at(-1) ?? -1);
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
  );
}
