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

/** A suggested task's outcome in words; empty while it is still open. */
export function outcomeText(outcome: SuggestedTaskOutcome, copy: ChatCopy): string {
  switch (outcome.kind) {
    case 'open': return '';
    case 'starting': return copy.taskSuggestions.outcome.starting;
    case 'started': return outcome.branch ? copy.taskSuggestions.outcome.startedIn(outcome.branch) : copy.taskSuggestions.outcome.started;
    case 'sending': return copy.taskSuggestions.outcome.sending;
    case 'sent': return copy.taskSuggestions.outcome.sent;
    case 'queued': return outcome.position === undefined ? copy.taskSuggestions.outcome.queued : copy.taskSuggestions.outcome.queuedAt(outcome.position);
    case 'dismissed': return copy.taskSuggestions.outcome.dismissed;
    case 'start-failed': return copy.taskSuggestions.outcome.startFailed;
  }
}

/** `3개`, then what came of them: `3개 · 시작함 1 · 무시 1`. */
export function taskCountText(tasks: readonly SuggestedTaskState[], copy: ChatCopy): string {
  const count = (kinds: readonly SuggestedTaskOutcome['kind'][]): number => tasks.filter((task) => kinds.includes(task.outcome.kind)).length;
  const started = count(['started']);
  const here = count(['sent', 'queued']);
  const dismissed = count(['dismissed']);
  const parts = [
    ...(started ? [copy.taskSuggestions.startedCount(started)] : []),
    ...(here ? [copy.taskSuggestions.hereCount(here)] : []),
    ...(dismissed ? [copy.taskSuggestions.dismissedCount(dismissed)] : []),
  ];
  return parts.length ? copy.taskSuggestions.countMore(tasks.length, parts.join(' · ')) : copy.taskSuggestions.count(tasks.length);
}
