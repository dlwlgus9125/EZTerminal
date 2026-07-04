import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { JsonValue } from '../shared/ipc';
import type { BlockController } from './block-controller';

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
  const [text, setText] = useState('');
  const consumed = useRef(0);

  // Ask the interpreter only for the new rows as the total grows.
  useEffect(() => {
    if (rowCount > consumed.current) {
      controller.requestRows(consumed.current, rowCount - consumed.current);
    }
  }, [controller, rowCount]);

  // Append any newly-arrived rows (contiguous, in order) to the accumulated text.
  // Runs after each frame (version bump); stops at the first not-yet-fetched gap.
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
      setText((prev) => prev + added);
    }
  }, [controller, rowCount, version, isHtml]);

  // External output: HTML pre-sanitized by ansi_up in the interpreter; scalars are
  // plain text. Either way `text` is the accumulated, already-formatted output.
  if (isHtml) {
    // Content is sanitized upstream by ansi_up (escape_html) — safe to inject.
    return (
      <pre
        className="text-block"
        data-testid="text-output"
        dangerouslySetInnerHTML={{ __html: text }}
      />
    );
  }

  return (
    <pre className="text-block" data-testid="text-output">
      {text}
    </pre>
  );
}
