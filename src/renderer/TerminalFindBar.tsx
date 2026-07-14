import { useEffect, useRef } from 'react';

import type { TerminalSearchResults } from './xterm-runtime';

export interface TerminalFindBarProps {
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly results: TerminalSearchResults;
  readonly onQueryChange: (query: string) => void;
  readonly onCaseSensitiveChange: (caseSensitive: boolean) => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly onClose: () => void;
}

function resultLabel(query: string, results: TerminalSearchResults): string {
  if (!query) return 'Type to search';
  if (results.resultCount === 0) return '0 results';
  if (results.resultIndex < 0) return `${results.resultCount} results`;
  const total = results.resultCount >= 1000 ? '1000+' : String(results.resultCount);
  return `${results.resultIndex + 1}/${total}`;
}

/** A block-local terminal search surface. It intentionally exposes literal and
 * case-sensitive search only; regex/whole-word controls are out of scope. */
export function TerminalFindBar({
  query,
  caseSensitive,
  results,
  onQueryChange,
  onCaseSensitiveChange,
  onNext,
  onPrevious,
  onClose,
}: TerminalFindBarProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="terminal-find-bar" role="search" aria-label="Find in terminal" data-testid="terminal-find-bar">
      <input
        ref={inputRef}
        type="text"
        className="terminal-find-input"
        value={query}
        aria-label="Find text"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            if (event.shiftKey) onPrevious();
            else onNext();
          }
        }}
      />
      <span className="terminal-find-count" aria-live="polite" data-testid="terminal-find-count">
        {resultLabel(query, results)}
      </span>
      <button
        type="button"
        className={caseSensitive ? 'terminal-find-action terminal-find-action--active' : 'terminal-find-action'}
        aria-label="Match case"
        aria-pressed={caseSensitive}
        title="Match case"
        onClick={() => onCaseSensitiveChange(!caseSensitive)}
      >
        Aa
      </button>
      <button
        type="button"
        className="terminal-find-action"
        aria-label="Previous result"
        title="Previous result (Shift+Enter)"
        disabled={!query}
        onClick={onPrevious}
      >
        ↑
      </button>
      <button
        type="button"
        className="terminal-find-action"
        aria-label="Next result"
        title="Next result (Enter)"
        disabled={!query}
        onClick={onNext}
      >
        ↓
      </button>
      <button
        type="button"
        className="terminal-find-action"
        aria-label="Close find"
        title="Close (Escape)"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
