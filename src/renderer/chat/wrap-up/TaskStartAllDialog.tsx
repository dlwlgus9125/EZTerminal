import { useEffect, useId, useState } from 'react';

import { suggestedTaskBranches, type SuggestedTaskState, type SuggestedTaskWhere } from '../../../shared/turn-wrap-up';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Glyph } from '../../ui/Glyph';
import { useChatCopy } from '../copy';
import { InlineCode } from './wrap-up-presentation';
import './wrap-up.css';

export interface TaskStart {
  readonly taskId: string;
  readonly where: SuggestedTaskWhere;
}

type Choices = Readonly<Record<string, boolean>>;

/** A worktree-recommended task starts in a new worktree unless the person changes it; the phone always starts here. */
function initialChoices(tasks: readonly SuggestedTaskState[], phone: boolean): Choices {
  return Object.fromEntries(tasks.map((task) => [task.id, !phone && task.worktree === true]));
}

/**
 * 모두 시작 (D6, 시안): what starts, how many and where, before anything runs. Each open task becomes a new
 * sub-conversation with the settings line; on the desktop each works in this folder or in a new worktree on its own
 * `suggest/…` branch. The phone cannot create worktrees, so everything starts in this folder there.
 */
export function TaskStartAllDialog({ open, onOpenChange, tasks, settings, phone, ownerDocument, onStart }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The open tasks of one card, in its order. */
  readonly tasks: readonly SuggestedTaskState[];
  /** What each new sub-conversation starts with, in words (`Claude · Opus 5.5 · 높음 · 승인 후 실행`). */
  readonly settings: string;
  readonly phone: boolean;
  readonly ownerDocument?: Document;
  readonly onStart: (starts: readonly TaskStart[]) => void;
}): JSX.Element {
  const copy = useChatCopy().taskSuggestions;
  const id = useId();
  const branches = suggestedTaskBranches(tasks.map((task) => task.title));
  const [worktree, setWorktree] = useState<Choices>(() => initialChoices(tasks, phone));
  // Fresh every time it opens: what the card offers now, not what was picked last time.
  useEffect(() => {
    if (open) setWorktree(initialChoices(tasks, phone));
    // The tasks are read when it opens, not as they change behind it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const choose = (taskId: string, value: boolean): void => setWorktree((current) => ({ ...current, [taskId]: value }));
  const start = (): void => {
    onStart(tasks.map((task, index): TaskStart => ({
      taskId: task.id,
      where: worktree[task.id] ? { kind: 'new-worktree', branch: branches[index]! } : { kind: 'this-folder' },
    })));
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={copy.confirm.title(tasks.length)}
      description={copy.confirm.description(settings)}
      size="sm"
      variant={phone ? 'sheet' : 'dialog'}
      closeLabel={copy.confirm.close}
      ownerDocument={ownerDocument}
      testId="task-start-all-dialog"
      footer={(
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{copy.confirm.cancel}</Button>
          <Button variant="primary" onClick={start} data-testid="task-start-all-submit">{copy.confirm.start(tasks.length)}</Button>
        </>
      )}
    >
      <ol className="task-start-all" data-phone={phone || undefined}>
        {tasks.map((task, index) => (
          <li key={task.id} className="task-start-all__task" data-testid="task-start-all-task">
            <p className="task-start-all__title"><span className="task-start-all__index" aria-hidden="true">{index + 1}</span><span><InlineCode text={task.title} /></span></p>
            {phone ? (
              <p className="task-start-all__here">{copy.confirm.thisFolder}</p>
            ) : (
              <fieldset className="task-start-all__choices">
                <legend className="chat-visually-hidden">{copy.named(copy.confirm.where, task.title)}</legend>
                <label className="task-start-all__choice" data-checked={!worktree[task.id] || undefined}>
                  <input type="radio" name={`${id}-${task.id}`} checked={!worktree[task.id]} onChange={() => choose(task.id, false)}
                    data-testid="task-start-all-here" />
                  <span>{copy.confirm.thisFolder}</span>
                </label>
                <label className="task-start-all__choice" data-checked={worktree[task.id] || undefined}>
                  <input type="radio" name={`${id}-${task.id}`} checked={worktree[task.id] === true} onChange={() => choose(task.id, true)}
                    data-testid="task-start-all-worktree" />
                  <span>{copy.confirm.newWorktree}</span>
                  <code className="task-start-all__branch">{branches[index]}</code>
                </label>
                {task.worktree && <span className="task-start-all__chip"><Glyph name="wt" />{copy.worktreeRecommended}</span>}
              </fieldset>
            )}
          </li>
        ))}
      </ol>
      {phone && <p className="task-start-all__note" data-testid="task-start-all-phone"><Glyph name="info" />{copy.confirm.phoneFolder}</p>}
      {tasks.length > 1 && <p className="task-start-all__note"><Glyph name="clock" />{copy.confirm.limit}</p>}
    </Dialog>
  );
}
