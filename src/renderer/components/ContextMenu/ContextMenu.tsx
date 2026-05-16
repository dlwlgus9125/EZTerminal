import { type KeyboardEvent, type ReactElement, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import styles from "./ContextMenu.module.css";

export interface ContextMenuItem {
  type: "item";
  id: string;
  label: string;
  disabled?: boolean;
  action: () => void;
}

export interface ContextMenuSeparator {
  type: "separator";
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}

const MENU_WIDTH = 200;
const ITEM_HEIGHT = 32;
const SEP_HEIGHT = 9;

function estimateMenuHeight(items: ContextMenuEntry[]): number {
  return items.reduce(
    (acc, item) => acc + (item.type === "separator" ? SEP_HEIGHT : ITEM_HEIGHT),
    8 // top+bottom padding
  );
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): ReactElement {
  const menuRef = useRef<HTMLUListElement>(null);

  // Boundary-aware positioning
  const menuHeight = estimateMenuHeight(items);
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const left = x + MENU_WIDTH > vpW ? Math.max(0, vpW - MENU_WIDTH) : x;
  const top = y + menuHeight > vpH ? Math.max(0, vpH - menuHeight) : y;

  // Dismiss on outside click / Escape
  useEffect(() => {
    function handleClick(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeydown(e: globalThis.KeyboardEvent): void {
      if (e.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick, true);
    document.addEventListener("keydown", handleKeydown, true);
    return () => {
      document.removeEventListener("mousedown", handleClick, true);
      document.removeEventListener("keydown", handleKeydown, true);
    };
  }, [onClose]);

  // Focus first item on mount
  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLElement>(
      "button[role='menuitem']:not([disabled])"
    );
    first?.focus();
  }, []);

  function handleKeyDown(e: KeyboardEvent<HTMLUListElement>): void {
    const focusable =
      menuRef.current?.querySelectorAll<HTMLElement>("button[role='menuitem']:not([disabled])") ??
      [];
    const arr = Array.from(focusable);
    const current = document.activeElement as HTMLElement;
    const idx = arr.indexOf(current);

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (arr.length === 0) return;
      const next = arr[(idx + 1) % arr.length];
      next?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (arr.length === 0) return;
      const prev = arr[(idx - 1 + arr.length) % arr.length];
      prev?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      (current as HTMLButtonElement)?.click();
    }
  }

  return createPortal(
    <ul
      ref={menuRef}
      role="menu"
      data-testid="context-menu"
      className={styles.menu}
      style={{ left, top }}
      onKeyDown={handleKeyDown}
    >
      {items.map((entry, i) => {
        if (entry.type === "separator") {
          // biome-ignore lint/suspicious/noArrayIndexKey: stable separator list
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: role=separator is valid ARIA for menu separators
          // biome-ignore lint/a11y/useFocusableInteractive: separators are intentionally non-focusable
          return <li key={`sep-${i}`} role="separator" className={styles.separator} />;
        }
        return (
          <li key={entry.id}>
            <button
              type="button"
              role="menuitem"
              className={styles.item}
              aria-disabled={entry.disabled ? "true" : undefined}
              disabled={entry.disabled}
              onClick={() => {
                entry.action();
                onClose();
              }}
            >
              {entry.label}
            </button>
          </li>
        );
      })}
    </ul>,
    document.body
  );
}

/** Build the standard 13-entry context menu for terminal panes. */
export function buildTerminalContextMenu(handlers: {
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onFind: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onClosePane: () => void;
  onNewTab: () => void;
  onCloseTab: () => void;
  hasSelection: boolean;
}): ContextMenuEntry[] {
  return [
    {
      type: "item",
      id: "copy",
      label: "Copy",
      disabled: !handlers.hasSelection,
      action: handlers.onCopy,
    },
    { type: "item", id: "paste", label: "Paste", action: handlers.onPaste },
    { type: "item", id: "select-all", label: "Select All", action: handlers.onSelectAll },
    { type: "separator" },
    { type: "item", id: "find", label: "Find", action: handlers.onFind },
    { type: "separator" },
    { type: "item", id: "split-right", label: "Split Right", action: handlers.onSplitRight },
    { type: "item", id: "split-down", label: "Split Down", action: handlers.onSplitDown },
    { type: "item", id: "close-pane", label: "Close Pane", action: handlers.onClosePane },
    { type: "separator" },
    { type: "item", id: "new-tab", label: "New Tab", action: handlers.onNewTab },
    { type: "item", id: "close-tab", label: "Close Tab", action: handlers.onCloseTab },
    { type: "separator" },
  ];
}
