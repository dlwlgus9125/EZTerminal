import { useEffect, useRef, useSyncExternalStore } from 'react';

import type { JsonValue } from '../shared/ipc';
import type { BlockController } from './block-controller';
import { PlainOutputDomRetention } from './pty-output-retention';
import { getActiveScrollback } from './scrollback';

const TEXT_ROW_PAGE = 10_000;

// Text output — a single scalar value, OR external-program text (T7). The rows
// flow through the credit/window protocol either way: a scalar is one row; an
// external program is one row per decoded output chunk. External rows carry
// HTML that ansi_up already sanitized (escape_html ON: `<`/`>`/`&` escaped, only
// ansi_up's own inline-styled color spans emitted — see external/ansi.ts),
// flagged by the `html` column type, and concatenated verbatim.

function formatValue(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function TextBlock({ controller }: { controller: BlockController }): JSX.Element {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { rowCount, columns, version } = snapshot;
  const isHtml = columns[0]?.type === 'html';

  // Text output is append-only. We accumulate it here instead of re-reading every
  // row on each frame: requesting [0, rowCount) on every chunk was O(K^2) over IPC
  // (and pinned every row in the controller cache). Track how many rows we've
  // consumed and request / append only the delta (CODE-M1).
  const consumed = useRef(0);
  // Keep at most one sequential page in flight. Advancing the controller's
  // requested window before every chunk of the current page has arrived would
  // let its stale-window pruning discard a still-needed prefix.
  const requestedThrough = useRef(0);
  const outputRef = useRef<HTMLPreElement>(null);
  const retention = useRef(new PlainOutputDomRetention());

  useEffect(() => {
    consumed.current = 0;
    requestedThrough.current = 0;
    retention.current.reset();
    if (outputRef.current) outputRef.current.textContent = '';
  }, [controller]);

  // Append any newly-arrived rows (contiguous, in order) to the accumulated text.
  // Runs after each frame (version bump); stops at the first not-yet-fetched gap.
  // Once a complete page is consumed, request the next one even if rowCount is
  // already final and will never change again.
  useEffect(() => {
    let added = '';
    let i = consumed.current;
    for (; i < rowCount; i++) {
      const row = controller.getRow(i);
      if (!row) break; // chunk not here yet — wait for the next frame
      added += isHtml ? formatValue(row.value) : (i > 0 ? '\n' : '') + formatValue(row.value);
    }
    if (i > consumed.current) {
      consumed.current = i;
      const output = outputRef.current;
      if (output) {
        if (isHtml) {
          retention.current.append(output, added, getActiveScrollback());
        } else {
          retention.current.appendText(output, added, getActiveScrollback());
        }
      }
    }
    if (
      consumed.current >= requestedThrough.current
      && consumed.current < rowCount
    ) {
      const count = Math.min(TEXT_ROW_PAGE, rowCount - consumed.current);
      requestedThrough.current = consumed.current + count;
      controller.requestRows(consumed.current, count);
    }
  }, [controller, rowCount, version, isHtml]);

  useEffect(() => {
    const applyLimit = (): void => {
      const output = outputRef.current;
      if (output) retention.current.limit(output, getActiveScrollback());
    };
    window.addEventListener('ez:scrollback', applyLimit);
    return () => window.removeEventListener('ez:scrollback', applyLimit);
  }, []);

  return (
    // Imperative retention preserves sanitized ANSI spans while applying the
    // configured line scrollback and pathological-single-line character ceiling.
    <pre ref={outputRef} className="text-block" data-testid="text-output" />
  );
}
