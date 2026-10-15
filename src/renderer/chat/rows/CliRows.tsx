import { Paperclip } from 'lucide-react';

import { useChatCopy } from '../copy';
import { useChatContext, useNow } from '../ChatContext';
import { formatDuration, toolDisplayTarget } from '../model/summary';
import type { ChatActivity, ChatRow, ChatTool } from '../model/types';
import { DiffView } from '../parts/DiffView';
import { Prose } from '../parts/Prose';
import { cleanOutput, hasToolDetail, ToolDetail } from '../parts/ToolDetail';
import { cliToolName, MessageActions, turnStatusText, useFold } from './shared';

type RowOf<K extends ChatRow['kind']> = Extract<ChatRow, { kind: K }>;

const PREVIEW_LINES = 3;

export function CliUser({ row }: { readonly row: RowOf<'user'> }): JSX.Element {
  const copy = useChatCopy();
  const fold = useFold(row.id, row.text);
  return (
    <article className="chat-cli-user" aria-label={copy.you} data-message-id={row.anchorId}>
      <div className="chat-cli-user__box" data-folded={fold.folded || undefined}>
        <span className="chat-cli-glyph" data-tone="prompt" aria-hidden="true">›</span>
        <div className="chat-cli-user__body">
          {row.context?.replyTo && <blockquote className="chat-cli-user__reply">{row.context.replyTo.text}</blockquote>}
          {row.context?.attachments?.map((attachment) => (
            <span key={attachment.id} className="chat-cli-attachment"><Paperclip aria-hidden="true" />{attachment.name}</span>
          ))}
          <p className="chat-cli-user__text">{row.text}</p>
        </div>
      </div>
      {fold.foldable && (
        <button type="button" className="chat-link-button" onClick={fold.toggle} aria-expanded={!fold.folded}>
          {fold.folded ? copy.showMore : copy.showLess}
        </button>
      )}
      <MessageActions text={row.text} messageId={row.messageId} allowReuse createdAt={row.createdAt} />
    </article>
  );
}

export function CliAssistant({ row, providerLabel }: { readonly row: RowOf<'assistant'>; readonly providerLabel: string }): JSX.Element {
  return (
    <article className="chat-cli-line chat-cli-assistant" aria-label={providerLabel} data-message-id={row.anchorId} data-streaming={row.streaming || undefined}>
      <span className="chat-cli-glyph" data-tone={row.streaming ? 'live' : 'text'} aria-hidden="true">⏺</span>
      <div className="chat-cli-line__body">
        <Prose markdown={row.text} streaming={row.streaming} variant="cli" />
        {!row.streaming && <MessageActions text={row.text} messageId={row.messageId} createdAt={row.createdAt} />}
      </div>
    </article>
  );
}

function resultSummary(tool: ChatTool, copy: ReturnType<typeof useChatCopy>, locale: 'ko' | 'en'): { readonly lines: readonly string[]; readonly hidden: number; readonly tone?: 'danger' | 'muted' } {
  if (tool.awaitingApproval) return { lines: [locale === 'ko' ? '승인 대기 중…' : 'Waiting for approval…'], hidden: 0, tone: 'muted' };
  if (tool.status === 'running') return { lines: [locale === 'ko' ? '실행 중…' : 'Running…'], hidden: 0, tone: 'muted' };
  if (tool.status === 'denied') return { lines: [locale === 'ko' ? '사용자가 거부함' : 'User rejected'], hidden: 0, tone: 'danger' };
  if (tool.status === 'interrupted') return { lines: [locale === 'ko' ? '중단됨' : 'Interrupted'], hidden: 0, tone: 'muted' };
  const files = tool.files ?? [];
  if (tool.changes?.length || files.length) {
    const added = files.reduce((total, file) => total + (file.added ?? 0), 0);
    const removed = files.reduce((total, file) => total + (file.removed ?? 0), 0);
    const names = files.map((file) => file.path.replace(/^.*[\\/]/u, '')).join(', ');
    return { lines: [locale === 'ko' ? `${names} 변경: 추가 ${added}줄, 삭제 ${removed}줄` : `Updated ${names} with ${added} additions and ${removed} removals`], hidden: 0 };
  }
  const output = tool.output ? cleanOutput(tool.output) : '';
  if (tool.category === 'read' && output) {
    const count = output.split('\n').length;
    return { lines: [locale === 'ko' ? `${count}줄 읽음` : `Read ${count} lines`], hidden: 0 };
  }
  if (!output) {
    return tool.status === 'failed'
      ? { lines: [tool.exitCode !== undefined ? copy.exit(tool.exitCode) : (locale === 'ko' ? '실패' : 'Failed')], hidden: 0, tone: 'danger' }
      : { lines: [copy.noOutput], hidden: 0, tone: 'muted' };
  }
  const all = output.split('\n');
  return { lines: all.slice(0, PREVIEW_LINES), hidden: Math.max(0, all.length - PREVIEW_LINES), ...(tool.status === 'failed' ? { tone: 'danger' as const } : {}) };
}

function CliTool({ tool }: { readonly tool: ChatTool }): JSX.Element {
  const context = useChatContext();
  const copy = useChatCopy();
  const key = `tool:${tool.callId}`;
  const smallDiff = (tool.changes ?? []).reduce((total, change) => total + change.patch.split('\n').length, 0) <= 24;
  const open = context.isExpanded(key, Boolean(tool.changes?.length) && smallDiff);
  const summary = resultSummary(tool, copy, context.locale);
  const target = toolDisplayTarget(tool, context.workspaceRoot);
  const glyphTone = tool.status === 'running' ? 'live' : tool.status === 'failed' || tool.status === 'denied' ? 'danger' : tool.status === 'interrupted' ? 'muted' : 'success';
  const expandable = hasToolDetail(tool);
  return (
    <li className="chat-cli-line chat-cli-tool" data-status={tool.status}>
      <span className="chat-cli-glyph" data-tone={glyphTone} aria-hidden="true">⏺</span>
      <div className="chat-cli-line__body">
        <button type="button" className="chat-cli-tool__call" aria-expanded={expandable ? open : undefined} disabled={!expandable}
          onClick={() => context.setExpanded(key, !open)}>
          <span className="chat-cli-tool__name">{cliToolName(tool)}</span>
          {target && <span className="chat-cli-tool__target">({target})</span>}
          {tool.durationMs !== undefined && tool.durationMs >= 1_000 && <span className="chat-cli-dim"> · {formatDuration(tool.durationMs, context.locale)}</span>}
        </button>
        <div className="chat-cli-result" data-tone={summary.tone}>
          <span className="chat-cli-result__elbow" aria-hidden="true">⎿</span>
          <div className="chat-cli-result__body">
            {summary.lines.map((line, index) => <span key={index} className="chat-cli-result__line">{line || ' '}</span>)}
            {summary.hidden > 0 && !open && (
              <button type="button" className="chat-link-button chat-cli-dim" onClick={() => context.setExpanded(key, true)}>
                {context.locale === 'ko' ? `… +${summary.hidden}줄` : `… +${summary.hidden} lines`}
              </button>
            )}
          </div>
        </div>
        {open && expandable && <ToolDetail tool={tool} variant="cli" />}
      </div>
    </li>
  );
}

function CliThought({ entry }: { readonly entry: Extract<ChatActivity, { kind: 'thought' }> }): JSX.Element {
  const context = useChatContext();
  const copy = useChatCopy();
  const key = `thought:${entry.id}`;
  const open = context.isExpanded(key, false);
  const hasText = entry.text.trim().length > 0;
  const label = entry.streaming
    ? `${copy.thinking}…`
    : entry.durationMs !== undefined ? copy.thoughtFor(formatDuration(entry.durationMs, context.locale)) : copy.thinking;
  return (
    <li className="chat-cli-line chat-cli-thought">
      <span className="chat-cli-glyph" data-tone={entry.streaming ? 'live' : 'muted'} aria-hidden="true">✻</span>
      <div className="chat-cli-line__body">
        <button type="button" className="chat-cli-tool__call chat-cli-dim" aria-expanded={hasText ? open : undefined} disabled={!hasText}
          onClick={() => context.setExpanded(key, !open)}>{label}</button>
        {open && hasText && <p className="chat-thought__text">{entry.text}</p>}
      </div>
    </li>
  );
}

export function CliActivity({ row }: { readonly row: RowOf<'activity'> }): JSX.Element {
  return (
    <ol className="chat-cli-run" data-live={row.live || undefined}>
      {row.entries.map((entry) => (entry.kind === 'tool'
        ? <CliTool key={entry.tool.callId} tool={entry.tool} />
        : <CliThought key={entry.id} entry={entry} />))}
    </ol>
  );
}

export function CliTurnStatus({ row }: { readonly row: RowOf<'turn-status'> }): JSX.Element | null {
  const context = useChatContext();
  const copy = useChatCopy();
  const live = row.state === 'working' || row.state === 'submitting' || row.state === 'delivery-uncertain';
  const now = useNow(live);
  const text = turnStatusText(row, now, copy, context.locale);
  if (!text) return null;
  return (
    <p className="chat-cli-line chat-cli-status" data-state={row.state} role={live ? 'status' : undefined}>
      <span className="chat-cli-glyph" data-tone={live ? 'live' : 'muted'} aria-hidden="true">✻</span>
      <span className="chat-cli-dim">{text}</span>
    </p>
  );
}

export function CliPlan({ row }: { readonly row: RowOf<'plan'> }): JSX.Element {
  const copy = useChatCopy();
  return (
    <section className="chat-cli-line chat-cli-plan" aria-label={copy.plan}>
      <span className="chat-cli-glyph" data-tone="text" aria-hidden="true">⏺</span>
      <div className="chat-cli-line__body">
        <div className="chat-cli-box">
          <p className="chat-cli-box__title">{copy.plan}{row.filePath ? ` · ${row.filePath.replace(/^.*[\\/]/u, '')}` : ''}</p>
          <Prose markdown={row.markdown} variant="cli" />
        </div>
      </div>
    </section>
  );
}

export function CliQuestion({ row }: { readonly row: RowOf<'question'> }): JSX.Element {
  const copy = useChatCopy();
  const answer = row.answer?.replace(/^Your questions have been answered:\s*/u, '').replace(/\.\s*You can now continue.*$/su, '');
  return (
    <section className="chat-cli-line" aria-label={copy.asked}>
      <span className="chat-cli-glyph" data-tone="text" aria-hidden="true">⏺</span>
      <div className="chat-cli-line__body">
        {row.questions.map((question, index) => (
          <div key={index}>
            <p className="chat-cli-tool__name">{question.question}</p>
            {question.options.map((option, optionIndex) => <p key={option} className="chat-cli-dim">  {optionIndex + 1}. {option}</p>)}
          </div>
        ))}
        <div className="chat-cli-result">
          <span className="chat-cli-result__elbow" aria-hidden="true">⎿</span>
          <span className="chat-cli-result__body">{answer ?? copy.awaitingAnswer}</span>
        </div>
      </div>
    </section>
  );
}

export function CliTodo({ row }: { readonly row: RowOf<'todo'> }): JSX.Element {
  const copy = useChatCopy();
  return (
    <section className="chat-cli-line" aria-label={copy.tasks}>
      <span className="chat-cli-glyph" data-tone="success" aria-hidden="true">⏺</span>
      <div className="chat-cli-line__body">
        <p className="chat-cli-tool__name">{copy.tasks}</p>
        <div className="chat-cli-result">
          <span className="chat-cli-result__elbow" aria-hidden="true">⎿</span>
          <ul className="chat-cli-todo">
            {row.items.map((item, index) => (
              <li key={`${index}:${item.text}`} data-status={item.status}>
                <span aria-hidden="true">{item.status === 'completed' ? '☒' : '☐'}</span> {item.text}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export function CliChanges({ row }: { readonly row: RowOf<'changes'> }): JSX.Element {
  const context = useChatContext();
  const copy = useChatCopy();
  const key = `changes:${row.id}`;
  const open = context.isExpanded(key, false);
  const added = row.files.reduce((total, file) => total + (file.added ?? 0), 0);
  const removed = row.files.reduce((total, file) => total + (file.removed ?? 0), 0);
  return (
    <section className="chat-cli-line chat-cli-changes">
      <span className="chat-cli-glyph" data-tone="success" aria-hidden="true">⏺</span>
      <div className="chat-cli-line__body">
        <button type="button" className="chat-cli-tool__call" aria-expanded={open} onClick={() => context.setExpanded(key, !open)}>
          <span className="chat-cli-tool__name">{copy.changedFiles(row.files.length)}</span>
          {added > 0 && <span className="chat-diff__added"> +{added}</span>}{removed > 0 && <span className="chat-diff__removed"> −{removed}</span>}
        </button>
        {context.onReviewChanges && <button type="button" className="chat-link-button" onClick={context.onReviewChanges}>{copy.review}</button>}
        {open && row.changes.map((change, index) => <DiffView key={`${change.path}:${index}`} change={change} variant="cli" />)}
      </div>
    </section>
  );
}

export function CliNotice({ row }: { readonly row: RowOf<'notice'> | RowOf<'child'> | RowOf<'error'> }): JSX.Element {
  const context = useChatContext();
  const copy = useChatCopy();
  return (
    <p className="chat-cli-line chat-cli-notice" data-kind={row.kind} role={row.kind === 'error' ? 'alert' : undefined}>
      <span className="chat-cli-glyph" data-tone={row.kind === 'error' ? 'danger' : 'muted'} aria-hidden="true">{row.kind === 'error' ? '✗' : '·'}</span>
      <span className="chat-cli-line__body">
        {row.text}
        {row.kind === 'child' && row.relatedSessionId && context.onOpenRelated && (
          <button type="button" className="chat-link-button" onClick={() => context.onOpenRelated?.(row.relatedSessionId!)}>{copy.openRelated}</button>
        )}
      </span>
    </p>
  );
}
