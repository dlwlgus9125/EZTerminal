/**
 * FindBar — T12 scope.
 * Search bar that appears above the terminal (Ctrl+F).
 * Uses SearchAddon.findNext() for highlighting.
 * ESC closes and refocuses terminal.
 */

import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";
import styles from "./FindBar.module.css";

export interface FindBarHandle {
  findNext: (query: string, opts?: { caseSensitive?: boolean }) => boolean;
}

interface FindBarProps {
  onClose: () => void;
  onSearch: (query: string) => boolean;
}

export function FindBar({ onClose, onSearch }: FindBarProps): ReactElement {
  const [query, setQuery] = useState("");
  const [noResults, setNoResults] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleChange(e: ChangeEvent<HTMLInputElement>): void {
    const value = e.target.value;
    setQuery(value);
    if (value.length === 0) {
      setNoResults(false);
      return;
    }
    const found = onSearch(value);
    setNoResults(!found);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (query.length > 0) {
        const found = onSearch(query);
        setNoResults(!found);
      }
    }
  }

  return (
    <div className={styles.findBar} data-testid="find-bar">
      <input
        ref={inputRef}
        className={styles.input}
        data-testid="find-bar-input"
        type="text"
        value={query}
        placeholder="Find..."
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      {noResults && (
        <span className={styles.noResults} data-testid="find-bar-no-results">
          No results
        </span>
      )}
      <button
        className={styles.closeBtn}
        data-testid="find-bar-close"
        type="button"
        aria-label="Close find bar"
        onClick={onClose}
      >
        x
      </button>
    </div>
  );
}
