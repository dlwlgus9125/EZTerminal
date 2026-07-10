import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface TerminalContextMenuItem {
  /** Used verbatim in `data-testid="term-ctx-<action>"` — keep these stable, e2e depends on them. */
  readonly action: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}

interface TerminalContextMenuProps {
  /** Cursor position at the triggering `contextmenu` event (viewport coordinates). */
  readonly x: number;
  readonly y: number;
  readonly items: readonly TerminalContextMenuItem[];
  readonly onClose: () => void;
}

/**
 * Custom React context menu for the terminal (WT-parity M2) — modeled on
 * FileContextMenu.tsx's pattern (fixed-position menu driven by React state,
 * not Electron's native `Menu`, so it's e2e-testable and themed like the
 * rest of the app). Closes on an outside click, Escape, or picking any item.
 */
export function TerminalContextMenu({ x, y, items, onClose }: TerminalContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  // Rendered at the raw cursor position first, then clamped to the viewport
  // once we know the menu's actual size (can't know it before first paint).
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="terminal-context-menu"
      data-testid="terminal-context-menu"
      style={{ left: pos.left, top: pos.top }}
    >
      {items.map((item) => (
        <button
          key={item.action}
          className="terminal-context-menu-item"
          data-testid={`term-ctx-${item.action}`}
          disabled={item.disabled}
          onClick={() => {
            item.onClick();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
