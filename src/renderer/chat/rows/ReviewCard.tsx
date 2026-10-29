import { Fragment, useEffect, useRef, useState, type RefObject } from 'react';

import { composeFixPrompt, REVIEW_LIMITS, reviewerLabel } from '../../../shared/review-findings';
import { Glyph } from '../../ui/Glyph';
import { formatClock, useChatCopy, type ChatCopy } from '../copy';
import { useChatContext, useNow, type ChatReviewAction } from '../ChatContext';
import { formatDuration } from '../model/summary';
import type { ChatReview, ChatReviewFinding, ChatRow } from '../model/types';
import {
  canFix, canReopen, countsText, findingWhere, FindingStatusChip, fixAgain, fixAllEligible, focusAfterAction, groupFindings, providerName, reasonText, reviewCounts,
  reviewerText, scopeText, SeverityChip, StaleMark, useClearing, useFindingAnnouncement, walkOrder,
} from '../review/review-presentation';
import { ActionCard, type ActionCardAction, type ActionCardNote, type ActionCardState } from './ActionCard';

type RowOf<K extends ChatRow['kind']> = Extract<ChatRow, { kind: K }>;
type ReviewActionHandler = (action: ChatReviewAction) => void;

function cardState(review: ChatReview): ActionCardState {
  switch (review.state) {
    case 'queued': return 'queued';
    case 'running': return 'running';
    case 'complete': return review.findings.length ? 'done' : 'empty';
    case 'failed': return 'failed';
    case 'unsupported': return 'unsupported';
    case 'cancelled':
    case 'interrupted': return 'stopped';
  }
}

function stateText(review: ChatReview, copy: ChatCopy, elapsed: string | undefined): string {
  switch (review.state) {
    case 'queued': return copy.aiReview.state.queued;
    case 'running': return elapsed ? copy.aiReview.state.runningFor(elapsed) : copy.aiReview.state.running;
    case 'complete': return copy.aiReview.state.complete;
    case 'failed': return copy.aiReview.state.failed;
    case 'unsupported': return copy.aiReview.state.unsupported;
    case 'cancelled': return copy.aiReview.state.cancelled;
    case 'interrupted': return copy.aiReview.state.interrupted;
  }
}

function message(review: ChatReview, copy: ChatCopy): { readonly text: string; readonly tone?: 'danger'; readonly label?: string } | undefined {
  const reason = review.reason ? reasonText(review.reason, review.reviewer, copy) : undefined;
  switch (review.state) {
    case 'queued': return { text: review.waitingFor === 'slot' ? copy.aiReview.detail.queuedSlot : copy.aiReview.detail.queued };
    case 'running': return { text: copy.aiReview.detail.running };
    case 'complete':
      if (!review.findings.length) return { text: review.overall ? `${copy.aiReview.detail.empty} ${review.overall}` : copy.aiReview.detail.empty };
      return review.overall ? { text: review.overall } : undefined;
    case 'failed': return { label: copy.aiReview.state.failed, text: reason?.text ?? copy.aiReview.detail.failedPlain, tone: 'danger' };
    case 'unsupported':
      return { text: !reason ? copy.aiReview.detail.unsupportedPlain : reason.known ? reason.text : copy.aiReview.detail.unsupported(reason.text) };
    case 'cancelled': return { text: reason?.text ?? copy.aiReview.detail.cancelled };
    case 'interrupted': return { text: reason?.text ?? copy.aiReview.detail.interrupted };
  }
}

function notes(review: ChatReview, copy: ChatCopy): ActionCardNote[] {
  return [
    ...(review.wroteFiles ? [{ id: 'wrote', text: copy.aiReview.note.wroteFiles, tone: 'danger' as const }] : []),
    ...(review.truncated ? [{ id: 'truncated', text: copy.aiReview.note.truncated(REVIEW_LIMITS.findings) }] : []),
    ...(review.dropped ? [{ id: 'dropped', text: copy.aiReview.note.dropped(review.dropped) }] : []),
  ];
}

/**
 * What 모두 고치기 sends, in the reviewer's order (most severe first): every eligible finding when their fix message
 * fits, else the first batch that fits, named with how many are left. After that batch is sent, the next one is offered.
 */
function fixAllBatch(review: ChatReview): { readonly ids: readonly string[]; readonly label: (copy: ChatCopy) => string } | undefined {
  const eligible = review.findings.filter(fixAllEligible);
  if (!eligible.length) return undefined;
  // The host quotes the reviewer with this label: a batch sized with another would be refused as too long.
  const prompt = composeFixPrompt({ reviewerLabel: reviewerLabel(review.reviewer.providerId), findings: eligible });
  if (prompt.ok) return { ids: eligible.map((finding) => finding.id), label: (copy) => copy.aiReview.fixAll(eligible.length) };
  if (prompt.fits <= 0) return undefined;
  return { ids: eligible.slice(0, prompt.fits).map((finding) => finding.id), label: (copy) => copy.aiReview.fixFirst(prompt.fits, eligible.length - prompt.fits) };
}

function cardActions(review: ChatReview, copy: ChatCopy, onAction: ReviewActionHandler | undefined): ActionCardAction[] {
  if (!onAction) return [];
  const act = (kind: ChatReviewAction['kind'], findingIds?: readonly string[]) => () => onAction({ kind, reviewId: review.reviewId, ...(findingIds ? { findingIds } : {}) });
  const openReviewer: ActionCardAction[] = review.reviewer.mode === 'other' && review.reviewer.sessionId
    ? [{ id: 'open-reviewer', label: copy.aiReview.openReviewer, onSelect: act('open-reviewer'), testId: 'chat-review-open-reviewer' }] : [];
  switch (review.state) {
    case 'queued': return [{ id: 'cancel', label: copy.aiReview.cancelQueued, onSelect: act('cancel'), testId: 'chat-review-cancel' }];
    case 'running': return [{ id: 'cancel', label: copy.aiReview.stop, onSelect: act('cancel'), testId: 'chat-review-cancel' }];
    case 'complete': {
      if (!review.findings.length) return openReviewer;
      const counts = reviewCounts(review);
      const batch = fixAllBatch(review);
      return [
        ...(batch ? [{ id: 'fix-all', label: batch.label(copy), primary: true, onSelect: act('fix-all', batch.ids), testId: 'chat-review-fix-all' }] : []),
        { id: 'walkthrough', label: copy.aiReview.walkthrough, onSelect: act('walkthrough'), testId: 'chat-review-walkthrough' },
        ...(counts.stale > 0 ? [{ id: 'retry', label: copy.aiReview.retry, onSelect: act('retry'), testId: 'chat-review-retry' }] : []),
        ...openReviewer,
      ];
    }
    case 'unsupported': return [{ id: 'other', label: copy.aiReview.reviewWithOther, primary: true, onSelect: act('review-with-other'), testId: 'chat-review-with-other' }];
    case 'failed':
    case 'cancelled':
    case 'interrupted': return [{ id: 'retry', label: copy.aiReview.retry, onSelect: act('retry'), testId: 'chat-review-retry' }, ...openReviewer];
  }
}

/**
 * 고치기 (다시 고치기 after a stop or a reply), 무시, 다시 열기. The pressed button may go away with the new state, so
 * focus then moves to the problem's title, which stays.
 */
function FindingActions({ review, finding, onAction, cli, titleRef }: {
  readonly review: ChatReview;
  readonly finding: ChatReviewFinding;
  readonly onAction: ReviewActionHandler;
  readonly cli: boolean;
  readonly titleRef: RefObject<HTMLElement>;
}): JSX.Element | null {
  const copy = useChatCopy();
  const where = findingWhere(finding);
  const act = (kind: ChatReviewAction['kind']) => () => {
    onAction({ kind, reviewId: review.reviewId, findingIds: [finding.id] });
    focusAfterAction(titleRef);
  };
  const actions = canFix(finding)
    ? [
      fixAgain(finding)
        ? { kind: 'fix' as const, label: copy.aiReview.fixAgain, name: copy.aiReview.fixAgainFinding(where) }
        : { kind: 'fix' as const, label: copy.aiReview.fix, name: copy.aiReview.fixFinding(where) },
      { kind: 'dismiss' as const, label: copy.aiReview.dismiss, name: copy.aiReview.dismissFinding(where) },
    ]
    : canReopen(finding) ? [{ kind: 'reopen' as const, label: copy.aiReview.reopen, name: copy.aiReview.reopenFinding(where) }] : [];
  if (!actions.length) return null;
  return (
    <span className={cli ? 'chat-cli-review-finding__actions' : 'chat-review-finding__actions'}>
      {actions.map((action, index) => (
        <Fragment key={action.kind}>
          {cli && index > 0 && <span className="chat-cli-dim" aria-hidden="true"> · </span>}
          <button type="button" className={cli ? 'chat-cli-action' : 'chat-review-finding__action'} data-action={action.kind}
            aria-label={action.name} onClick={act(action.kind)}>
            {action.label}
          </button>
        </Fragment>
      ))}
    </span>
  );
}

function FindingDetail({ finding, cli }: { readonly finding: ChatReviewFinding; readonly cli: boolean }): JSX.Element {
  const copy = useChatCopy();
  if (cli) {
    return (
      <>
        {finding.body !== finding.title && <span className="chat-cli-result__line chat-cli-review-finding__detail">{finding.body}</span>}
        {finding.scenario && <span className="chat-cli-result__line chat-cli-review-finding__detail">{copy.aiReview.scenario}: {finding.scenario}</span>}
      </>
    );
  }
  return (
    <div className="chat-review-finding__detail">
      {finding.body !== finding.title && <p className="chat-review-finding__body">{finding.body}</p>}
      {finding.scenario && (
        <>
          <p className="chat-review-finding__label">{copy.aiReview.scenario}</p>
          <p className="chat-review-finding__scenario">{finding.scenario}</p>
        </>
      )}
    </div>
  );
}

/** `안 고침`: why, in the AI's words. */
function FixReason({ finding, cli }: { readonly finding: ChatReviewFinding; readonly cli: boolean }): JSX.Element | null {
  const copy = useChatCopy();
  if (finding.status !== 'not-changed' || !finding.fixReason) return null;
  return cli
    ? <span className="chat-cli-result__line chat-review-finding__reason">{copy.aiReview.fixReason(finding.fixReason)}</span>
    : <p className="chat-review-finding__reason">{copy.aiReview.fixReason(finding.fixReason)}</p>;
}

function BubbleFinding({ review, finding, onAction }: {
  readonly review: ChatReview;
  readonly finding: ChatReviewFinding;
  readonly onAction: ReviewActionHandler | undefined;
}): JSX.Element {
  const copy = useChatCopy();
  const context = useChatContext();
  const titleRef = useRef<HTMLElement>(null);
  const key = `review:${review.reviewId}:${finding.id}`;
  const open = context.isExpanded(key, false);
  const where = findingWhere(finding);
  const expandable = finding.body !== finding.title || Boolean(finding.scenario);
  const lineText = finding.line === undefined ? undefined : where.slice(finding.file.length);
  return (
    <li className="chat-review-finding" data-finding-id={finding.id} data-status={finding.status} data-severity={finding.severity} data-stale={finding.stale || undefined}
      data-has-line={lineText ? true : undefined} data-testid="chat-review-finding">
      <div className="chat-review-finding__line">
        {finding.severity && <SeverityChip severity={finding.severity} copy={copy} />}
        {lineText && (onAction
          ? (
            <button type="button" className="chat-link-button chat-review-finding__where" aria-label={copy.aiReview.openFinding(where)}
              onClick={() => onAction({ kind: 'walkthrough', reviewId: review.reviewId, findingIds: [finding.id] })}>
              {lineText}
            </button>
          )
          : <span className="chat-review-finding__where">{lineText}</span>)}
        {expandable ? (
          <button ref={titleRef as RefObject<HTMLButtonElement>} type="button" className="chat-review-finding__title" aria-expanded={open}
            onClick={() => context.setExpanded(key, !open)} data-finding-title="">
            <span>{finding.title}</span>
            <Glyph name="next" className="chat-chevron" />
          </button>
        ) : <span ref={titleRef as RefObject<HTMLSpanElement>} className="chat-review-finding__title" tabIndex={-1} data-finding-title="">{finding.title}</span>}
        {(finding.status !== 'open' || finding.stale) && (
          <span className="chat-review-finding__marks">
            <FindingStatusChip status={finding.status} copy={copy} />
            {finding.stale && <StaleMark copy={copy} />}
          </span>
        )}
        {onAction && <FindingActions review={review} finding={finding} onAction={onAction} cli={false} titleRef={titleRef} />}
      </div>
      <FixReason finding={finding} cli={false} />
      {open && expandable && <FindingDetail finding={finding} cli={false} />}
    </li>
  );
}

function CliFinding({ review, finding, onAction }: {
  readonly review: ChatReview;
  readonly finding: ChatReviewFinding;
  readonly onAction: ReviewActionHandler | undefined;
}): JSX.Element {
  const copy = useChatCopy();
  const context = useChatContext();
  const titleRef = useRef<HTMLElement>(null);
  const key = `review:${review.reviewId}:${finding.id}`;
  const open = context.isExpanded(key, false);
  const where = findingWhere(finding);
  const expandable = finding.body !== finding.title || Boolean(finding.scenario);
  return (
    <li className="chat-cli-result chat-cli-review-finding" data-finding-id={finding.id} data-status={finding.status} data-stale={finding.stale || undefined}
      data-testid="chat-review-finding">
      <span className="chat-cli-result__elbow" aria-hidden="true">⎿</span>
      <div className="chat-cli-result__body">
        <span className="chat-cli-result__line">
          {onAction
            ? (
              <button type="button" className="chat-cli-action chat-cli-review-finding__where" aria-label={copy.aiReview.openFinding(where)}
                onClick={() => onAction({ kind: 'walkthrough', reviewId: review.reviewId, findingIds: [finding.id] })}>
                {where}
              </button>
            )
            : <span className="chat-cli-review-finding__where">{where}</span>}
          {finding.severity && (
            <span className="chat-cli-review-severity" data-severity={finding.severity}>
              {' ['}<span className="chat-visually-hidden">{copy.aiReview.severityPrefix} </span>{copy.aiReview.severity[finding.severity]}]
            </span>
          )}
          {' '}
          {/* Text, not a button: a long title wraps like terminal output; 자세히 opens the rest. */}
          <span ref={titleRef as RefObject<HTMLSpanElement>} className="chat-cli-review-finding__title" tabIndex={-1} data-finding-title="">{finding.title}</span>
          {finding.status !== 'open' && <span className="chat-cli-review-status" data-status={finding.status}> [{copy.aiReview.status[finding.status]}]</span>}
          {finding.stale && <span className="chat-cli-dim chat-cli-review-finding__stale" title={copy.aiReview.staleHint}> · {copy.aiReview.stale}</span>}
          {expandable && (
            <span className="chat-cli-review-finding__actions">
              <button type="button" className="chat-cli-action" aria-expanded={open} aria-label={copy.aiReview.detailsOf(where)} onClick={() => context.setExpanded(key, !open)}>
                {copy.aiReview.details}
              </button>
            </span>
          )}
          {onAction && <FindingActions review={review} finding={finding} onAction={onAction} cli titleRef={titleRef} />}
        </span>
        <FixReason finding={finding} cli />
        {open && expandable && <FindingDetail finding={finding} cli />}
      </div>
    </li>
  );
}

function RawAnswer({ review, cli }: { readonly review: ChatReview; readonly cli: boolean }): JSX.Element | null {
  const copy = useChatCopy();
  const context = useChatContext();
  const key = `review-raw:${review.reviewId}`;
  const open = context.isExpanded(key, false);
  if (!review.rawText) return null;
  const toggle = (
    <button type="button" className="chat-link-button" aria-expanded={open} onClick={() => context.setExpanded(key, !open)}>
      {open ? copy.aiReview.hideRaw : copy.aiReview.showRaw}
    </button>
  );
  if (cli) {
    return (
      <div className="chat-cli-result" data-tone="muted">
        <span className="chat-cli-result__elbow" aria-hidden="true">⎿</span>
        <div className="chat-cli-result__body">
          <span className="chat-cli-result__line">{toggle}</span>
          {open && <pre className="chat-review-raw" aria-label={copy.aiReview.rawAnswer}>{review.rawText}</pre>}
        </div>
      </div>
    );
  }
  return (
    <div className="chat-review-raw-block">
      {toggle}
      {open && <pre className="chat-review-raw" aria-label={copy.aiReview.rawAnswer}>{review.rawText}</pre>}
    </div>
  );
}

/** Says once when a queued review starts running; the card's later updates say nothing. */
function useStartAnnouncement(state: ChatReview['state'], reviewer: string, copy: ChatCopy): string {
  const previous = useRef(state);
  const [text, setText] = useState('');
  useEffect(() => {
    const before = previous.current;
    previous.current = state;
    if (before === 'queued' && state === 'running') setText(copy.aiReview.announceStarted(reviewer));
    // Only a change of state can start a review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return useClearing(text, setText);
}

/**
 * After 모두 고치기 the button may go: focus moves to the first problem sent (its title), else to the card's
 * heading — never to the page.
 */
function focusFirstSent(anchor: RefObject<HTMLElement>, ids: readonly string[]): void {
  requestAnimationFrame(() => {
    const card = anchor.current?.closest('[data-testid="chat-review-card"]');
    const title = ids[0] ? card?.querySelector<HTMLElement>(`[data-finding-id="${ids[0]}"] [data-finding-title]`) : undefined;
    (title ?? card?.querySelector<HTMLElement>('[data-card-heading]'))?.focus();
  });
}

/** One AI review in the transcript (both skins): a result, never something waiting on the person. */
export function ReviewCard({ row }: { readonly row: RowOf<'review'> }): JSX.Element {
  const copy = useChatCopy();
  const context = useChatContext();
  const { review } = row;
  const running = review.state === 'running';
  const now = useNow(running);
  const started = review.startedAt ? Date.parse(review.startedAt) : Number.NaN;
  const elapsed = running && Number.isFinite(started) ? formatDuration(now - started, context.locale) : undefined;
  const counts = reviewCounts(review);
  const who = reviewerText(review.reviewer, copy);
  const scope = scopeText(review.target, copy);
  const state = cardState(review);
  const text = stateText(review, copy, elapsed);
  const clock = formatClock(review.updatedAt, context.locale);
  const took = review.state === 'complete' && review.durationMs !== undefined ? copy.aiReview.took(formatDuration(review.durationMs, context.locale)) : undefined;
  const countText = review.findings.length ? countsText(counts, copy) : undefined;
  const changed = useFindingAnnouncement(review.findings, copy);
  const startedText = useStartAnnouncement(review.state, providerName(review.reviewer.providerId), copy);
  const announceRef = useRef<HTMLSpanElement>(null);
  const onAction = context.onReviewAction;
  const onCardAction = onAction ? (action: ChatReviewAction): void => {
    onAction(action);
    if (action.kind === 'fix-all') focusFirstSent(announceRef, action.findingIds ?? []);
  } : undefined;
  const cli = context.skin === 'cli';
  const meta = (
    <>
      <span className="chat-review-meta__who">{who}</span>
      <span className="chat-chip chat-review-meta__scope">{scope}</span>
      {countText && <span className="chat-review-meta__counts" data-testid="chat-review-counts">{countText}</span>}
      {review.focus && <span className="chat-review-meta__focus" title={review.focus}>{copy.aiReview.focus(review.focus)}</span>}
      {!running && <span className="chat-review-meta__time"><time dateTime={review.updatedAt}>{clock}</time>{took ? ` · ${took}` : ''}</span>}
    </>
  );
  // The CLI header already says how many problems; it adds what happened to them.
  const cliCounts = review.findings.length ? countsText(counts, copy, false) : '';
  const cliMeta = [scope, ...(cliCounts ? [cliCounts] : []), ...(running ? [] : [took ?? clock])].join(' · ');
  return (
    <ActionCard
      kind="review"
      testId="chat-review-card"
      label={`${copy.aiReview.card} · ${who} · ${text}`}
      title={copy.aiReview.card}
      cliName={copy.aiReview.cliName}
      cliTarget={who}
      state={state}
      stateText={text}
      cliStateText={review.state === 'complete' ? (review.findings.length ? copy.aiReview.state.found(review.findings.length) : copy.aiReview.state.empty) : text}
      meta={meta}
      cliMeta={cliMeta}
      message={message(review, copy)}
      notes={notes(review, copy)}
      {...(counts.stale > 0 ? { stale: copy.aiReview.note.stale } : {})}
      actions={cardActions(review, copy, onCardAction)}
    >
      {cli && review.focus && (
        <div className="chat-cli-result" data-tone="muted">
          <span className="chat-cli-result__elbow" aria-hidden="true">⎿</span>
          <div className="chat-cli-result__body"><span className="chat-cli-result__line">{copy.aiReview.focus(review.focus)}</span></div>
        </div>
      )}
      {review.findings.length > 0 && (cli ? (
        <ul className="chat-cli-review">
          {walkOrder(review).map((finding) => <CliFinding key={finding.id} review={review} finding={finding} onAction={onAction} />)}
        </ul>
      ) : (
        <div className="chat-review-files">
          {groupFindings(review.findings).map((group) => (
            <div key={group.file} className="chat-review-file" role="group" aria-label={copy.aiReview.fileProblems(group.file, group.findings.length)}>
              <p className="chat-review-file__head">
                <span className="chat-review-file__path" title={group.file}>{group.file}</span>
                <span className="chat-review-file__count" aria-hidden="true">{group.findings.length}</span>
              </p>
              <ul className="chat-review-findings">
                {group.findings.map((finding) => <BubbleFinding key={finding.id} review={review} finding={finding} onAction={onAction} />)}
              </ul>
            </div>
          ))}
        </div>
      ))}
      <RawAnswer review={review} cli={cli} />
      <span ref={announceRef} className="chat-visually-hidden" role="status" aria-live="polite" data-testid="chat-review-announce">
        {[startedText, changed].filter(Boolean).join(' · ')}
      </span>
    </ActionCard>
  );
}

/** The person's fix turn, or the request an other-AI reviewer received: a chip, the full text on demand. */
export function ReviewTurnChip({ row }: { readonly row: RowOf<'user'> }): JSX.Element {
  const copy = useChatCopy();
  const context = useChatContext();
  const key = `review-turn:${row.id}`;
  const open = context.isExpanded(key, false);
  const fix = row.origin === 'review-fix';
  const label = fix
    ? copy.aiReview.fixTurn(row.review?.findingIds?.length ?? 0)
    : copy.aiReview.requestTurn(row.review?.target ? scopeText(row.review.target, copy) : copy.aiReview.scopeUncommitted);
  const focus = !fix && row.review?.focus ? row.review.focus : undefined;
  const toggle = (
    <button type="button" className="chat-link-button chat-review-turn__toggle" aria-expanded={open} onClick={() => context.setExpanded(key, !open)}>
      {open ? copy.aiReview.hideText : copy.aiReview.showText}
    </button>
  );
  if (context.skin === 'cli') {
    return (
      <article className="chat-cli-line chat-cli-review-turn" data-origin={row.origin} aria-label={label} data-message-id={row.anchorId}>
        <span className="chat-cli-glyph" data-tone="prompt" aria-hidden="true">›</span>
        <div className="chat-cli-line__body">
          <span className="chat-cli-review-turn__label">{label}</span>
          {focus && <span className="chat-cli-dim"> · {copy.aiReview.focus(focus)}</span>}
          {' '}{toggle}
          {open && <p className="chat-cli-user__text chat-review-turn__text">{row.text}</p>}
        </div>
      </article>
    );
  }
  return (
    <article className="chat-review-turn" data-origin={row.origin} aria-label={label} data-message-id={row.anchorId}>
      <p className="chat-review-turn__chip">
        <Glyph name={fix ? 'edit' : 'search'} />
        <span className="chat-review-turn__label">{label}</span>
        {focus && <span className="chat-review-turn__focus" title={focus}>{copy.aiReview.focus(focus)}</span>}
        {toggle}
        <time className="chat-message-time" dateTime={row.createdAt}>{formatClock(row.createdAt, context.locale)}</time>
      </p>
      {open && <p className="chat-review-turn__text">{row.text}</p>}
    </article>
  );
}
