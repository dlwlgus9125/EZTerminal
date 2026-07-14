import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';

import { useAppTranslation } from './i18n';
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

function resultLabel(
  query: string,
  results: TerminalSearchResults,
  t: ReturnType<typeof useAppTranslation>['t'],
  formatCount: (value: number) => string,
): string {
  if (!query) return t('terminalFind.typeToSearch');
  if (results.resultCount === 0) return t('terminalFind.noResults');
  if (results.resultIndex < 0) {
    return results.resultCount === 1
      ? t('terminalFind.oneResult')
      : t('terminalFind.results', { value: formatCount(results.resultCount) });
  }
  const total = results.resultCount >= 1000 ? `${formatCount(1000)}+` : formatCount(results.resultCount);
  return t('terminalFind.currentOfTotal', {
    current: formatCount(results.resultIndex + 1),
    total,
  });
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
  const { t, i18n } = useAppTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="terminal-find-bar" role="search" aria-label={t('terminalFind.label')} data-testid="terminal-find-bar">
      <input
        ref={inputRef}
        type="text"
        className="terminal-find-input"
        value={query}
        aria-label={t('terminalFind.text')}
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
        {resultLabel(query, results, t, (value) => numberFormatter.format(value))}
      </span>
      <button
        type="button"
        className={caseSensitive ? 'terminal-find-action terminal-find-action--active' : 'terminal-find-action'}
        aria-label={t('terminalFind.matchCase')}
        aria-pressed={caseSensitive}
        title={t('terminalFind.matchCase')}
        onClick={() => onCaseSensitiveChange(!caseSensitive)}
      >
        Aa
      </button>
      <button
        type="button"
        className="terminal-find-action"
        aria-label={t('terminalFind.previous')}
        title={t('terminalFind.previousTitle')}
        disabled={!query}
        onClick={onPrevious}
      >
        <ChevronUp aria-hidden="true" size={16} />
      </button>
      <button
        type="button"
        className="terminal-find-action"
        aria-label={t('terminalFind.next')}
        title={t('terminalFind.nextTitle')}
        disabled={!query}
        onClick={onNext}
      >
        <ChevronDown aria-hidden="true" size={16} />
      </button>
      <button
        type="button"
        className="terminal-find-action"
        aria-label={t('terminalFind.close')}
        title={t('terminalFind.closeTitle')}
        onClick={onClose}
      >
        <X aria-hidden="true" size={16} />
      </button>
    </div>
  );
}
