import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import type { DaemonReviewTarget } from '../../../shared/daemon-protocol';
import { REVIEW_LIMITS } from '../../../shared/review-findings';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Select } from '../../ui/FormControls';
import { Glyph } from '../../ui/Glyph';
import { useChatCopy } from '../copy';
import { providerName } from './review-presentation';
import './review.css';

/** An AI that can review; `unavailableReason` says why it cannot right now. */
export interface ReviewerChoice {
  readonly providerId: string;
  readonly unavailableReason?: string;
  /** The model and effort it reviews with, as the host will pick them (shown under the choice). */
  readonly settingsText?: string;
}

/** What the host offers for a review of this conversation. */
export interface ReviewStartOptions {
  /** This conversation's AI, reviewing in a read-only fork (the default). */
  readonly self: ReviewerChoice;
  /** Other AIs that review in a read-only conversation of their own. */
  readonly others: readonly ReviewerChoice[];
  /** The conversation works in a worktree off this branch: 기준 브랜치와 비교 is offered. */
  readonly baseRef?: string;
  /** The conversation works in a worktree whose base the host finds: 기준 브랜치와 비교 is offered without its name. */
  readonly worktree?: boolean;
  /** Why no review can start here (not a Git repository, history only…). */
  readonly disabledReason?: string;
  /** The conversation is answering: the review waits for the turn to end. */
  readonly busy?: boolean;
}

/** `base-branch` without `baseRef`: the host compares with the worktree's own base. */
export type ReviewStartTarget = DaemonReviewTarget;

export interface ReviewStartRequest {
  readonly reviewer: { readonly mode: 'self' | 'other'; readonly providerId: string };
  readonly target: ReviewStartTarget;
  readonly focus?: string;
}

type Mode = 'self' | 'other';

function firstChoice(options: ReviewStartOptions): { mode: Mode; other: string } {
  const other = options.others.find((choice) => !choice.unavailableReason) ?? options.others[0];
  const mode: Mode = options.self.unavailableReason && other && !other.unavailableReason ? 'other' : 'self';
  return { mode, other: other?.providerId ?? '' };
}

/**
 * Who reviews, what it reads and what to look at. Reviews never start on their own: this form
 * (from `/review`, the ⋯ menu or the Results tab) is how a person asks for one.
 */
export function ReviewStartForm({ options, onStart, onCancel, initialTarget, initialFocus = '' }: {
  readonly options: ReviewStartOptions;
  readonly onStart: (request: ReviewStartRequest) => void;
  readonly onCancel: () => void;
  /** The changes the person was looking at (Results › Changes): chosen to begin with. */
  readonly initialTarget?: ReviewStartTarget;
  /** `/review <text>`: the text, as the focus. */
  readonly initialFocus?: string;
}): JSX.Element {
  const copy = useChatCopy().aiReview.start;
  const id = useId();
  const initial = firstChoice(options);
  const branchOffered = Boolean(options.baseRef) || options.worktree === true;
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [other, setOther] = useState(initial.other);
  const [scope, setScope] = useState<'uncommitted' | 'base-branch'>(initialTarget?.kind === 'base-branch' && branchOffered ? 'base-branch' : 'uncommitted');
  const [focus, setFocus] = useState(initialFocus.slice(0, REVIEW_LIMITS.focus));
  const disabled = Boolean(options.disabledReason);
  const otherChoice = options.others.find((choice) => choice.providerId === other);
  const chosen = mode === 'self' ? options.self : otherChoice;
  const blockedReason = options.disabledReason
    ?? (mode === 'other' && !otherChoice ? copy.noOther : chosen?.unavailableReason);
  const branch = scope === 'base-branch' && branchOffered;
  const start = (): void => {
    if (blockedReason || !chosen) return;
    const trimmed = focus.trim();
    onStart({
      reviewer: { mode, providerId: chosen.providerId },
      target: branch ? { kind: 'base-branch', ...(options.baseRef ? { baseRef: options.baseRef } : {}) } : { kind: 'uncommitted' },
      ...(trimmed ? { focus: trimmed } : {}),
    });
  };
  const onFocusKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      start();
    }
  };
  const selfName = providerName(options.self.providerId);
  return (
    <form className="review-start" data-testid="review-start" onSubmit={(event) => { event.preventDefault(); start(); }}>
      <fieldset className="review-start__group" disabled={disabled}>
        <legend>{copy.reviewer}</legend>
        <label className="review-start__option" data-checked={mode === 'self' || undefined}>
          <input type="radio" name={`${id}-reviewer`} value="self" checked={mode === 'self'} disabled={Boolean(options.self.unavailableReason)}
            onChange={() => setMode('self')} aria-describedby={`${id}-self-hint`} data-testid="review-start-self" />
          <span className="review-start__text">
            <span className="review-start__label">{copy.self(selfName)}</span>
            <small id={`${id}-self-hint`} className="review-start__hint" data-blocked={options.self.unavailableReason ? true : undefined}>
              {options.self.unavailableReason ?? copy.selfHint}
            </small>
            {!options.self.unavailableReason && options.self.settingsText && (
              <small className="review-start__hint review-start__settings" data-testid="review-start-self-settings">{copy.uses(options.self.settingsText)}</small>
            )}
          </span>
        </label>
        <label className="review-start__option" data-checked={mode === 'other' || undefined}>
          <input type="radio" name={`${id}-reviewer`} value="other" checked={mode === 'other'} disabled={options.others.length === 0}
            onChange={() => setMode('other')} aria-describedby={`${id}-other-hint`} data-testid="review-start-other" />
          <span className="review-start__text">
            <span className="review-start__label">
              {copy.other}
              {options.others.length === 1 && ` · ${providerName(options.others[0]!.providerId)}`}
            </span>
            <small id={`${id}-other-hint`} className="review-start__hint" data-blocked={options.others.length === 0 || (mode === 'other' && otherChoice?.unavailableReason) ? true : undefined}>
              {options.others.length === 0 ? copy.noOther : mode === 'other' && otherChoice?.unavailableReason ? otherChoice.unavailableReason : copy.otherHint}
            </small>
            {otherChoice && !otherChoice.unavailableReason && otherChoice.settingsText && (
              <small className="review-start__hint review-start__settings" data-testid="review-start-other-settings">{copy.uses(otherChoice.settingsText)}</small>
            )}
          </span>
        </label>
        {options.others.length > 1 && mode === 'other' && (
          <Select uiSize="sm" className="review-start__provider" aria-label={copy.otherProvider} value={other} onChange={(event) => setOther(event.target.value)}>
            {options.others.map((choice) => <option key={choice.providerId} value={choice.providerId}>{providerName(choice.providerId)}</option>)}
          </Select>
        )}
      </fieldset>
      <fieldset className="review-start__group" disabled={disabled}>
        <legend>{copy.scope}</legend>
        <label className="review-start__option" data-checked={scope === 'uncommitted' || undefined}>
          <input type="radio" name={`${id}-scope`} value="uncommitted" checked={scope === 'uncommitted'} onChange={() => setScope('uncommitted')}
            aria-describedby={`${id}-uncommitted-hint`} data-testid="review-start-uncommitted" />
          <span className="review-start__text">
            <span className="review-start__label">{copy.uncommitted}</span>
            <small id={`${id}-uncommitted-hint`} className="review-start__hint">{copy.uncommittedHint}</small>
          </span>
        </label>
        <label className="review-start__option" data-checked={scope === 'base-branch' || undefined}>
          <input type="radio" name={`${id}-scope`} value="base-branch" checked={scope === 'base-branch'} disabled={!branchOffered}
            onChange={() => setScope('base-branch')} aria-describedby={`${id}-branch-hint`} data-testid="review-start-branch" />
          <span className="review-start__text">
            <span className="review-start__label">{options.baseRef ? copy.branch(options.baseRef) : copy.branchPlain}</span>
            <small id={`${id}-branch-hint`} className="review-start__hint">
              {options.baseRef ? copy.branchHint(options.baseRef) : branchOffered ? copy.branchHintPlain : copy.branchUnavailable}
            </small>
          </span>
        </label>
      </fieldset>
      <p className="review-start__target" data-testid="review-start-target">
        <span className="review-start__target-label">{copy.target}</span>
        {branch ? (options.baseRef ? copy.targetBranch(options.baseRef) : copy.targetBranchPlain) : copy.targetUncommitted}
      </p>
      <div className="review-start__focus">
        <label htmlFor={`${id}-focus`}>{copy.focus}</label>
        <textarea id={`${id}-focus`} rows={2} value={focus} maxLength={REVIEW_LIMITS.focus} placeholder={copy.focusPlaceholder} disabled={disabled}
          onChange={(event) => setFocus(event.target.value)} onKeyDown={onFocusKey} data-testid="review-start-focus" />
      </div>
      {options.busy && !disabled && <p className="review-start__note"><Glyph name="clock" />{copy.busy}</p>}
      {blockedReason && (
        <p className="review-start__note review-start__note--blocked" role="status" data-testid="review-start-reason"><Glyph name="info" />{blockedReason}</p>
      )}
      <div className="review-start__actions">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{copy.cancel}</Button>
        <Button type="submit" size="sm" variant="primary" disabled={Boolean(blockedReason)} data-testid="review-start-submit">{copy.startReview}</Button>
      </div>
    </form>
  );
}

/** The start form in a dialog (desktop) or a sheet (phone); it opens fresh every time. */
export function ReviewStartDialog({ open, onOpenChange, options, onStart, mobile = false, ownerDocument, initialTarget, initialFocus }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly options: ReviewStartOptions;
  readonly onStart: (request: ReviewStartRequest) => void;
  readonly mobile?: boolean;
  readonly ownerDocument?: Document;
  /** What the form chooses to begin with each time it opens. */
  readonly initialTarget?: ReviewStartTarget;
  /** The focus it opens with (`/review <text>`). */
  readonly initialFocus?: string;
}): JSX.Element {
  const copy = useChatCopy();
  const [generation, setGeneration] = useState(0);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) setGeneration((value) => value + 1);
    wasOpen.current = open;
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={copy.aiReview.start.title} description={copy.aiReview.start.description}
      size="sm" variant={mobile ? 'sheet' : 'dialog'} closeLabel={copy.aiReview.start.close} ownerDocument={ownerDocument} testId="review-start-dialog">
      <ReviewStartForm key={generation} options={options} onCancel={() => onOpenChange(false)}
        {...(initialTarget ? { initialTarget } : {})} {...(initialFocus ? { initialFocus } : {})}
        onStart={(request) => { onStart(request); onOpenChange(false); }} />
    </Dialog>
  );
}
