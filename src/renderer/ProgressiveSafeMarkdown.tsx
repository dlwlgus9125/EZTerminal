import { memo, useEffect, useState } from 'react';

import { SafeMarkdown, type SafeMarkdownProps } from './SafeMarkdown';

const DEFER_THRESHOLD = 4_096;

interface RenderTask {
  readonly id: number;
  readonly priority: number;
  readonly run: () => void;
  cancelled: boolean;
}

let nextTaskId = 0;
let scheduled = false;
const queue: RenderTask[] = [];

function scheduleNext(): void {
  if (scheduled || queue.length === 0) return;
  scheduled = true;
  const flush = (): void => {
    scheduled = false;
    queue.sort((left, right) => right.priority - left.priority || left.id - right.id);
    let task = queue.shift();
    while (task?.cancelled) task = queue.shift();
    task?.run();
    scheduleNext();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 0);
}

function enqueue(run: () => void, priority: number): () => void {
  nextTaskId += 1;
  const task: RenderTask = { id: nextTaskId, priority, run, cancelled: false };
  queue.push(task);
  scheduleNext();
  return () => { task.cancelled = true; };
}

/** Parses at most one large transcript message per frame, newest first. */
export const ProgressiveSafeMarkdown = memo(function ProgressiveSafeMarkdown({
  priority,
  ...props
}: SafeMarkdownProps & { readonly priority: number }): JSX.Element {
  const deferred = props.markdown.length >= DEFER_THRESHOLD;
  const [readyMarkdown, setReadyMarkdown] = useState<string | null>(
    deferred ? null : props.markdown,
  );

  useEffect(() => {
    if (!deferred) return undefined;
    const markdown = props.markdown;
    return enqueue(() => setReadyMarkdown(markdown), priority);
  }, [deferred, priority, props.markdown]);

  // Compare the committed payload rather than toggling a boolean in an effect.
  // A streamed large message can change between renders; rendering it once
  // before an effect resets `ready` would put the expensive parse back on the
  // input/event commit that this component is meant to protect.
  if (deferred && readyMarkdown !== props.markdown) {
    return (
      <div
        className={props.className}
        data-testid={props.testId}
        data-markdown-pending="true"
        aria-hidden="true"
        style={{ minHeight: '2.5rem', contentVisibility: 'auto', containIntrinsicSize: '2.5rem' }}
      />
    );
  }
  return <SafeMarkdown {...props} />;
});
