import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

export interface FileContextMenuItem {
  /** Used verbatim in `data-testid="ctx-<action>"` — keep these stable, e2e depends on them. */
  readonly action: string;
  readonly label: string;
  readonly onSelect: () => void;
}

interface FileContextMenuProps {
  /** Cursor position at the triggering `contextmenu` event (viewport coordinates). */
  readonly x: number;
  readonly y: number;
  readonly items: readonly FileContextMenuItem[];
  readonly onClose: () => void;
}

/**
 * Custom React context menu for the file explorer (file-explorer plan, M2) —
 * modeled on App.tsx's `.preset-menu` dropdown, NOT Electron's native `Menu`
 * (a requirement, not a preference: the plan wants this fully driven by React
 * state so it can be e2e-tested and themed like the rest of the app). Closes
 * on an outside click, Escape, or picking any item.
 */
export function FileContextMenu({ x, y, items, onClose }: FileContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(true);
  // Rendered at the raw cursor position first, then clamped to the viewport
  // once we know the menu's actual size (can't know it before first paint).
  const [pos, setPos] = useState({ left: x, top: y });

  const close = useCallback((restoreFocus = true): void => {
    restoreFocusRef.current = restoreFocus;
    onClose();
  }, [onClose]);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const animationFrame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    return () => {
      cancelAnimationFrame(animationFrame);
      if (!restoreFocusRef.current) return;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active === document.body || !(active instanceof HTMLElement) || !document.contains(active)) {
          previousFocusRef.current?.focus();
        }
      });
    };
  }, []);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
    };
  }, [close]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const menuItems = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    );
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      close(false);
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && document.activeElement instanceof HTMLButtonElement) {
      event.preventDefault();
      document.activeElement.click();
      return;
    }
    if (menuItems.length === 0 || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? menuItems.length - 1
        : event.key === 'ArrowDown'
          ? (Math.max(currentIndex, -1) + 1) % menuItems.length
          : (currentIndex <= 0 ? menuItems.length : currentIndex) - 1;
    menuItems[nextIndex]?.focus();
  };

  return (
    <div
      ref={menuRef}
      className="file-context-menu"
      data-testid="file-context-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={handleKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="file-context-menu-item"
          data-testid={`ctx-${item.action}`}
          onClick={() => {
            item.onSelect();
            close();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
