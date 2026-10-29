import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

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
export function PatchLineList({ change, label, selection, commented, onSelect, onComment, labels, annotations, focusIndex }: {
  readonly change: RecordedFileChange;
  readonly label: string;
  readonly selection?: LineRange;
  /** Line indices that already carry a comment. */
  readonly commented?: ReadonlySet<number>;
  readonly onSelect: (range: LineRange | undefined) => void;
  readonly onComment?: () => void;
  readonly labels: PatchLineLabels;
  /** A block under a line (by index): what an AI review found there. */
  readonly annotations?: ReadonlyMap<number, ReactNode>;
  /** The line a walkthrough is on: brought into view and marked; it takes the list's tab stop. */
  readonly focusIndex?: number;
}): JSX.Element {
  const lines = useMemo(() => reviewLines(change), [change]);
  const [limit, setLimit] = useState(PAGE);
  const listRef = useRef<HTMLDivElement>(null);
  const [start, end] = selection ? orderedRange(selection) : [-1, -2];
  const numbered = change.coverage === 'patch';
  const focusLine = (index: number): void => {
    listRef.current?.querySelector<HTMLButtonElement>(`[data-line-index="${String(index)}"]`)?.focus();
  };
  // A walkthrough step: page the line in, then scroll it into view without taking focus.
  useEffect(() => {
    if (focusIndex === undefined || focusIndex < 0) return undefined;
    if (focusIndex >= limit) { setLimit(Math.ceil((focusIndex + 1) / PAGE) * PAGE); return undefined; }
    const frame = requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-line-index="${String(focusIndex)}"]`)?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusIndex, limit]);
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
  const tabStop = selection ? selection[1] : focusIndex !== undefined && focusIndex >= 0 && focusIndex < limit ? focusIndex : 0;
  return (
    <>
      <div ref={listRef} className="results-patch" role="group" aria-label={label} data-numbered={numbered || undefined}>
        {lines.slice(0, limit).map((line: ReviewLine, index) => {
          const annotation = annotations?.get(index);
          return (
            <Fragment key={index}>
              <button
                type="button"
                className="results-patch__line"
                data-kind={line.kind}
                data-line-index={index}
                data-commented={commented?.has(index) || undefined}
                data-annotated={annotation ? true : undefined}
                data-focus={index === focusIndex || undefined}
                aria-pressed={index >= start && index <= end}
                aria-label={labels.line(line)}
                tabIndex={index === tabStop ? 0 : -1}
                onClick={(event) => onSelect(event.shiftKey && selection ? [selection[0], index] : [index, index])}
                onKeyDown={(event) => onKeyDown(event, index)}
              >
                {numbered && <span className="results-patch__number" aria-hidden="true">{line.before ?? ''}</span>}
                {numbered && <span className="results-patch__number" aria-hidden="true">{line.after ?? ''}</span>}
                <code>{line.text || ' '}</code>
              </button>
              {annotation && <div className="results-patch__annotation" data-focus={index === focusIndex || undefined}>{annotation}</div>}
            </Fragment>
          );
        })}
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
