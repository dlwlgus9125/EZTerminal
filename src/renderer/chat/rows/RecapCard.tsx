import { Glyph, Led } from '../../ui/Glyph';
import { useChatContext } from '../ChatContext';
import { formatClock, useChatCopy, type ChatCopy } from '../copy';
import type { ChatRow } from '../model/types';
import { providerName } from '../review/review-presentation';
import { aiLines, InlineCode } from '../wrap-up/wrap-up-presentation';
import { ActionCard, type ActionCardAction } from './ActionCard';

type RowOf<K extends ChatRow['kind']> = Extract<ChatRow, { kind: K }>;

/** D3: the words after 요약 say why it was written, true also once it was answered. */
function headingText({ recap, waitingNow }: RowOf<'recap'>, copy: ChatCopy): string {
  if (recap.trigger !== 'waiting') return copy.recap.heading.away;
  return copy.recap.heading[waitingNow ? 'waiting' : 'answered'];
}

/** While the AI writes it, and when it could not (D4): one quiet line where the card goes, with the reason and 다시 만들기. */
function RecapLine({ row }: { readonly row: RowOf<'recap'> }): JSX.Element {
  const copy = useChatCopy();
  const context = useChatContext();
  const { recap } = row;
  const provider = providerName(recap.providerId);
  const generating = recap.state === 'generating';
  const failed = recap.failure ? `${copy.recap.failed} · ${copy.recap.failure[recap.failure]}` : copy.recap.failed;
  const retry = !generating && context.onWrapUpAction && context.recapRetry
    ? (): void => context.onWrapUpAction?.({ kind: 'recap-retry', turnId: recap.turnId }) : undefined;
  if (context.skin === 'cli') {
    return (
      <section className="chat-cli-line chat-recap-line" data-state={recap.state} data-testid="chat-recap-line">
        <span className="chat-cli-glyph" data-tone={generating ? 'live' : 'muted'} aria-hidden="true">✻</span>
        <div className="chat-cli-line__body">
          {!generating && <Glyph name="warn" className="chat-cli-action-card__icon" />}
          <span className="chat-cli-dim">{generating ? copy.recap.generatingBy(provider) : failed}</span>
          {retry && <><span className="chat-cli-dim" aria-hidden="true"> · </span><button type="button" className="chat-cli-action" onClick={retry}>{copy.recap.retry}</button></>}
        </div>
      </section>
    );
  }
  return (
    <p className="chat-recap-line" data-state={recap.state} data-testid="chat-recap-line">
      {generating ? <Led tone="on" /> : <Glyph name="warn" />}
      <span>{generating ? copy.recap.generatingBy(provider) : failed}</span>
      {retry && <span aria-hidden="true">·</span>}
      {retry && <button type="button" className="chat-link-button" onClick={retry}>{copy.recap.retry}</button>}
    </p>
  );
}

/**
 * The AI's recap of a turn: its own lines, quoted as its words, and — while the decision it stopped for is still
 * pending — the app's line that it waits, with 답하러 가기 (focus moves to that decision).
 */
export function RecapCard({ row }: { readonly row: RowOf<'recap'> }): JSX.Element {
  const copy = useChatCopy();
  const context = useChatContext();
  const { recap } = row;
  if (recap.state !== 'complete' || !recap.text?.trim()) return <RecapLine row={row} />;
  const provider = providerName(recap.providerId);
  const heading = headingText(row, copy);
  const clock = formatClock(recap.createdAt, context.locale);
  const lines = aiLines(recap.text);
  const waiting = row.waitingNow && recap.waiting ? copy.recap.waiting[recap.waiting] : undefined;
  const actions: ActionCardAction[] = waiting && context.onFocusDecision
    ? [{ id: 'answer', label: copy.recap.answer, onSelect: () => { context.onFocusDecision?.(); }, testId: 'chat-recap-answer' }] : [];
  const cli = context.skin === 'cli';
  return (
    <ActionCard
      kind="recap"
      testId="chat-recap-card"
      glyph="list"
      label={`${copy.recap.card} · ${heading} · ${copy.recap.wroteBy(provider)}`}
      title={copy.recap.card}
      cliName={copy.recap.cliName}
      cliTarget={provider}
      state="done"
      stateText={heading}
      meta={(
        <>
          <span className="chat-wrap-up-meta__who">{copy.recap.wroteBy(provider)}</span>
          <span className="chat-wrap-up-meta__time"><time dateTime={recap.createdAt}>{clock}</time></span>
        </>
      )}
      cliMeta={clock}
      {...(waiting ? { notes: [{ id: 'waiting', text: waiting }] } : {})}
      actions={actions}
    >
      {cli ? (
        <ul className="chat-cli-recap" aria-label={copy.recap.aiText(provider)}>
          {lines.map((line, index) => (
            // Index keys: the lines of one recap, written once.
            <li key={index} className="chat-cli-result">
              <span className="chat-cli-result__elbow" aria-hidden="true">⎿</span>
              <div className="chat-cli-result__body"><span className="chat-cli-result__line"><InlineCode text={line} /></span></div>
            </li>
          ))}
        </ul>
      ) : (
        <blockquote className="chat-recap__text" data-testid="chat-recap-text">
          {lines.map((line, index) => <p key={index}><InlineCode text={line} /></p>)}
        </blockquote>
      )}
    </ActionCard>
  );
}
