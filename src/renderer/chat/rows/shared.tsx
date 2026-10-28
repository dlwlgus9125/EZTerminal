import { Glyph } from '../../ui/Glyph';
import { useEffect, useRef, useState } from 'react';

import { MAX_CHAT_REPLY_LENGTH } from '../../../shared/chat-message';
import { formatClock, useChatCopy } from '../copy';
import { useChatContext } from '../ChatContext';
import { formatDuration } from '../model/summary';
import type { ChatRow, ChatTool } from '../model/types';

/** Hover/focus actions under a message: copy, reply, reuse, local time. */
export function MessageActions({ text, messageId, allowReuse = false, createdAt, showTime = true }: {
  readonly text: string;
  readonly messageId: string;
  readonly allowReuse?: boolean;
  readonly createdAt: string;
  /** False where the row shows its time itself (my message's "나 · time" line). */
  readonly showTime?: boolean;
}): JSX.Element {
  const copy = useChatCopy();
  const context = useChatContext();
  const [copied, setCopied] = useState<'ok' | 'failed' | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const announce = (state: 'ok' | 'failed'): void => {
    setCopied(state);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(undefined), 1_600);
  };
  return (
    <div className="chat-message-actions">
      <button
        type="button"
        className="chat-icon-action"
        aria-label={copied === 'ok' ? copy.copied : copy.copy}
        title={copy.copy}
        onClick={() => {
          if (!navigator.clipboard) { announce('failed'); return; }
          void navigator.clipboard.writeText(text).then(() => announce('ok'), () => announce('failed'));
        }}
      >
        {copied === 'ok' ? <Glyph name="check" /> : <Glyph name="copy" />}
      </button>
      {context.onReply && text.length > 0 && (
        <button
          type="button"
          className="chat-icon-action"
          aria-label={copy.reply}
          title={copy.reply}
          onClick={() => context.onReply?.({ messageId, text: text.slice(0, MAX_CHAT_REPLY_LENGTH) })}
        >
          <Glyph name="undo" />
        </button>
      )}
      {allowReuse && context.onReuse && (
        <button type="button" className="chat-icon-action" aria-label={copy.reuse} title={copy.reuse} onClick={() => context.onReuse?.(text)}>
          <Glyph name="refresh" />
        </button>
      )}
      {showTime && <time className="chat-message-time" dateTime={createdAt}>{formatClock(createdAt, context.locale)}</time>}
      <span className="chat-visually-hidden" role="status" aria-live="polite">
        {copied === 'ok' ? copy.copied : copied === 'failed' ? copy.copyFailed : ''}
      </span>
    </div>
  );
}

/** Long user prompts fold to a fixed height with a fade and a toggle. */
export function useFold(id: string, text: string): { readonly folded: boolean; readonly foldable: boolean; toggle(): void } {
  const context = useChatContext();
  const foldable = text.length > 600 || text.split('\n').length > 8;
  const open = context.isExpanded(`fold:${id}`, false);
  return { folded: foldable && !open, foldable, toggle: () => context.setExpanded(`fold:${id}`, !open) };
}

export function turnStatusText(row: Extract<ChatRow, { kind: 'turn-status' }>, now: number, copy: ReturnType<typeof useChatCopy>, locale: 'ko' | 'en'): string {
  const start = row.startedAt ? Date.parse(row.startedAt) : undefined;
  const end = row.finishedAt ? Date.parse(row.finishedAt) : undefined;
  const elapsed = start !== undefined ? formatDuration((end ?? now) - start, locale) : undefined;
  switch (row.state) {
    case 'queued':
      return copy.queued;
    case 'blocked':
      return copy.waiting;
    case 'submitting':
    case 'working':
    case 'delivery-uncertain':
      return elapsed ? copy.working(elapsed) : copy.thinking;
    case 'interrupted':
      return elapsed ? copy.interruptedAfter(elapsed) : copy.interruptedAfter('—');
    case 'failed':
      return elapsed ? copy.failedAfter(elapsed) : copy.failedAfter('—');
    default:
      return elapsed ? copy.worked(elapsed) : '';
  }
}

/** Display name used by the CLI skin: `Read(README.md)`, `Shell(node --version)`. */
export function cliToolName(tool: ChatTool): string {
  switch (tool.name) {
    case 'commandExecution':
      return 'Shell';
    case 'fileChange':
      return tool.category === 'write' ? 'Write' : 'Update';
    case 'webSearch':
      return 'Web Search';
    default:
      return tool.server ? `${tool.server} · ${tool.name}` : tool.name;
  }
}

export function toolMeta(tool: ChatTool, locale: 'ko' | 'en', copy: ReturnType<typeof useChatCopy>): string[] {
  const meta: string[] = [];
  if (tool.exitCode !== undefined && tool.exitCode !== 0) meta.push(copy.exit(tool.exitCode));
  if (tool.durationMs !== undefined && tool.durationMs >= 1_000) meta.push(formatDuration(tool.durationMs, locale));
  const files = tool.files ?? [];
  const added = files.reduce((total, file) => total + (file.added ?? 0), 0);
  const removed = files.reduce((total, file) => total + (file.removed ?? 0), 0);
  if (added || removed) meta.push([added ? `+${added}` : '', removed ? `−${removed}` : ''].filter(Boolean).join(' '));
  return meta;
}
