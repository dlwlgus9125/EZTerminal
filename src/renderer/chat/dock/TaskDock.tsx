import { Glyph } from '../../ui/Glyph';

import type { TodoItem } from '../../../shared/transcript-payload';
import { useChatCopy } from '../copy';
import { useChatContext } from '../ChatContext';
import { TodoList } from '../rows/BubbleRows';

/** The agent's current task list, docked above the composer while work is unfinished. */
export function TaskDock({ items }: { readonly items: readonly TodoItem[] }): JSX.Element | null {
  const copy = useChatCopy();
  const context = useChatContext();
  const open = context.isExpanded('task-dock', false);
  if (!items.length) return null;
  const done = items.filter((item) => item.status === 'completed').length;
  const current = items.find((item) => item.status === 'in_progress');
  if (context.onOpenResults) {
    // Desktop: the full list lives in the Results tab; here stays the one line of progress.
    const openResults = context.onOpenResults;
    return (
      <section className="chat-task-dock" aria-label={copy.tasks}>
        <button type="button" className="chat-task-dock__header" onClick={() => openResults('summary')} data-testid="chat-task-dock-open-results">
          <Glyph name="list" />
          <span className="chat-task-dock__progress">{copy.tasksProgress(done, items.length)}</span>
          {current && <span className="chat-task-dock__current">{current.active ?? current.text}</span>}
          <Glyph name="next" />
        </button>
      </section>
    );
  }
  return (
    <section className="chat-task-dock" aria-label={copy.tasks}>
      <button type="button" className="chat-task-dock__header" aria-expanded={open} onClick={() => context.setExpanded('task-dock', !open)}>
        <Glyph name="list" />
        <span className="chat-task-dock__progress">{copy.tasksProgress(done, items.length)}</span>
        {current && <span className="chat-task-dock__current">{current.active ?? current.text}</span>}
        {open ? <Glyph name="down" /> : <Glyph name="up" />}
      </button>
      {open && <TodoList items={items} />}
    </section>
  );
}
