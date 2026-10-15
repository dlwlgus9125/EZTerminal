import { AlertTriangle, Check, ChevronRight, CircleSlash, FileDiff, ListChecks, LoaderCircle, MessageCircleQuestion, NotebookPen, Paperclip, X } from 'lucide-react';

import { useChatCopy } from '../copy';
import { useChatContext, useNow } from '../ChatContext';
import { formatDuration, summarizeActivity, toolDisplayTarget, toolVerb } from '../model/summary';
import type { ChatActivity, ChatRow, ChatTool } from '../model/types';
import { DiffView } from '../parts/DiffView';
import { Prose } from '../parts/Prose';
import { ToolDetail, hasToolDetail } from '../parts/ToolDetail';
import { ToolIcon } from '../parts/ToolIcon';
import { MessageActions, toolMeta, turnStatusText, useFold } from './shared';

type RowOf<K extends ChatRow['kind']> = Extract<ChatRow, { kind: K }>;

export function BubbleUser({ row }: { readonly row: RowOf<'user'> }): JSX.Element {
  const copy = useChatCopy();
  const fold = useFold(row.id, row.text);
  return (
    <article className="chat-user" aria-label={copy.you} data-message-id={row.anchorId}>
      <div className="chat-user__bubble" data-folded={fold.folded || undefined}>
        {row.context?.replyTo && <blockquote className="chat-user__reply">{row.context.replyTo.text}</blockquote>}
        {row.context?.attachments && row.context.attachments.length > 0 && (
          <ul className="chat-user__attachments">
            {row.context.attachments.map((attachment) => (
              <li key={attachment.id}>
                {attachment.kind === 'image'
                  ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} />
                  : <Paperclip aria-hidden="true" />}
                <span>{attachment.name}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="chat-user__text">{row.text}</p>
      </div>
      {fold.foldable && (
        <button type="button" className="chat-link-button chat-user__fold" onClick={fold.toggle} aria-expanded={!fold.folded}>
          {fold.folded ? copy.showMore : copy.showLess}
        </button>
      )}
      <MessageActions text={row.text} messageId={row.messageId} allowReuse createdAt={row.createdAt} />
    </article>
  );
}

export function BubbleAssistant({ row, providerLabel }: { readonly row: RowOf<'assistant'>; readonly providerLabel: string }): JSX.Element {
  return (
    <article className="chat-assistant" aria-label={providerLabel} data-message-id={row.anchorId} data-streaming={row.streaming || undefined}>
      <Prose markdown={row.text} streaming={row.streaming} variant="prose" />
      {!row.streaming && <MessageActions text={row.text} messageId={row.messageId} createdAt={row.createdAt} />}
    </article>
  );
}

function StatusGlyph({ tool }: { readonly tool: ChatTool }): JSX.Element | null {
  switch (tool.status) {
    case 'running':
      return <LoaderCircle className="chat-spin" aria-hidden="true" />;
    case 'failed':
      return <AlertTriangle className="chat-status-icon" data-tone="danger" aria-hidden="true" />;
    case 'denied':
      return <CircleSlash className="chat-status-icon" data-tone="danger" aria-hidden="true" />;
    case 'interrupted':
      return <X className="chat-status-icon" data-tone="muted" aria-hidden="true" />;
    default:
      return null;
  }
}

function ToolLine({ tool }: { readonly tool: ChatTool }): JSX.Element {
  const context = useChatContext();
  const copy = useChatCopy();
  const key = `tool:${tool.callId}`;
  const open = context.isExpanded(key, false);
  const detail = hasToolDetail(tool);
  const meta = toolMeta(tool, context.locale, copy);
  const target = toolDisplayTarget(tool, context.workspaceRoot);
  const mono = tool.category !== 'web' && tool.category !== 'agent' && tool.category !== 'todo';
  return (
    <li className="chat-tool" data-status={tool.status} data-category={tool.category}>
      <button
        type="button"
        className="chat-tool__line"
        aria-expanded={detail ? open : undefined}
        disabled={!detail}
        onClick={() => context.setExpanded(key, !open)}
      >
        <ToolIcon category={tool.category} />
        <span className="chat-tool__verb">{toolVerb(tool, context.locale)}</span>
        {target && <span className="chat-tool__target" data-mono={mono || undefined} title={target}>{target}</span>}
        <span className="chat-tool__meta">
          {meta.map((value) => <span key={value} data-tone={value.startsWith('exit') || value.startsWith('종료') ? 'danger' : undefined}>{value}</span>)}
          <StatusGlyph tool={tool} />
          {detail && <ChevronRight className="chat-chevron" aria-hidden="true" />}
        </span>
      </button>
      {open && detail && <ToolDetail tool={tool} />}
    </li>
  );
}

function ThoughtLine({ entry }: { readonly entry: Extract<ChatActivity, { kind: 'thought' }> }): JSX.Element {
  const context = useChatContext();
  const copy = useChatCopy();
  const key = `thought:${entry.id}`;
  const open = context.isExpanded(key, false);
  const hasText = entry.text.trim().length > 0;
  const label = entry.streaming
    ? copy.thinking
    : entry.durationMs !== undefined ? copy.thoughtFor(formatDuration(entry.durationMs, context.locale)) : copy.thinking;
  return (
    <li className="chat-tool" data-category="thought">
      <button type="button" className="chat-tool__line" aria-expanded={hasText ? open : undefined} disabled={!hasText} onClick={() => context.setExpanded(key, !open)}>
        <ToolIcon category="thought" />
        <span className="chat-tool__verb">{label}</span>
        <span className="chat-tool__meta">
          {entry.streaming && <LoaderCircle className="chat-spin" aria-hidden="true" />}
          {hasText && <ChevronRight className="chat-chevron" aria-hidden="true" />}
        </span>
      </button>
      {open && hasText && <p className="chat-thought__text">{entry.text}</p>}
    </li>
  );
}

/** A run of tool calls and reasoning with a one-sentence summary header. */
export function BubbleActivity({ row }: { readonly row: RowOf<'activity'> }): JSX.Element {
  const context = useChatContext();
  const copy = useChatCopy();
  const summary = summarizeActivity(row.entries, row.live, context.locale);
  const key = `run:${row.id}`;
  // Live runs stay open so progress is visible; settled runs fold to their summary.
  const open = context.isExpanded(key, row.live);
  const single = summary.singleCommand;
  const toolCount = row.entries.filter((entry) => entry.kind === 'tool').length;
  const problems = [
    summary.failed ? copy.failedCount(summary.failed) : '',
    summary.denied ? copy.deniedCount(summary.denied) : '',
    summary.interrupted ? copy.interruptedCount(summary.interrupted) : '',
  ].filter(Boolean);
  return (
    <section className="chat-run" data-live={row.live || undefined} aria-label={summary.text}>
      <button type="button" className="chat-run__header" aria-expanded={open} onClick={() => context.setExpanded(key, !open)}>
        <ChevronRight className="chat-chevron" aria-hidden="true" />
        <span className="chat-run__summary" data-mono={single ? true : undefined}>{single ? `$ ${single}` : summary.text}</span>
        {problems.length > 0 && <span className="chat-run__problems">{problems.join(' · ')}</span>}
        {row.live
          ? <LoaderCircle className="chat-spin" aria-hidden="true" />
          : toolCount > 0 && problems.length === 0 && <Check className="chat-status-icon" data-tone="success" aria-hidden="true" />}
      </button>
      {open && (
        <ol className="chat-run__lines">
          {row.entries.map((entry) => (entry.kind === 'tool'
            ? <ToolLine key={entry.tool.callId} tool={entry.tool} />
            : <ThoughtLine key={entry.id} entry={entry} />))}
        </ol>
      )}
    </section>
  );
}

export function BubbleTurnStatus({ row }: { readonly row: RowOf<'turn-status'> }): JSX.Element | null {
  const context = useChatContext();
  const copy = useChatCopy();
  const live = row.state === 'working' || row.state === 'submitting' || row.state === 'blocked' || row.state === 'queued' || row.state === 'delivery-uncertain';
  const now = useNow(live && row.state !== 'queued');
  const text = turnStatusText(row, now, copy, context.locale);
  if (!text) return null;
  return (
    <p className="chat-turn-status" data-state={row.state} role={live ? 'status' : undefined}>
      {live && row.state !== 'queued' && row.state !== 'blocked' && <LoaderCircle className="chat-spin" aria-hidden="true" />}
      {text}
    </p>
  );
}

export function BubblePlan({ row }: { readonly row: RowOf<'plan'> }): JSX.Element {
  const copy = useChatCopy();
  return (
    <section className="chat-card chat-plan" aria-label={copy.plan}>
      <header className="chat-card__header"><NotebookPen aria-hidden="true" /><span>{copy.plan}</span>
        {row.filePath && <span className="chat-card__meta" title={row.filePath}>{row.filePath.replace(/^.*[\\/]/u, '')}</span>}
      </header>
      <Prose markdown={row.markdown} variant="prose" />
    </section>
  );
}

export function BubbleQuestion({ row }: { readonly row: RowOf<'question'> }): JSX.Element {
  const copy = useChatCopy();
  return (
    <section className="chat-card chat-question" aria-label={copy.asked}>
      {row.questions.map((question, index) => (
        <div key={index} className="chat-question__item">
          <header className="chat-card__header"><MessageCircleQuestion aria-hidden="true" /><span>{question.header ?? copy.asked}</span></header>
          <p className="chat-question__text">{question.question}</p>
          {question.options.length > 0 && <ul className="chat-question__options">{question.options.map((option) => <li key={option}>{option}</li>)}</ul>}
        </div>
      ))}
      <p className="chat-question__answer" data-pending={row.answer ? undefined : true}>
        {row.answer ? `${copy.answered}: ${row.answer.replace(/^Your questions have been answered:\s*/u, '').replace(/\.\s*You can now continue.*$/su, '')}` : copy.awaitingAnswer}
      </p>
    </section>
  );
}

export function TodoList({ items }: { readonly items: RowOf<'todo'>['items'] }): JSX.Element {
  return (
    <ul className="chat-todo__list">
      {items.map((item, index) => (
        <li key={`${index}:${item.text}`} data-status={item.status}>
          <span className="chat-todo__box" aria-hidden="true">{item.status === 'completed' ? <Check /> : item.status === 'in_progress' ? <LoaderCircle className="chat-spin" /> : null}</span>
          <span className="chat-todo__text">{item.status === 'in_progress' && item.active ? item.active : item.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function BubbleTodo({ row }: { readonly row: RowOf<'todo'> }): JSX.Element {
  const context = useChatContext();
  const copy = useChatCopy();
  const key = `todo:${row.id}`;
  const open = context.isExpanded(key, false);
  const done = row.items.filter((item) => item.status === 'completed').length;
  const changes = [
    ...row.change.completed.map((text) => `${copy.completed} ${text}`),
    ...row.change.started.map((text) => `${copy.started} ${text}`),
    ...(row.change.added.length && !row.change.started.length && !row.change.completed.length ? [`${copy.added} ${row.change.added.length}`] : []),
  ];
  return (
    <section className="chat-todo-update">
      <button type="button" className="chat-tool__line" aria-expanded={open} onClick={() => context.setExpanded(key, !open)}>
        <ListChecks className="chat-tool-icon" aria-hidden="true" />
        <span className="chat-tool__verb">{changes.length ? changes.join(' · ') : copy.tasks}</span>
        <span className="chat-tool__meta"><span>{copy.tasksProgress(done, row.items.length)}</span><ChevronRight className="chat-chevron" aria-hidden="true" /></span>
      </button>
      {open && <TodoList items={row.items} />}
    </section>
  );
}

export function BubbleChanges({ row }: { readonly row: RowOf<'changes'> }): JSX.Element {
  const context = useChatContext();
  const copy = useChatCopy();
  const key = `changes:${row.id}`;
  const open = context.isExpanded(key, false);
  return (
    <section className="chat-card chat-changes" aria-label={copy.changedFiles(row.files.length)}>
      <header className="chat-changes__header">
        <button type="button" className="chat-changes__toggle" aria-expanded={open} onClick={() => context.setExpanded(key, !open)}>
          <ChevronRight className="chat-chevron" aria-hidden="true" />
          <FileDiff aria-hidden="true" />
          <span>{copy.changedFiles(row.files.length)}</span>
        </button>
        {context.onReviewChanges && <button type="button" className="chat-link-button" onClick={context.onReviewChanges}>{copy.review}</button>}
      </header>
      <ul className="chat-changes__files">
        {row.files.map((file) => (
          <li key={file.path}>
            <span className="chat-changes__path" title={file.path}>{file.path.replace(/<WORKSPACE>[\\/]+/gu, '')}</span>
            <span className="chat-diff__counts">
              {(file.added ?? 0) > 0 && <span className="chat-diff__added">+{file.added}</span>}
              {(file.removed ?? 0) > 0 && <span className="chat-diff__removed">−{file.removed}</span>}
            </span>
          </li>
        ))}
      </ul>
      {open && row.changes.map((change, index) => <DiffView key={`${change.path}:${index}`} change={change} />)}
    </section>
  );
}

export function BubbleNotice({ row }: { readonly row: RowOf<'notice'> | RowOf<'child'> }): JSX.Element {
  const context = useChatContext();
  const copy = useChatCopy();
  return (
    <p className="chat-notice">
      {row.text}
      {row.kind === 'child' && row.relatedSessionId && context.onOpenRelated && (
        <button type="button" className="chat-link-button" onClick={() => context.onOpenRelated?.(row.relatedSessionId!)}>{copy.openRelated}</button>
      )}
    </p>
  );
}

export function BubbleError({ row }: { readonly row: RowOf<'error'> }): JSX.Element {
  return (
    <p className="chat-error" role="alert"><AlertTriangle aria-hidden="true" />{row.text}</p>
  );
}
