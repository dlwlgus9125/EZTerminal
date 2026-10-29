import { isReviewFailureReason, type ReviewSeverity, type ReviewTarget, type ReviewerRef } from '../../../shared/review-findings';
import { Glyph, type GlyphName } from '../../ui/Glyph';
import type { ChatCopy } from '../copy';
import type { ChatReview, ChatReviewFinding, ChatReviewFindingStatus } from '../model/types';
import './review.css';

/**
 * How an AI review reads wherever it shows: the transcript card in both skins, the Results
 * tab's walkthrough and the Android findings sheet. Severity and status are words first; the
 * glyph repeats them and colour only follows.
 */

export function providerName(providerId: string): string {
  if (providerId === 'claude') return 'Claude';
  if (providerId === 'codex') return 'Codex';
  return providerId ? `${providerId.charAt(0).toUpperCase()}${providerId.slice(1)}` : providerId;
}

/** `Claude` for this conversation's AI, `Codex · 다른 AI` for another one. */
export function reviewerText(reviewer: ReviewerRef, copy: ChatCopy): string {
  const name = providerName(reviewer.providerId);
  return reviewer.mode === 'other' ? copy.aiReview.reviewerOther(name) : name;
}

/** A review's reason in the reader's words when it is a known code; otherwise as the host wrote it. */
export function reasonText(reason: string, reviewer: ReviewerRef, copy: ChatCopy): { readonly text: string; readonly known: boolean } {
  return isReviewFailureReason(reason)
    ? { text: copy.aiReview.reason[reason](providerName(reviewer.providerId)), known: true }
    : { text: reason, known: false };
}

/** `커밋 안 한 변경` or `main 이후 변경`. */
export function scopeText(target: ReviewTarget, copy: ChatCopy): string {
  return target.kind === 'uncommitted' ? copy.aiReview.scopeUncommitted : copy.aiReview.scopeBranch(target.baseRef);
}

/** `src/cart.ts:5`, `src/cart.ts:5-7`, or the file alone. */
export function findingWhere(finding: Pick<ChatReviewFinding, 'file' | 'line' | 'endLine'>): string {
  if (finding.line === undefined) return finding.file;
  return finding.endLine !== undefined && finding.endLine > finding.line
    ? `${finding.file}:${String(finding.line)}-${String(finding.endLine)}`
    : `${finding.file}:${String(finding.line)}`;
}

export interface FindingGroup {
  readonly file: string;
  readonly findings: readonly ChatReviewFinding[];
}

/** Findings by file, files in the reviewer's order (most severe first), lines ascending within a file. */
export function groupFindings(findings: readonly ChatReviewFinding[]): FindingGroup[] {
  const groups = new Map<string, ChatReviewFinding[]>();
  for (const finding of findings) {
    const list = groups.get(finding.file) ?? [];
    list.push(finding);
    groups.set(finding.file, list);
  }
  return [...groups.entries()].map(([file, list]) => ({
    file,
    findings: list.slice().sort((left, right) => (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)),
  }));
}

/** The order a walkthrough steps through: the card's reading order. */
export function walkOrder(review: Pick<ChatReview, 'findings'>): ChatReviewFinding[] {
  return groupFindings(review.findings).flatMap((group) => group.findings);
}

/** A finding the person can still send to be fixed. */
export function canFix(finding: ChatReviewFinding): boolean {
  return finding.status === 'open' || finding.status === 'fix-stopped';
}

export interface ReviewCounts {
  readonly problems: number;
  /** Sent to be fixed: requested, being fixed or fixed. */
  readonly fixes: number;
  readonly dismissed: number;
  /** Still fixable (open or stopped). */
  readonly fixable: number;
  readonly stale: number;
}

export function reviewCounts(review: Pick<ChatReview, 'findings'>): ReviewCounts {
  let fixes = 0;
  let dismissed = 0;
  let fixable = 0;
  let stale = 0;
  for (const finding of review.findings) {
    if (finding.status === 'requested' || finding.status === 'fixing' || finding.status === 'fixed') fixes += 1;
    if (finding.status === 'dismissed') dismissed += 1;
    if (canFix(finding)) fixable += 1;
    if (finding.stale) stale += 1;
  }
  return { problems: review.findings.length, fixes, dismissed, fixable, stale };
}

const SEVERITY_GLYPH: Readonly<Record<ReviewSeverity, GlyphName>> = {
  critical: 'warn',
  high: 'up',
  medium: 'dot',
  low: 'down',
};

/** 치명 / 높음 / 보통 / 낮음 with its glyph; the word carries the meaning, colour only follows. */
export function SeverityChip({ severity, copy }: { readonly severity: ReviewSeverity; readonly copy: ChatCopy }): JSX.Element {
  return (
    <span className="chat-review-severity" data-severity={severity}>
      <Glyph name={SEVERITY_GLYPH[severity]} />
      <span className="chat-visually-hidden">{copy.aiReview.severityPrefix} </span>
      {copy.aiReview.severity[severity]}
    </span>
  );
}

const STATUS_GLYPH: Readonly<Record<Exclude<ChatReviewFindingStatus, 'open'>, GlyphName>> = {
  requested: 'send',
  fixing: 'spin',
  fixed: 'check',
  'fix-stopped': 'x',
  dismissed: 'eyeOff',
};

/** 고침 요청됨 / 고치는 중 / 고침 끝 / 고침 멈춤 / 무시함; nothing for an open finding. */
export function FindingStatusChip({ status, copy }: { readonly status: ChatReviewFindingStatus; readonly copy: ChatCopy }): JSX.Element | null {
  if (status === 'open') return null;
  return (
    <span className="chat-review-status" data-status={status}>
      <Glyph name={STATUS_GLYPH[status]} className={status === 'fixing' ? 'chat-spin' : undefined} />
      {copy.aiReview.status[status]}
    </span>
  );
}

/** 검토 뒤에 바뀜: the file changed after the review finished. */
export function StaleMark({ copy }: { readonly copy: ChatCopy }): JSX.Element {
  return (
    <span className="chat-review-stale" title={copy.aiReview.staleHint}>
      <Glyph name="refresh" />
      {copy.aiReview.stale}
    </span>
  );
}
