import { Fragment } from 'react';

import type { SuggestedTaskOutcome, SuggestedTaskState } from '../../../shared/turn-wrap-up';
import type { ChatCopy } from '../copy';
import './wrap-up.css';

/**
 * How the turn wrap-up reads in both skins (시안). What the AI wrote is shown as its own words, plain text with
 * `code` kept as code (no markdown, links or media from a recap or a task); what the app says is app text.
 */

/** The AI's lines: one per line as it wrote them, without a list marker it put in front. */
export function aiLines(text: string): string[] {
  return text.split(/\r?\n/u).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/u, '').trim()).filter(Boolean);
}

/** Text with its backtick spans as code. */
export function InlineCode({ text }: { readonly text: string }): JSX.Element {
  return (
    <>
      {text.split(/(`[^`\n]+`)/u).map((part, index) => (part.length > 2 && part.startsWith('`') && part.endsWith('`')
        // Index keys: the parts of one fixed string.
        ? <code key={index} className="chat-wrap-up-code">{part.slice(1, -1)}</code>
        : <Fragment key={index}>{part}</Fragment>))}
    </>
  );
}

/** A suggested task's outcome in words; empty while it is still open. `folder`: this conversation's, by name. */
export function outcomeText(outcome: SuggestedTaskOutcome, copy: ChatCopy, folder: string): string {
  switch (outcome.kind) {
    case 'open': return '';
    case 'starting': return copy.taskSuggestions.outcome.starting;
    case 'started': return outcome.branch ? copy.taskSuggestions.outcome.startedIn(outcome.branch) : copy.taskSuggestions.outcome.started;
    case 'sending': return copy.taskSuggestions.outcome.sending;
    case 'sent': return copy.taskSuggestions.outcome.sent;
    case 'queued': return outcome.position === undefined ? copy.taskSuggestions.outcome.queued : copy.taskSuggestions.outcome.queuedAt(outcome.position);
    case 'dismissed': return copy.taskSuggestions.outcome.dismissed;
    case 'start-failed':
      return outcome.start.where.kind === 'new-worktree' ? copy.taskSuggestions.outcome.startFailedIn(outcome.start.where.branch) : copy.taskSuggestions.outcome.startFailedHere(folder);
  }
}

/** `3개`, then what came of them, each kind apart: `4개 · 시작함 1 · 대기열 1 · 무시 1 · 시작 실패 1`. */
export function taskCountText(tasks: readonly SuggestedTaskState[], copy: ChatCopy): string {
  const count = (kinds: readonly SuggestedTaskOutcome['kind'][]): number => tasks.filter((task) => kinds.includes(task.outcome.kind)).length;
  const started = count(['started']);
  const sent = count(['sent']);
  const queued = count(['queued']);
  const dismissed = count(['dismissed']);
  const failed = count(['start-failed']);
  const parts = [
    ...(started ? [copy.taskSuggestions.startedCount(started)] : []),
    ...(sent ? [copy.taskSuggestions.sentCount(sent)] : []),
    ...(queued ? [copy.taskSuggestions.queuedCount(queued)] : []),
    ...(dismissed ? [copy.taskSuggestions.dismissedCount(dismissed)] : []),
    ...(failed ? [copy.taskSuggestions.failedCount(failed)] : []),
  ];
  return parts.length ? copy.taskSuggestions.countMore(tasks.length, parts.join(' · ')) : copy.taskSuggestions.count(tasks.length);
}
