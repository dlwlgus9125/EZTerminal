import { ChevronDown, ChevronUp, ListChecks } from 'lucide-react';

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
  return (
    <section className="chat-task-dock" aria-label={copy.tasks}>
      <button type="button" className="chat-task-dock__header" aria-expanded={open} onClick={() => context.setExpanded('task-dock', !open)}>
        <ListChecks aria-hidden="true" />
        <span className="chat-task-dock__progress">{copy.tasksProgress(done, items.length)}</span>
        {current && <span className="chat-task-dock__current">{current.active ?? current.text}</span>}
        {open ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
      </button>
      {open && <TodoList items={items} />}
    </section>
  );
}
