import { useEffect, useRef } from 'react';

import type { CompletionList } from './terminal-completion-state';

/**
 * The completion candidates over the prompt line: a listbox the command input
 * points at (`aria-activedescendant`), so focus stays in the input while the
 * arrows move through it.
 */
export function TerminalCompletionList({ id, list, label, moreLabel, onChoose }: {
  readonly id: string;
  readonly list: CompletionList;
  readonly label: string;
  /** Said under the list when more matched than are shown. */
  readonly moreLabel: string;
  readonly onChoose: (index: number) => void;
}): JSX.Element {
  const listRef = useRef<HTMLUListElement>(null);
  // The active candidate stays in view while the arrows move through a long list.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [list.active]);
  return (
    <div className="term-completion" data-testid="terminal-completion">
      <ul ref={listRef} id={id} role="listbox" className="term-completion__list" aria-label={label}>
        {list.candidates.map((candidate, index) => (
          <li
            key={`${candidate.kind}:${candidate.label}`}
            id={`${id}-${index}`}
            role="option"
            aria-selected={index === list.active}
            className="term-completion__option"
            data-kind={candidate.kind}
            data-testid="terminal-completion-option"
            // Mouse down, not click: the input keeps the focus.
            onMouseDown={(event) => { event.preventDefault(); onChoose(index); }}
          >
            {candidate.label}
          </li>
        ))}
      </ul>
      {list.truncated && <p className="term-completion__more">{moreLabel}</p>}
    </div>
  );
}
