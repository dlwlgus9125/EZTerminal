import { useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { reviewLines, type RecordedFileChange, type ReviewLine } from '../../shared/conversation-changes';
import { Button } from '../ui';

const PAGE = 400;

export type LineRange = readonly [number, number];

export function orderedRange(range: LineRange): [number, number] {
  return [Math.min(range[0], range[1]), Math.max(range[0], range[1])];
}

export interface PatchLineLabels {
  readonly showMore: string;
  /** Accessible name of one line: its number, whether it was added or removed, and its text. */
  readonly line: (line: ReviewLine) => string;
}

/**
 * One recorded patch as selectable lines: click or arrow keys move, Shift
 * extends the selection, C asks for a comment, Esc clears. The same list
 * serves the desktop Results tab and the Android review sheet.
 */
export function PatchLineList({ change, label, selection, commented, onSelect, onComment, labels }: {
  readonly change: RecordedFileChange;
  readonly label: string;
  readonly selection?: LineRange;
  /** Line indices that already carry a comment. */
  readonly commented?: ReadonlySet<number>;
  readonly onSelect: (range: LineRange | undefined) => void;
  readonly onComment?: () => void;
  readonly labels: PatchLineLabels;
}): JSX.Element {
  const lines = useMemo(() => reviewLines(change), [change]);
  const [limit, setLimit] = useState(PAGE);
  const listRef = useRef<HTMLDivElement>(null);
  const [start, end] = selection ? orderedRange(selection) : [-1, -2];
  const numbered = change.coverage === 'patch';
  const focusLine = (index: number): void => {
    listRef.current?.querySelector<HTMLButtonElement>(`[data-line-index="${String(index)}"]`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.min(Math.min(lines.length, limit) - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
      if (event.shiftKey) onSelect([selection?.[0] ?? index, next]);
      focusLine(next);
    } else if (event.key === 'Escape' && selection) {
      event.preventDefault();
      event.stopPropagation();
      onSelect(undefined);
    } else if ((event.key === 'c' || event.key === 'C') && !event.ctrlKey && !event.metaKey && !event.altKey && onComment) {
      event.preventDefault();
      if (!selection) onSelect([index, index]);
      onComment();
    }
  };
  return (
    <>
      <div ref={listRef} className="results-patch" role="group" aria-label={label} data-numbered={numbered || undefined}>
        {lines.slice(0, limit).map((line: ReviewLine, index) => (
          <button
            key={index}
            type="button"
            className="results-patch__line"
            data-kind={line.kind}
            data-line-index={index}
            data-commented={commented?.has(index) || undefined}
            aria-pressed={index >= start && index <= end}
            aria-label={labels.line(line)}
            tabIndex={index === (selection ? selection[1] : 0) ? 0 : -1}
            onClick={(event) => onSelect(event.shiftKey && selection ? [selection[0], index] : [index, index])}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {numbered && <span className="results-patch__number" aria-hidden="true">{line.before ?? ''}</span>}
            {numbered && <span className="results-patch__number" aria-hidden="true">{line.after ?? ''}</span>}
            <code>{line.text || ' '}</code>
          </button>
        ))}
      </div>
      {lines.length > limit && (
        <Button variant="ghost" size="sm" onClick={() => setLimit((value) => value + PAGE)}>{labels.showMore}</Button>
      )}
    </>
  );
}

/** The selected lines of a patch, in order, for a comment or quote. */
export function selectedLines(change: RecordedFileChange, range: LineRange): ReviewLine[] {
  const [first, last] = orderedRange(range);
  return reviewLines(change).slice(first, last + 1);
}
