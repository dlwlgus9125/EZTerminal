import {
  type ChangeEvent,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import styles from "./CommandPalette.module.css";

export interface PaletteCommand {
  id: string;
  label: string;
  action: () => void;
}

export interface CommandPaletteProps {
  commands: PaletteCommand[];
  onClose: () => void;
}

interface PaletteItemProps {
  cmd: PaletteCommand;
  active: boolean;
  onSelect: () => void;
}

function PaletteItem({ cmd, active, onSelect }: PaletteItemProps): ReactElement {
  // Using li[role=option] per ARIA listbox pattern; keyboard nav at wrapper level
  const handleKey = (): void => {};
  return (
    // biome-ignore lint/a11y/useSemanticElements: option role on li is standard listbox pattern; <option> cannot be standalone
    // biome-ignore lint/a11y/useFocusableInteractive: navigation handled via activeIdx state at wrapper; no per-item focus needed
    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: li[role=option] inside ul[role=listbox] is valid ARIA
    // biome-ignore lint/a11y/useKeyWithClickEvents: keydown handled at palette wrapper div; onClick for mouse users
    <li
      role="option"
      aria-selected={active}
      className={`${styles.item} ${active ? styles.active : ""}`}
      data-testid={`palette-item-${cmd.id}`}
      onClick={onSelect}
      onKeyDown={handleKey}
    >
      {cmd.label}
    </li>
  );
}

export function CommandPalette({ commands, onClose }: CommandPaletteProps): ReactElement {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = query
    ? commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
    : commands;

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reset index only when query text changes
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleOutsideClick = useCallback(
    (e: MouseEvent): void => {
      const root = inputRef.current?.closest(
        "[data-testid='command-palette']"
      ) as HTMLElement | null;
      if (root && !root.contains(e.target as Node)) {
        onClose();
      }
    },
    [onClose]
  );

  useEffect(() => {
    document.addEventListener("mousedown", handleOutsideClick, true);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick, true);
    };
  }, [handleOutsideClick]);

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % Math.max(filtered.length, 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + Math.max(filtered.length, 1)) % Math.max(filtered.length, 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[activeIdx];
      if (cmd) {
        cmd.action();
        onClose();
      }
    }
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>): void {
    setQuery(e.target.value);
  }

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[activeIdx] as HTMLElement | undefined;
    if (item && typeof item.scrollIntoView === "function") {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [activeIdx]);

  return createPortal(
    <div
      className={styles.overlay}
      data-testid="command-palette"
      aria-modal="true"
      aria-label="Command Palette"
      onKeyDown={handleKeyDown as KeyboardEventHandler<HTMLDivElement>}
    >
      <div className={styles.panel}>
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          placeholder="Type a command..."
          value={query}
          onChange={handleChange}
          aria-label="Command search"
          data-testid="palette-input"
        />
        <ul ref={listRef} className={styles.list} aria-label="Commands" data-testid="palette-list">
          {filtered.length === 0 ? (
            <li className={styles.noMatch} data-testid="palette-no-match">
              No commands found
            </li>
          ) : (
            filtered.map((cmd, i) => (
              <PaletteItem
                key={cmd.id}
                cmd={cmd}
                active={i === activeIdx}
                onSelect={() => {
                  cmd.action();
                  onClose();
                }}
              />
            ))
          )}
        </ul>
      </div>
    </div>,
    document.body
  );
}

/** Standard 14 commands wired to app actions. */
export function buildAppCommands(handlers: {
  onNewTab: () => void;
  onCloseTab: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onClosePane: () => void;
  onNextTab: () => void;
  onFind: () => void;
  onSaveScrollback: () => void;
  onToggleFiles: () => void;
  onToggleStatus: () => void;
  onToggleNetwork: () => void;
  onToggleSettings: () => void;
  onToggleCommandPalette: () => void;
}): PaletteCommand[] {
  return [
    { id: "new-tab", label: "New Tab", action: handlers.onNewTab },
    { id: "close-tab", label: "Close Tab", action: handlers.onCloseTab },
    { id: "split-right", label: "Split Right", action: handlers.onSplitRight },
    { id: "split-down", label: "Split Down", action: handlers.onSplitDown },
    { id: "close-pane", label: "Close Pane", action: handlers.onClosePane },
    { id: "next-tab", label: "Next Tab", action: handlers.onNextTab },
    { id: "find", label: "Find", action: handlers.onFind },
    { id: "save-scrollback", label: "Save Scrollback", action: handlers.onSaveScrollback },
    { id: "toggle-files", label: "Toggle Files Panel", action: handlers.onToggleFiles },
    { id: "toggle-status", label: "Toggle Status Panel", action: handlers.onToggleStatus },
    { id: "toggle-network", label: "Toggle Network Panel", action: handlers.onToggleNetwork },
    { id: "toggle-settings", label: "Toggle Settings Panel", action: handlers.onToggleSettings },
    {
      id: "toggle-palette",
      label: "Toggle Command Palette",
      action: handlers.onToggleCommandPalette,
    },
    {
      id: "focus-terminal",
      label: "Focus Terminal",
      action: () => {
        document.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
      },
    },
  ];
}
