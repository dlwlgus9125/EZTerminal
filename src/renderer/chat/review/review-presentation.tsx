import { useEffect, useRef, useState } from 'react';

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

/**
 * A finding the person can send to be fixed: never sent, or sent and stopped, left unchanged or left
 * without an answer (those three are sent "again").
 */
export function canFix(finding: ChatReviewFinding): boolean {
  return finding.status === 'open' || finding.status === 'fix-stopped' || finding.status === 'not-changed' || finding.status === 'unconfirmed';
}

/** 다시 열기: a dismissed problem, or one the fix turn said was fixed (its history stays). */
export function canReopen(finding: ChatReviewFinding): boolean {
  return finding.status === 'dismissed' || finding.status === 'fixed';
}

/** 고치기 reads 다시 고치기 once the problem was sent before (stopped, answered, or reopened after a fix). */
export function fixAgain(finding: ChatReviewFinding): boolean {
  return finding.status !== 'open' || finding.fixTurnId !== undefined;
}

/** What 모두 고치기 sends: what was never handled, or stopped. A reply's "not changed" is the AI's answer, not a gap. */
export function fixAllEligible(finding: ChatReviewFinding): boolean {
  return finding.status === 'open' || finding.status === 'fix-stopped';
}

export interface ReviewCounts {
  readonly problems: number;
  /** The fix turn's reply said fixed. */
  readonly fixed: number;
  /** Sent, waiting for its turn (고침 요청됨). */
  readonly requested: number;
  /** Its fix turn runs (고치는 중). */
  readonly fixing: number;
  readonly notChanged: number;
  /** The fix turn finished without saying. */
  readonly unconfirmed: number;
  readonly dismissed: number;
  readonly stale: number;
}

export function reviewCounts(review: Pick<ChatReview, 'findings'>): ReviewCounts {
  const count = (test: (finding: ChatReviewFinding) => boolean): number => review.findings.filter(test).length;
  return {
    problems: review.findings.length,
    fixed: count((finding) => finding.status === 'fixed'),
    requested: count((finding) => finding.status === 'requested'),
    fixing: count((finding) => finding.status === 'fixing'),
    notChanged: count((finding) => finding.status === 'not-changed'),
    unconfirmed: count((finding) => finding.status === 'unconfirmed'),
    dismissed: count((finding) => finding.status === 'dismissed'),
    stale: count((finding) => finding.stale === true),
  };
}

/** `문제 6 · 고침 1 · 고침 요청됨 1 · 고치는 중 1 · 안 고침 1 · 확인 필요 1 · 무시 1`: only what is there, named as on each problem. */
export function countsText(counts: ReviewCounts, copy: ChatCopy, withProblems = true): string {
  return [
    ...(withProblems ? [copy.aiReview.problems(counts.problems)] : []),
    ...(counts.fixed ? [copy.aiReview.fixes(counts.fixed)] : []),
    ...(counts.requested ? [copy.aiReview.requestedCount(counts.requested)] : []),
    ...(counts.fixing ? [copy.aiReview.fixing(counts.fixing)] : []),
    ...(counts.notChanged ? [copy.aiReview.notChangedCount(counts.notChanged)] : []),
    ...(counts.unconfirmed ? [copy.aiReview.unconfirmedCount(counts.unconfirmed)] : []),
    ...(counts.dismissed ? [copy.aiReview.dismissedCount(counts.dismissed)] : []),
  ].join(' · ');
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
  'not-changed': 'minus',
  unconfirmed: 'q',
  'fix-stopped': 'x',
  dismissed: 'eyeOff',
};

/** 고침 요청됨 / 고치는 중 / 고침 / 안 고침 / 응답 끝 · 확인 필요 / 고침 멈춤 / 무시함; nothing for an open finding. */
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
/**
 * Says once, politely, what changed on a problem (`src/cart.ts:5 · 고침 요청됨`). The surfaces render
 * their whole state again on every update, so only the changes since the last render are spoken (a
 * problem that just came into view says nothing), and the line clears itself.
 */
export function useFindingAnnouncement(findings: readonly ChatReviewFinding[], copy: ChatCopy): string {
  const previous = useRef<ReadonlyMap<string, ChatReviewFindingStatus> | undefined>(undefined);
  const [announcement, setAnnouncement] = useState('');
  const signature = findings.map((finding) => `${finding.id}:${finding.status}`).join('|');
  useEffect(() => {
    const before = previous.current;
    previous.current = new Map(findings.map((finding) => [finding.id, finding.status]));
    if (!before) return;
    const changed = findings.filter((finding) => before.has(finding.id) && before.get(finding.id) !== finding.status);
    if (!changed.length) return;
    // 모두 고치기: one line for the batch, not one per problem.
    const batch = changed.length > 1 && changed.every((finding) => finding.status === 'requested' || finding.status === 'fixing');
    setAnnouncement(batch
      ? copy.aiReview.announceFixAll(changed.length)
      : changed.map((finding) => `${findingWhere(finding)} · ${copy.aiReview.announce[finding.status]}`).join(', '));
    // The signature is the problems' states; the array itself is new on every update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return useClearing(announcement, setAnnouncement);
}

/** A polite announcement says its piece once, then clears itself (6 s), whatever else updates meanwhile. */
export function useClearing(text: string, set: (text: string) => void): string {
  useEffect(() => {
    if (!text) return undefined;
    const timer = window.setTimeout(() => set(''), 6_000);
    return () => window.clearTimeout(timer);
  }, [set, text]);
  return text;
}

/** After 고치기, 무시 or 다시 열기 the pressed button may go away: focus moves to the problem's title, which stays. */
export function focusAfterAction(title: { readonly current: HTMLElement | null }): void {
  requestAnimationFrame(() => title.current?.focus());
}

export function StaleMark({ copy }: { readonly copy: ChatCopy }): JSX.Element {
  return (
    <span className="chat-review-stale" title={copy.aiReview.staleHint}>
      <Glyph name="refresh" />
      {copy.aiReview.stale}
    </span>
  );
}
