import { useRef } from 'react';

import type { ChatReviewAction } from '../chat/ChatContext';
import { useChatCopy } from '../chat/copy';
import type { ChatReview, ChatReviewFinding } from '../chat/model/types';
import {
  canFix, findingWhere, FindingStatusChip, focusAfterAction, reviewerText, SeverityChip, StaleMark, useFindingAnnouncement, walkOrder,
} from '../chat/review/review-presentation';
import { Button } from '../ui';
import { Glyph } from '../ui/Glyph';
import { useResultsCopy } from './copy';

/**
 * Stepping through an AI review in Changes: which problem of how many, back and forth, and fix or
 * dismiss the one on screen. Each step is announced; focus stays on the strip so the next press
 * moves on, while the diff scrolls the problem's line into view below.
 */
export function ReviewWalkthrough({ review, findingId, outside = false, missing = false, onStep, onAction, onClose }: {
  readonly review: ChatReview;
  readonly findingId: string;
  /** The problem's line is not in the change shown. */
  readonly outside?: boolean;
  /** The change shows the problem's line holding other code than the review read. */
  readonly missing?: boolean;
  readonly onStep: (findingId: string) => void;
  readonly onAction?: (action: ChatReviewAction) => void;
  readonly onClose: () => void;
}): JSX.Element | null {
  const copy = useResultsCopy();
  const chat = useChatCopy();
  const titleRef = useRef<HTMLSpanElement>(null);
  const order = walkOrder(review);
  const index = order.findIndex((finding) => finding.id === findingId);
  const finding = order[index];
  const changed = useFindingAnnouncement(finding ? [finding] : [], chat);
  if (!finding) return null;
  const where = findingWhere(finding);
  const position = copy.walk.position(index + 1, order.length);
  const severity = finding.severity ? chat.aiReview.severity[finding.severity] : '';
  const place = missing ? copy.walk.missing : outside ? copy.walk.outside : '';
  const announce = `${copy.walk.announce(position, where, severity, finding.title)}${place ? ` · ${place}` : ''}`;
  const act = (kind: ChatReviewAction['kind']) => () => {
    onAction?.({ kind, reviewId: review.reviewId, findingIds: [finding.id] });
    focusAfterAction(titleRef);
  };
  const again = finding.status !== 'open';
  return (
    <section className="results-walk" aria-label={copy.walk.label(reviewerText(review.reviewer, chat))} data-testid="results-walkthrough">
      <div className="results-walk__bar">
        <span className="results-walk__position" data-testid="results-walkthrough-position">{position}</span>
        <Button size="sm" variant="ghost" leadingIcon={<Glyph name="back" />} aria-label={copy.walk.previousLabel} disabled={index === 0}
          onClick={() => onStep(order[index - 1]!.id)} data-testid="results-walkthrough-previous">
          {copy.walk.previous}
        </Button>
        <Button size="sm" variant="ghost" trailingIcon={<Glyph name="next" />} aria-label={copy.walk.nextLabel} disabled={index === order.length - 1}
          onClick={() => onStep(order[index + 1]!.id)} data-testid="results-walkthrough-next">
          {copy.walk.next}
        </Button>
        {onAction && canFix(finding) && (
          <>
            <Button size="sm" variant="secondary" aria-label={again ? chat.aiReview.fixAgainFinding(where) : chat.aiReview.fixFinding(where)} onClick={act('fix')}
              data-testid="results-walkthrough-fix">
              {again ? chat.aiReview.fixAgain : copy.walk.fix}
            </Button>
            <Button size="sm" variant="ghost" aria-label={chat.aiReview.dismissFinding(where)} onClick={act('dismiss')} data-testid="results-walkthrough-dismiss">{copy.walk.dismiss}</Button>
          </>
        )}
        {onAction && finding.status === 'dismissed' && (
          <Button size="sm" variant="ghost" aria-label={chat.aiReview.reopenFinding(where)} onClick={act('reopen')} data-testid="results-walkthrough-reopen">{copy.walk.reopen}</Button>
        )}
        <Button size="sm" variant="ghost" className="results-walk__close" aria-label={copy.walk.closeLabel} onClick={onClose} data-testid="results-walkthrough-close">
          {copy.walk.close}
        </Button>
      </div>
      <p className="results-walk__finding">
        {finding.severity && <SeverityChip severity={finding.severity} copy={chat} />}
        <code className="results-walk__where">{where}</code>
        <span ref={titleRef} className="results-walk__title" title={finding.title} tabIndex={-1} data-finding-title="">{finding.title}</span>
        <FindingStatusChip status={finding.status} copy={chat} />
        {finding.stale && <StaleMark copy={chat} />}
        {place && <span className="results-walk__outside">{place}</span>}
      </p>
      {finding.status === 'not-changed' && finding.fixReason && <p className="results-walk__reason">{chat.aiReview.fixReason(finding.fixReason)}</p>}
      <p className="results-visually-hidden" aria-live="polite" aria-atomic="true" data-testid="results-walkthrough-announce">{announce}</p>
      <p className="results-visually-hidden" aria-live="polite" data-testid="results-walkthrough-status">{changed}</p>
    </section>
  );
}

/** What the review found on a line, under that line in the diff: the current problem in full, others as a way there. */
export function FindingAnnotation({ finding, current, moved, onJump }: {
  readonly finding: ChatReviewFinding;
  readonly current: boolean;
  /** The anchor lines moved here since the review. */
  readonly moved?: number;
  readonly onJump: (findingId: string) => void;
}): JSX.Element {
  const chat = useChatCopy();
  const copy = useResultsCopy();
  if (!current) {
    return (
      <button type="button" className="results-finding results-finding--other" onClick={() => onJump(finding.id)}>
        {finding.severity && <SeverityChip severity={finding.severity} copy={chat} />}
        <span className="results-finding__title">{finding.title}</span>
        <FindingStatusChip status={finding.status} copy={chat} />
      </button>
    );
  }
  return (
    <div className="results-finding" data-current="true" data-testid="results-finding-current">
      <p className="results-finding__head">
        {finding.severity && <SeverityChip severity={finding.severity} copy={chat} />}
        <span className="results-finding__title">{finding.title}</span>
        <FindingStatusChip status={finding.status} copy={chat} />
        {finding.stale && <StaleMark copy={chat} />}
      </p>
      {moved !== undefined && <p className="results-finding__moved">{copy.walk.moved(moved)}</p>}
      {finding.body !== finding.title && <p className="results-finding__body">{finding.body}</p>}
      {finding.scenario && (
        <p className="results-finding__scenario"><span className="results-finding__label">{chat.aiReview.scenario}</span>{finding.scenario}</p>
      )}
    </div>
  );
}
