import { Fragment, useEffect, useId, useRef, useState, type RefObject } from 'react';

import type { SuggestedTaskOutcome, SuggestedTaskState, TurnTaskSuggestions } from '../../../shared/turn-wrap-up';
import { Button } from '../../ui/Button';
import { Glyph, type GlyphName } from '../../ui/Glyph';
import { useChatContext, type ChatWrapUpAction } from '../ChatContext';
import { formatClock, useChatCopy, type ChatCopy } from '../copy';
import type { ChatRow } from '../model/types';
import { focusAfterAction, providerName, useClearing } from '../review/review-presentation';
import { TaskStartAllDialog } from '../wrap-up/TaskStartAllDialog';
import { useWrapUpDecisions } from '../wrap-up/wrap-up-decisions';
import { InlineCode, outcomeText, taskCountText } from '../wrap-up/wrap-up-presentation';
import { ActionCard, type ActionCardAction } from './ActionCard';

type RowOf<K extends ChatRow['kind']> = Extract<ChatRow, { kind: K }>;
type TaskActionKind = Extract<ChatWrapUpAction, { readonly taskId: string }>['kind'];

const OUTCOME_GLYPH: Readonly<Record<Exclude<SuggestedTaskOutcome['kind'], 'open'>, GlyphName>> = {
  starting: 'spin',
  started: 'check',
  sending: 'spin',
  sent: 'send',
  queued: 'clock',
  dismissed: 'eyeOff',
  'start-failed': 'warn',
};

/** Says once, politely, what came of a task whose outcome changed (`Fix the… · 시작함`); a card that just appeared says nothing. */
function useOutcomeAnnouncement(tasks: readonly SuggestedTaskState[], copy: ChatCopy): string {
  const previous = useRef<ReadonlyMap<string, SuggestedTaskOutcome['kind']> | undefined>(undefined);
  const [announcement, setAnnouncement] = useState('');
  const signature = tasks.map((task) => `${task.id}:${task.outcome.kind}`).join('|');
  useEffect(() => {
    const before = previous.current;
    previous.current = new Map(tasks.map((task) => [task.id, task.outcome.kind]));
    if (!before) return;
    const changed = tasks.filter((task) => before.has(task.id) && before.get(task.id) !== task.outcome.kind);
    if (!changed.length) return;
    setAnnouncement(changed.map((task) => copy.taskSuggestions.announce(task.title, outcomeText(task.outcome, copy) || copy.taskSuggestions.reopen)).join(', '));
    // The signature is the tasks' outcomes; the array itself is new on every update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return useClearing(announcement, setAnnouncement);
}

interface TaskProps {
  readonly suggestions: TurnTaskSuggestions;
  readonly task: SuggestedTaskState;
  readonly index: number;
  readonly cli: boolean;
}

/**
 * What can be done with a task now, or what came of it. The pressed button goes with the new outcome, so focus moves to
 * the task's title, which stays.
 */
function TaskActions({ suggestions, task, cli, titleRef }: Omit<TaskProps, 'index'> & { readonly titleRef: RefObject<HTMLElement> }): JSX.Element | null {
  const copy = useChatCopy();
  const context = useChatContext();
  const decisions = useWrapUpDecisions();
  const onAction = context.onWrapUpAction;
  const phone = context.taskStart?.phone === true;
  // D5: the phone has no start form, so it always starts with the defaults.
  const viaForm = decisions.taskStart === 'dialog' && !phone;
  const act = (kind: TaskActionKind) => (): void => {
    onAction?.({ kind, turnId: suggestions.turnId, taskId: task.id });
    focusAfterAction(titleRef);
  };
  type Choice = { readonly kind: TaskActionKind | 'open-child'; readonly label: string; readonly emphasis: 'main' | 'quiet' | 'link'; readonly run: () => void };
  const outcome = task.outcome;
  const startedSession = outcome.kind === 'started' ? outcome.sessionId : undefined;
  const choices: Choice[] = !onAction ? [] : outcome.kind === 'open' ? [
    { kind: viaForm ? 'task-start-custom' : 'task-start', label: viaForm ? copy.taskSuggestions.startDialog : copy.taskSuggestions.start, emphasis: 'main', run: act(viaForm ? 'task-start-custom' : 'task-start') },
    { kind: 'task-here', label: copy.taskSuggestions.here, emphasis: 'quiet', run: act('task-here') },
    { kind: 'task-dismiss', label: copy.taskSuggestions.dismiss, emphasis: 'quiet', run: act('task-dismiss') },
    ...(!viaForm && !phone ? [{ kind: 'task-start-custom' as const, label: copy.taskSuggestions.changeAndStart, emphasis: 'link' as const, run: act('task-start-custom') }] : []),
  ] : outcome.kind === 'start-failed' ? [
    { kind: 'task-start', label: copy.taskSuggestions.retry, emphasis: 'main', run: act('task-start') },
    { kind: 'task-dismiss', label: copy.taskSuggestions.dismiss, emphasis: 'quiet', run: act('task-dismiss') },
  ] : outcome.kind === 'dismissed' ? [
    { kind: 'task-reopen', label: copy.taskSuggestions.reopen, emphasis: 'link', run: act('task-reopen') },
  ] : startedSession && context.onOpenRelated ? [
    { kind: 'open-child', label: copy.taskSuggestions.openChild, emphasis: 'link', run: () => context.onOpenRelated?.(startedSession) },
  ] : [];
  const said = outcomeText(outcome, copy);
  const status = said && (
    <span className="chat-task__outcome" data-outcome={outcome.kind} data-testid="chat-task-outcome">
      {outcome.kind !== 'open' && <Glyph name={OUTCOME_GLYPH[outcome.kind]} className={outcome.kind === 'starting' || outcome.kind === 'sending' ? 'chat-spin' : undefined} />}
      <strong>{said}</strong>
      {outcome.kind === 'start-failed' && <span className="chat-task__reason">{outcome.reason}</span>}
    </span>
  );
  if (!status && !choices.length) return null;
  if (cli) {
    return (
      <span className="chat-cli-result__line chat-cli-task__actions">
        {status && <span className="chat-cli-task__outcome" data-outcome={outcome.kind}>[{said}]{outcome.kind === 'start-failed' ? ` ${outcome.reason}` : ''}</span>}
        {choices.map((choice, index) => (
          <Fragment key={`${choice.kind}:${choice.label}`}>
            {(index > 0 || status) && <span className="chat-cli-dim" aria-hidden="true"> · </span>}
            <button type="button" className="chat-cli-action" data-primary={choice.emphasis === 'main' || undefined}
              aria-label={copy.taskSuggestions.named(choice.label, task.title)} onClick={choice.run} data-action={choice.kind}>
              {choice.label}
            </button>
          </Fragment>
        ))}
      </span>
    );
  }
  return (
    <div className="chat-task__actions">
      {status}
      {choices.map((choice) => (choice.emphasis === 'link'
        ? (
          <button key={`${choice.kind}:${choice.label}`} type="button" className="chat-link-button chat-task__link" aria-label={copy.taskSuggestions.named(choice.label, task.title)}
            onClick={choice.run} data-action={choice.kind}>
            {choice.label}
          </button>
        )
        : (
          <Button key={`${choice.kind}:${choice.label}`} size="sm" variant={choice.emphasis === 'main' ? 'secondary' : 'ghost'}
            aria-label={copy.taskSuggestions.named(choice.label, task.title)} onClick={choice.run} data-action={choice.kind}>
            {choice.label}
          </Button>
        )))}
    </div>
  );
}

/** The instruction exactly as either button sends it, on request. */
function usePromptToggle(suggestions: TurnTaskSuggestions, task: SuggestedTaskState): { readonly open: boolean; toggle(): void } {
  const context = useChatContext();
  const key = `task-prompt:${suggestions.turnId}:${task.id}`;
  const open = context.isExpanded(key, false);
  return { open, toggle: () => context.setExpanded(key, !open) };
}

function BubbleTask({ suggestions, task, index }: Omit<TaskProps, 'cli'>): JSX.Element {
  const copy = useChatCopy();
  const context = useChatContext();
  const titleRef = useRef<HTMLParagraphElement>(null);
  const promptId = useId();
  const prompt = usePromptToggle(suggestions, task);
  const phone = context.taskStart?.phone === true;
  return (
    <li className="chat-task" data-outcome={task.outcome.kind} data-task-id={task.id} data-testid="chat-task">
      <div className="chat-task__head">
        <span className="chat-task__index" aria-hidden="true">{index + 1}</span>
        <p ref={titleRef} className="chat-task__title" tabIndex={-1} data-task-title=""><InlineCode text={task.title} /></p>
        {task.worktree && <span className="chat-task__chip" data-testid="chat-task-worktree"><Glyph name="wt" />{copy.taskSuggestions.worktreeRecommended}</span>}
      </div>
      <p className="chat-task__rationale"><InlineCode text={task.rationale} /></p>
      {task.worktree && phone && <p className="chat-task__note" data-testid="chat-task-worktree-desktop"><Glyph name="info" />{copy.taskSuggestions.worktreeDesktop}</p>}
      <button type="button" className="chat-link-button chat-task__toggle" aria-expanded={prompt.open} aria-controls={prompt.open ? promptId : undefined}
        onClick={prompt.toggle} data-testid="chat-task-prompt-toggle">
        <Glyph name="next" className="chat-chevron" />{prompt.open ? copy.taskSuggestions.hidePrompt : copy.taskSuggestions.showPrompt}
      </button>
      {prompt.open && (
        <div id={promptId} className="chat-task__prompt" data-testid="chat-task-prompt">
          <p className="chat-task__prompt-note">{copy.taskSuggestions.promptNote}</p>
          <pre className="chat-task__prompt-text">{task.prompt}</pre>
        </div>
      )}
      <TaskActions suggestions={suggestions} task={task} cli={false} titleRef={titleRef} />
    </li>
  );
}

function CliTask({ suggestions, task, index }: Omit<TaskProps, 'cli'>): JSX.Element {
  const copy = useChatCopy();
  const context = useChatContext();
  const titleRef = useRef<HTMLSpanElement>(null);
  const promptId = useId();
  const prompt = usePromptToggle(suggestions, task);
  const phone = context.taskStart?.phone === true;
  return (
    <li className="chat-cli-result chat-cli-task" data-outcome={task.outcome.kind} data-task-id={task.id} data-testid="chat-task">
      <span className="chat-cli-result__elbow" aria-hidden="true">⎿</span>
      <div className="chat-cli-result__body">
        <span className="chat-cli-result__line">
          <span className="chat-cli-task__index" aria-hidden="true">{index + 1}. </span>
          <span ref={titleRef} className="chat-cli-task__title" tabIndex={-1} data-task-title=""><InlineCode text={task.title} /></span>
          {task.worktree && <span className="chat-cli-dim" data-testid="chat-task-worktree"> [{copy.taskSuggestions.worktreeRecommended}]</span>}
        </span>
        <span className="chat-cli-result__line chat-cli-task__rationale"><InlineCode text={task.rationale} /></span>
        {task.worktree && phone && <span className="chat-cli-result__line chat-cli-dim" data-testid="chat-task-worktree-desktop">{copy.taskSuggestions.worktreeDesktop}</span>}
        <span className="chat-cli-result__line">
          <button type="button" className="chat-cli-action" aria-expanded={prompt.open} aria-controls={prompt.open ? promptId : undefined}
            onClick={prompt.toggle} data-testid="chat-task-prompt-toggle">
            {prompt.open ? copy.taskSuggestions.hidePrompt : copy.taskSuggestions.showPrompt}
          </button>
        </span>
        {prompt.open && (
          <div id={promptId} className="chat-cli-task__prompt" data-testid="chat-task-prompt">
            <span className="chat-cli-result__line chat-cli-dim">{copy.taskSuggestions.promptNote}</span>
            <pre className="chat-task__prompt-text">{task.prompt}</pre>
          </div>
        )}
        <TaskActions suggestions={suggestions} task={task} cli titleRef={titleRef} />
      </div>
    </li>
  );
}

/**
 * The tasks one turn suggested (시안): one card after its last message, the AI's `suggest_task` calls folded in. The AI
 * only proposes; a sub-conversation starts, or the instruction is sent here, only when the person presses a button,
 * and each task says what came of it as the host confirms it.
 */
export function TaskSuggestionsCard({ row }: { readonly row: RowOf<'task-suggestions'> }): JSX.Element {
  const copy = useChatCopy();
  const context = useChatContext();
  const decisions = useWrapUpDecisions();
  const { suggestions } = row;
  const provider = providerName(suggestions.providerId);
  const cli = context.skin === 'cli';
  const phone = context.taskStart?.phone === true;
  const announcement = useOutcomeAnnouncement(suggestions.tasks, copy);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const openTasks = suggestions.tasks.filter((task) => task.outcome.kind === 'open');
  const settings = context.taskStart?.settings;
  // D5: the line says exactly what one click starts; with the form (b) the form says it instead.
  const defaults = settings && (decisions.taskStart === 'one-click' || phone)
    ? copy.taskSuggestions.defaults(`${settings} · ${copy.taskSuggestions.thisFolder}`) : undefined;
  const onAction = context.onWrapUpAction;
  const actions: ActionCardAction[] = onAction && settings && openTasks.length > 1
    ? [{ id: 'start-all', label: copy.taskSuggestions.startAll(openTasks.length), onSelect: () => setConfirmOpen(true), testId: 'chat-task-start-all' }] : [];
  const count = taskCountText(suggestions.tasks, copy);
  const clock = formatClock(suggestions.createdAt, context.locale);
  return (
    <ActionCard
      kind="task-suggestions"
      testId="chat-task-card"
      glyph="spark"
      label={`${copy.taskSuggestions.card} · ${provider} · ${count}`}
      title={copy.taskSuggestions.card}
      cliName={copy.taskSuggestions.cliName}
      cliTarget={provider}
      state="done"
      stateText={count}
      meta={(
        <>
          <span className="chat-wrap-up-meta__who">{copy.taskSuggestions.foundBy(provider)}</span>
          <span className="chat-wrap-up-meta__time"><time dateTime={suggestions.createdAt}>{clock}</time></span>
        </>
      )}
      cliMeta={`${copy.taskSuggestions.foundOutside} · ${clock}`}
      {...(suggestions.dropped ? { notes: [{ id: 'dropped', text: copy.taskSuggestions.dropped(suggestions.dropped) }] } : {})}
      actions={actions}
    >
      {defaults && (cli ? (
        <div className="chat-cli-result" data-tone="muted">
          <span className="chat-cli-result__elbow" aria-hidden="true">⎿</span>
          <div className="chat-cli-result__body"><span className="chat-cli-result__line" data-testid="chat-task-defaults">{defaults}</span></div>
        </div>
      ) : <p className="chat-task-defaults" data-testid="chat-task-defaults"><Glyph name="kids" />{defaults}</p>)}
      <ol className={cli ? 'chat-cli-tasks' : 'chat-tasks'}>
        {suggestions.tasks.map((task, index) => (cli
          ? <CliTask key={task.id} suggestions={suggestions} task={task} index={index} />
          : <BubbleTask key={task.id} suggestions={suggestions} task={task} index={index} />))}
      </ol>
      <span ref={anchorRef} className="chat-visually-hidden" role="status" aria-live="polite" data-testid="chat-task-announce">{announcement}</span>
      {onAction && settings && (
        <TaskStartAllDialog open={confirmOpen} onOpenChange={setConfirmOpen} tasks={openTasks} settings={settings} phone={phone}
          ownerDocument={anchorRef.current?.ownerDocument}
          onStart={(starts) => onAction({ kind: 'task-start-all', turnId: suggestions.turnId, starts })} />
      )}
    </ActionCard>
  );
}
