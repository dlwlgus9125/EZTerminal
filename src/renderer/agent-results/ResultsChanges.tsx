import { Glyph, glyphIcon } from '../ui/Glyph';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { gitDiffFileChanges, patchKind, type ConversationFileChange, type FileChangeKind, type RecordedFileChange, type ReviewLine } from '../../shared/conversation-changes';
import type { GitDiffResult, GitDirectoryStatus } from '../../shared/git-status';
import type { ReviewTarget } from '../../shared/review-findings';
import type { ChatReviewAction } from '../chat/ChatContext';
import { formatClock, useChatLocale } from '../chat/copy';
import { workspacePath } from '../chat/model/summary';
import type { ChatReview, ChatReviewFinding } from '../chat/model/types';
import { findingWhere, walkOrder } from '../chat/review/review-presentation';
import { Button, EmptyState, IconButton, LoadingState, Select, Status } from '../ui';
import type { BackfillState } from './ConversationResults';
import type { DerivedResults } from './derive-results';
import { orderedRange, PatchLineList, selectedLines, type LineRange } from './PatchLineList';
import { PathLabel } from './PathLabel';
import { FindingAnnotation, ReviewWalkthrough } from './ReviewWalkthrough';
import { useResultsCopy } from './copy';
import { deletesFile, isFindingFile, lineRangeLabel, locateFinding, resolveWorkspacePath, samePath, type ReviewComment } from './results-format';
import { ReviewCommentTray } from './ReviewCommentTray';
import type { ResultsReviewStart, ResultsSendResult } from './results-source-store';
import { useResultsViewState, type ResultsServices, type WorktreeBaseDiffResult } from './results-services';

/** `base`: the worktree since it left its base branch (기준 브랜치와 비교). */
export type ChangeScope = 'turn' | 'all' | 'git' | 'base';

interface ChangeRecord {
  readonly id: string;
  readonly change: RecordedFileChange;
  readonly createdAt?: string;
}

interface FileEntry {
  readonly key: string;
  readonly path: string;
  readonly kind: FileChangeKind;
  readonly added: number;
  readonly removed: number;
  readonly records: readonly ChangeRecord[];
}

interface GitState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error';
  readonly status?: GitDirectoryStatus;
  readonly diff?: GitDiffResult | WorktreeBaseDiffResult;
  readonly at?: number;
}

interface ReviewState {
  readonly scope: ChangeScope;
  readonly turnId?: string;
  readonly path?: string;
  readonly reviewed: readonly string[];
  readonly comments: readonly ReviewComment[];
  /** Stepping through an AI review: which one, and the problem on screen. */
  readonly walk?: { readonly reviewId: string; readonly findingId: string };
}

const KIND_ICON = { add: glyphIcon('plus'), delete: glyphIcon('minus'), rename: glyphIcon('link'), update: glyphIcon('edit') } as const;

function groupRecords(changes: readonly ConversationFileChange[]): FileEntry[] {
  const byPath = new Map<string, { path: string; records: ChangeRecord[]; kinds: FileChangeKind[]; added: number; removed: number }>();
  for (const change of changes) {
    const key = change.path.replace(/[\\/]+/gu, '/').toLowerCase();
    const entry = byPath.get(key) ?? { path: change.path, records: [], kinds: [], added: 0, removed: 0 };
    entry.records.push({ id: change.id, change, ...(change.createdAt ? { createdAt: change.createdAt } : {}) });
    entry.kinds.push(change.kind);
    entry.added += change.added;
    entry.removed += change.removed;
    byPath.set(key, entry);
  }
  return [...byPath.entries()].map(([key, entry]) => {
    const first = entry.kinds[0];
    const last = entry.kinds.at(-1);
    const kind: FileChangeKind = last === 'delete' ? (first === 'add' ? 'update' : 'delete') : first === 'add' ? 'add' : last ?? 'update';
    return { key, path: entry.path, kind, added: entry.added, removed: entry.removed, records: entry.records };
  });
}

function gitEntries(diff: GitState['diff'], prefix: string): FileEntry[] {
  if (!diff?.ok) return [];
  return gitDiffFileChanges(diff.text).map((change) => {
    let added = 0;
    let removed = 0;
    let inHunk = false;
    for (const line of change.patch.split('\n')) {
      if (line.startsWith('@@')) inHunk = true;
      else if (inHunk && line.startsWith('+')) added += 1;
      else if (inHunk && line.startsWith('-')) removed += 1;
    }
    return { key: `${prefix}:${change.path}`, path: change.path, kind: patchKind(change), added, removed, records: [{ id: `${prefix}:${change.path}`, change }] };
  });
}

/**
 * The working folder as git sees it: against the last commit, or (with `baseRef`) since the
 * worktree left its base branch. Read when shown, when a turn ends and when a change record arrives.
 */
function useGitScope(
  workspaceRoot: string | undefined, services: ResultsServices, active: boolean, turnActive: boolean, artifactSequence: number, baseWorkspaceId?: string,
): [GitState, () => void] {
  const [state, setState] = useState<GitState>({ phase: 'idle' });
  const request = useRef(0);
  const refresh = (): void => {
    // The base scope names the workspace; the host finds its folder and base branch.
    const readDiff = baseWorkspaceId
      ? (services.getWorktreeBaseDiff ? () => services.getWorktreeBaseDiff!(baseWorkspaceId) : undefined)
      : services.getGitDiff;
    if (!workspaceRoot || !readDiff || !services.getGitStatus) return;
    const id = ++request.current;
    setState((current) => ({ ...current, phase: current.phase === 'ready' ? 'ready' : 'loading' }));
    void Promise.all([services.getGitStatus(workspaceRoot), readDiff(workspaceRoot)])
      .then(([status, diff]) => { if (request.current === id) setState({ phase: 'ready', status, diff, at: Date.now() }); })
      .catch(() => { if (request.current === id) setState({ phase: 'error', at: Date.now() }); });
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const atRef = useRef<number | undefined>(undefined);
  atRef.current = state.at;
  // Shown: read now. A turn that just ended, or a new change record while shown: read again.
  useEffect(() => { if (active) refreshRef.current(); }, [active, workspaceRoot]);
  const wasActiveTurn = useRef(turnActive);
  useEffect(() => {
    if (wasActiveTurn.current && !turnActive && active) refreshRef.current();
    wasActiveTurn.current = turnActive;
  }, [active, turnActive]);
  // Only a record that arrives while shown reads again; showing the scope already read it.
  const seenSequence = useRef(artifactSequence);
  useEffect(() => {
    const arrived = artifactSequence > seenSequence.current;
    seenSequence.current = artifactSequence;
    if (!active || !arrived) return undefined;
    const timer = window.setTimeout(() => refreshRef.current(), 1_000);
    return () => window.clearTimeout(timer);
  }, [active, artifactSequence]);
  useEffect(() => {
    if (!active) return undefined;
    const onFocus = (): void => { if (!atRef.current || Date.now() - atRef.current > 5_000) refreshRef.current(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [active]);
  return [state, () => refreshRef.current()];
}

export function ResultsChanges({
  sessionId, workspaceRoot, derived, transcriptFloor, backfill, onLoadEarlier, onCancelEarlier, services, insertIntoDraft, draftUnavailable, target, turnActive,
  folderReadable = true, onViewFile, baseRef, workspaceId, sendNow, reviewAction, openReviewStart,
}: {
  readonly sessionId: string;
  readonly workspaceRoot?: string;
  readonly derived: DerivedResults;
  readonly transcriptFloor: number;
  readonly backfill: BackfillState;
  readonly onLoadEarlier?: () => void;
  readonly onCancelEarlier?: () => void;
  readonly services: ResultsServices;
  readonly insertIntoDraft?: (text: string) => void;
  readonly draftUnavailable?: 'history' | 'disabled';
  /** A turn, file or AI review the conversation asked to show. */
  readonly target?: {
    readonly sequence: number;
    readonly turnId?: string;
    readonly path?: string;
    readonly review?: { readonly reviewId: string; readonly findingId?: string };
  };
  readonly turnActive: boolean;
  /** The work folder may be read (false while the host is asked, or once it was cleaned up: 작업 폴더 정리). */
  readonly folderReadable?: boolean;
  readonly onViewFile?: (path: string, line?: number) => void;
  /** The conversation works in a worktree off this branch: 기준 브랜치와 비교 is offered. */
  readonly baseRef?: string;
  /** The conversation's workspace, which 기준 브랜치와 비교 is read for. */
  readonly workspaceId?: string;
  /** Sends the comments as a message of their own (queued behind a running turn). */
  readonly sendNow?: (text: string) => Promise<ResultsSendResult>;
  /** Fix, dismiss or reopen the problem on screen (host actions). */
  readonly reviewAction?: (action: ChatReviewAction) => void;
  /** Opens the conversation's review start form, on the changes being viewed. */
  readonly openReviewStart?: (start?: ResultsReviewStart) => void;
}): JSX.Element {
  const copy = useResultsCopy();
  const locale = useChatLocale();
  const scopeId = useId();
  const [view, setView] = useResultsViewState<ReviewState>(`agent-results:review:${sessionId}`, { scope: 'turn', reviewed: [], comments: [] });
  const [selection, setSelection] = useState<{ readonly recordId: string; readonly range: LineRange }>();
  const [composing, setComposing] = useState(false);
  const [note, setNote] = useState('');
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // A remembered folder scope falls back when this conversation has no folder (or no base) to read.
  const gitAvailable = Boolean(workspaceRoot && folderReadable && services.getGitDiff && services.getGitStatus);
  const baseAvailable = Boolean(workspaceRoot && workspaceId && folderReadable && baseRef && services.getWorktreeBaseDiff && services.getGitStatus);
  const scope: ChangeScope = (view.scope === 'git' && !gitAvailable) || (view.scope === 'base' && !baseAvailable) ? 'all' : view.scope;
  const [git, refreshGit] = useGitScope(workspaceRoot, services, scope === 'git', turnActive, derived.artifactSequence);
  const [base, refreshBase] = useGitScope(workspaceRoot, services, scope === 'base', turnActive, derived.artifactSequence, workspaceId);
  const folder = scope === 'base' ? base : git;
  const folderScope = scope === 'git' || scope === 'base';

  /**
   * Where a review's diff lives: its own scope when this tab can read it, else what the AI reported. Whether the
   * folder may be read yet does not count: a tab the walkthrough just opened is still asking the host, and the
   * scope chosen here falls back above until it may (for good, once the folder was cleaned up).
   */
  const scopeFor = (reviewTarget: ReviewTarget): ChangeScope => {
    const readsGit = Boolean(workspaceRoot && services.getGitDiff && services.getGitStatus);
    const readsBase = Boolean(workspaceRoot && workspaceId && services.getWorktreeBaseDiff && services.getGitStatus)
      && reviewTarget.kind === 'base-branch' && baseRef === reviewTarget.baseRef;
    return readsBase ? 'base' : readsGit ? 'git' : 'all';
  };

  // A turn, file or review from the conversation picks the scope and file it points at.
  const handled = useRef(0);
  useEffect(() => {
    if (!target || target.sequence === handled.current) return;
    handled.current = target.sequence;
    const review = target.review ? derived.reviews.find((entry) => entry.reviewId === target.review!.reviewId) : undefined;
    const order = review ? walkOrder(review) : [];
    const finding = order.find((entry) => entry.id === target.review?.findingId) ?? order[0];
    if (review && finding) {
      setView((current) => ({ ...current, scope: scopeFor(review.target), path: finding.file, walk: { reviewId: review.reviewId, findingId: finding.id } }));
      setSelection(undefined);
      return;
    }
    setView((current) => ({
      ...current,
      scope: target.turnId ? 'turn' : current.scope === 'git' || current.scope === 'base' ? 'all' : current.scope,
      ...(target.turnId ? { turnId: target.turnId } : {}),
      ...(target.path ? { path: target.path } : {}),
    }));
    setSelection(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new target is handled once, with the reviews it finds then
  }, [setView, target]);

  const latestTurn = derived.turns.at(-1);
  const turnId = view.turnId && derived.turns.some((turn) => turn.turnId === view.turnId) ? view.turnId : latestTurn?.turnId;
  const selectedTurn = derived.turns.find((turn) => turn.turnId === turnId);
  const entries = useMemo(() => {
    if (scope === 'git') return gitEntries(git.diff, 'git');
    if (scope === 'base') return gitEntries(base.diff, 'base');
    const changes = scope === 'all' ? derived.changes : derived.changes.filter((change) => change.turnId === turnId);
    return groupRecords(changes);
  }, [base.diff, derived.changes, git.diff, scope, turnId]);
  const matches = (path: string, wanted: string): boolean => samePath(path, wanted) || isFindingFile(path, wanted, workspaceRoot);
  const selected = entries.find((entry) => view.path && matches(entry.path, view.path)) ?? entries[0];
  const reviewed = new Set(view.reviewed);
  const display = (path: string): string => workspacePath(path, workspaceRoot);

  // The review being stepped through, and the problem on screen.
  const walkReview: ChatReview | undefined = view.walk ? derived.reviews.find((entry) => entry.reviewId === view.walk!.reviewId) : undefined;
  const walkFindings = useMemo(() => (walkReview ? walkOrder(walkReview) : []), [walkReview]);
  const walkFinding = walkFindings.find((finding) => finding.id === view.walk?.findingId);
  const walkFile = walkFinding ? entries.find((entry) => isFindingFile(entry.path, walkFinding.file, workspaceRoot)) : undefined;
  /**
   * Each record's problems by line, and where the current one is. The latest record that shows a
   * problem's line decides: there it is found, or its code changed (`missing`, never anchored).
   */
  const walkPlacement = useMemo(() => {
    const byRecord = new Map<string, Map<number, { finding: ChatReviewFinding; moved?: number }[]>>();
    let current: { recordId: string; index: number; moved?: number } | undefined;
    let lost: 'missing' | 'deleted' | undefined;
    if (!walkFinding || !walkFile) return { byRecord, current, lost };
    for (const finding of walkFindings.filter((entry) => entry.file === walkFinding.file)) {
      for (const record of [...walkFile.records].reverse()) {
        const place = locateFinding(record.change, finding);
        if (place.state === 'outside') continue;
        if (place.state === 'missing' || place.state === 'deleted') {
          if (finding.id === walkFinding.id) lost = place.state;
          break;
        }
        const lines = byRecord.get(record.id) ?? new Map<number, { finding: ChatReviewFinding; moved?: number }[]>();
        lines.set(place.index, [...(lines.get(place.index) ?? []), { finding, ...(place.moved !== undefined ? { moved: place.moved } : {}) }]);
        byRecord.set(record.id, lines);
        if (finding.id === walkFinding.id) current = { recordId: record.id, index: place.index, ...(place.moved !== undefined ? { moved: place.moved } : {}) };
        break;
      }
    }
    return { byRecord, current, lost };
  }, [walkFile, walkFinding, walkFindings]);
  /** The problem on screen is not on a line of the change shown: outside it, its code changed, or its file is gone. */
  const walkPlace: 'outside' | 'missing' | 'deleted' | undefined = !walkFinding || walkPlacement.current ? undefined : walkPlacement.lost ?? 'outside';
  const step = (findingId: string): void => {
    const finding = walkFindings.find((entry) => entry.id === findingId);
    if (!finding || !view.walk) return;
    setView((current) => ({ ...current, path: finding.file, walk: { reviewId: view.walk!.reviewId, findingId } }));
    setSelection(undefined);
    setComposing(false);
  };
  const closeWalk = (): void => setView((current) => ({ ...current, walk: undefined }));

  const choose = (path: string): void => { setView((current) => ({ ...current, path })); setSelection(undefined); setComposing(false); };
  const toggleReviewed = (entry: FileEntry): void => {
    const ids = entry.records.map((record) => record.id);
    const all = ids.every((id) => reviewed.has(id));
    setView((current) => ({ ...current, reviewed: all ? current.reviewed.filter((id) => !ids.includes(id)) : [...new Set([...current.reviewed, ...ids])] }));
  };
  const selectedRecord = selected?.records.find((record) => record.id === selection?.recordId);
  const addComment = (text: string): void => {
    if (!selected || !selectedRecord || !selection) return;
    const lines = selectedLines(selectedRecord.change, selection.range);
    const [start, end] = orderedRange(selection.range);
    const comment: ReviewComment = {
      id: `${selectedRecord.id}:${String(start)}:${String(Date.now())}`,
      path: display(selected.path),
      lines: lineRangeLabel(lines),
      quote: lines.map((line) => line.text),
      text,
      recordId: selectedRecord.id,
      start,
      end,
    };
    setView((current) => ({ ...current, comments: [...current.comments, comment] }));
    setSelection(undefined);
    setComposing(false);
    setNote('');
  };
  /** Only the comments that went: ones added while a send was on its way stay. */
  const takeComments = (ids: readonly string[]): void => setView((current) => ({ ...current, comments: current.comments.filter((comment) => !ids.includes(comment.id)) }));
  useEffect(() => { if (composing) noteRef.current?.focus(); }, [composing]);
  const lineLabels = useMemo(() => ({
    showMore: copy.showMoreLines,
    line: (line: ReviewLine) => copy.patchLine(line.kind, line.after ?? line.before, line.text),
  }), [copy]);

  const pendingEarlier = scope === 'all' && transcriptFloor > 0 && backfill.phase !== 'done';
  const baseDiff = base.diff?.ok && 'ahead' in base.diff ? base.diff : undefined;
  const findingPath = walkFinding ? resolveWorkspacePath(walkFinding.file, workspaceRoot) ?? walkFinding.file : undefined;
  // The lines the review read, unmarked: shown when the change no longer holds them.
  const excerptLines = walkFinding?.excerpt && walkFinding.excerpt.lines.length > 0 ? (
    <>
      <span className="results-walk-excerpt__heading">{copy.walk.excerptHeading}</span>
      <div className="results-walk-excerpt" role="region" tabIndex={0} aria-label={copy.walk.excerptLabel(findingWhere(walkFinding))}>
        {walkFinding.excerpt.lines.map((line, offset) => (
          <div key={offset} className="results-walk-excerpt__line">
            <span className="results-walk-excerpt__number">{walkFinding.excerpt!.startLine + offset}</span>
            <code>{line || ' '}</code>
          </div>
        ))}
      </div>
    </>
  ) : null;
  // Never the line number's current code (or an older patch's): the place is named, with the lines the review read.
  const lostNote = walkFinding && (walkPlace === 'missing' || walkPlace === 'deleted') ? (
    <div className="results-walk-outside results-walk-missing" role="note" data-testid={walkPlace === 'deleted' ? 'results-walkthrough-deleted' : 'results-walkthrough-missing'}>
      <Glyph name="info" />
      {walkPlace === 'deleted'
        ? <span><strong>{copy.walk.deleted}</strong>{' '}{copy.walk.deletedDetail(walkFinding.file)}</span>
        : <span><strong>{copy.walk.missing}</strong>{' '}{copy.walk.missingDetail(findingWhere(walkFinding))}</span>}
      {walkPlace === 'missing' && onViewFile && findingPath && (
        <Button variant="ghost" size="sm" onClick={() => onViewFile(findingPath)}>{copy.walk.viewInFile}</Button>
      )}
      {excerptLines}
    </div>
  ) : null;
  const outsideNote = walkFinding && walkPlace === 'outside' ? (
    <div className="results-walk-outside" role="note" data-testid="results-walkthrough-outside">
      <Glyph name="info" />
      <span>
        <strong>{copy.walk.outside}</strong>{' '}
        {walkFinding.line === undefined ? copy.walk.noLine : copy.walk.outsideDetail(findingWhere(walkFinding))}
      </span>
      {onViewFile && findingPath && (
        <Button variant="ghost" size="sm" onClick={() => onViewFile(findingPath, walkFinding.line)}>{copy.walk.viewInFile}</Button>
      )}
    </div>
  ) : null;
  const annotationsFor = (recordId: string): ReadonlyMap<number, ReactNode> | undefined => {
    const lines = walkPlacement.byRecord.get(recordId);
    if (!lines) return undefined;
    const map = new Map<number, ReactNode>();
    for (const [index, found] of lines) {
      map.set(index, (
        <>
          {found.map(({ finding, moved }) => (
            <FindingAnnotation key={finding.id} finding={finding} current={finding.id === walkFinding?.id} {...(moved !== undefined ? { moved } : {})} onJump={step} />
          ))}
        </>
      ));
    }
    return map;
  };

  return (
    <div className="results-changes" data-testid="results-changes">
      <div className="results-toolbar">
        <label className="results-visually-hidden" htmlFor={scopeId}>{copy.scope}</label>
        <Select id={scopeId} aria-label={copy.scope} value={scope === 'turn' && turnId ? `turn:${turnId}` : scope}
          onChange={(event) => {
            const value = event.target.value;
            setSelection(undefined);
            if (value.startsWith('turn:')) setView((current) => ({ ...current, scope: 'turn', turnId: value.slice(5) }));
            else setView((current) => ({ ...current, scope: value as ChangeScope, ...(value === 'turn' ? { turnId: undefined } : {}) }));
          }}>
          {!derived.turns.length && <option value="turn">{copy.scopeTurn}</option>}
          {[...derived.turns].reverse().map((turn, index) => (
            <option key={turn.turnId} value={`turn:${turn.turnId}`}>
              {index === 0 ? `${copy.scopeTurn} · ${turn.createdAt ? formatClock(turn.createdAt, locale) : ''}` : copy.scopeTurnAt(turn.createdAt ? formatClock(turn.createdAt, locale) : '', turn.files)}
            </option>
          ))}
          <option value="all">{copy.scopeAll}</option>
          {gitAvailable && <option value="git">{copy.scopeGit}</option>}
          {baseAvailable && baseRef && <option value="base">{copy.scopeBase(baseRef)}</option>}
        </Select>
        {folderScope && (
          <IconButton size="sm" icon={glyphIcon('refresh')} aria-label={copy.refresh} onClick={scope === 'base' ? refreshBase : refreshGit} disabled={folder.phase === 'loading'} />
        )}
        {openReviewStart && (
          // The review starts on what is being viewed: the branch since its base, else the uncommitted changes.
          <Button size="sm" variant="secondary" leadingIcon={<Glyph name="search" />} title={copy.startReviewHint}
            onClick={() => openReviewStart(scope === 'base' && baseRef ? { target: { kind: 'base-branch', baseRef } } : scope === 'git' ? { target: { kind: 'uncommitted' } } : undefined)}
            data-testid="results-start-review">
            {copy.startReview}
          </Button>
        )}
      </div>
      <p className="results-note">
        {scope === 'base' ? (baseDiff ? copy.baseNotice(baseDiff.baseRef, baseDiff.ahead) : copy.baseLoading) : scope === 'git' ? copy.gitNotice : copy.reportedNotice}
        {folderScope && folder.at && <> · {copy.refreshedAt(formatClock(new Date(folder.at).toISOString(), locale))}</>}
        {folderScope && folder.status?.availability === 'ready' && folder.status.branch && <> · {copy.branch(folder.status.branch)}</>}
      </p>
      {scope === 'turn' && selectedTurn && view.turnId && view.turnId !== latestTurn?.turnId && selectedTurn.createdAt && (
        <p className="results-note">{copy.scopeSelectedTurn(formatClock(selectedTurn.createdAt, locale))}</p>
      )}
      {walkReview && walkFinding && (
        <ReviewWalkthrough review={walkReview} findingId={walkFinding.id} {...(walkPlace ? { place: walkPlace } : {})} onStep={step} onClose={closeWalk}
          {...(reviewAction ? { onAction: reviewAction } : {})} />
      )}
      {pendingEarlier && (
        <div className="results-banner" role="status">
          {backfill.phase === 'loading'
            ? <><span>{copy.loadingEarlier(backfill.loaded, backfill.total)}</span>{onCancelEarlier && <Button variant="ghost" size="sm" onClick={onCancelEarlier}>{copy.cancel}</Button>}</>
            : backfill.phase === 'error'
              ? <><span>{copy.earlierFailed}</span>{onLoadEarlier && <Button variant="ghost" size="sm" onClick={onLoadEarlier}>{copy.retry}</Button>}</>
              : <><span>{copy.earlierPending(transcriptFloor)}</span>{onLoadEarlier && <Button variant="ghost" size="sm" onClick={onLoadEarlier}>{copy.loadEarlier}</Button>}</>}
        </div>
      )}
      {folderScope && folder.phase === 'loading' && !folder.diff && <LoadingState label={scope === 'base' ? copy.baseLoading : copy.gitLoading} />}
      {folderScope && folder.phase === 'error' && <Status variant="danger">{copy.gitUnavailable}</Status>}
      {folderScope && folder.diff && !folder.diff.ok && (
        <Status variant={folder.diff.error === 'not-a-repository' || folder.diff.error === 'no-base' ? 'neutral' : 'danger'}>
          {folder.diff.error === 'not-a-repository' ? copy.gitNotRepository
            : folder.diff.error === 'no-base' && baseRef ? copy.baseMissing(baseRef)
              // The base scope's workspace is gone or is not a worktree: not a git failure.
              : folder.diff.error === 'invalid-path' && scope === 'base' ? copy.baseWorkspaceGone : copy.gitUnavailable}
        </Status>
      )}
      {folderScope && folder.diff?.ok && folder.diff.truncated && <Status variant="warning">{copy.gitTruncated}</Status>}
      {folderScope && folder.diff?.ok && folder.diff.omissions.length > 0 && <Status variant="neutral">{copy.gitOmitted(folder.diff.omissions.length)}</Status>}

      {entries.length === 0 ? (
        <>
          {outsideNote}
          {folderScope
            ? (folder.diff?.ok && <EmptyState title={copy.gitClean} />)
            : derived.changes.length === 0
              ? <EmptyState title={copy.noChanges} description={copy.noChangesHint} />
              : <p className="results-note">{copy.noTurnChanges}</p>}
        </>
      ) : (
        <>
          <ul className="results-file-list" aria-label={copy.fileList}>
            {entries.map((entry) => {
              const Icon = KIND_ICON[entry.kind];
              const done = entry.records.every((record) => reviewed.has(record.id));
              const flagged = walkFindings.filter((finding) => isFindingFile(entry.path, finding.file, workspaceRoot)).length;
              return (
                <li key={entry.key}>
                  <button type="button" className="results-file" aria-pressed={selected?.key === entry.key} onClick={() => choose(entry.path)} data-kind={entry.kind}>
                    <Icon className="results-file__icon" aria-hidden="true" />
                    <PathLabel path={display(entry.path)} />
                    {entry.kind !== 'update' && <span className="results-file__kind">{entry.kind === 'add' ? copy.created : entry.kind === 'delete' ? copy.deleted : copy.renamed}</span>}
                    {flagged > 0 && <span className="results-file__findings">{copy.walk.fileProblems(flagged)}</span>}
                    <span className="results-file__counts">
                      {entry.added > 0 && <span className="results-added">+{entry.added}</span>}
                      {entry.removed > 0 && <span className="results-removed">−{entry.removed}</span>}
                    </span>
                    {done && !folderScope && <span className="results-file__reviewed">{copy.reviewed}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {walkFinding && !walkFile && outsideNote}
          {selected && (
            <section className="results-diff" aria-label={display(selected.path)}>
              <header className="results-diff__header">
                <PathLabel path={display(selected.path)} className="results-diff__path" />
                <span className="results-diff__actions">
                  {/* A file whose latest record removed it has nothing to open (even if an earlier one created it). */}
                  {onViewFile && selected.kind !== 'delete' && !deletesFile(selected.records.at(-1)!.change) && (
                    <Button variant="ghost" size="sm" onClick={() => onViewFile(folderScope ? resolveWorkspacePath(selected.path, workspaceRoot) ?? selected.path : selected.path)}>{copy.viewFile}</Button>
                  )}
                  {!folderScope && (
                    <Button variant="ghost" size="sm" onClick={() => toggleReviewed(selected)}>
                      {selected.records.every((record) => reviewed.has(record.id)) ? copy.markUnread : copy.markReviewed}
                    </Button>
                  )}
                </span>
              </header>
              {walkFile === selected && (lostNote ?? outsideNote)}
              <p className="results-note">{selected.records.some((record) => record.change.coverage === 'fragment') ? copy.fragmentNote : copy.patchNote}</p>
              {selected.records.map((record, index) => {
                const commented = new Set<number>();
                for (const comment of view.comments) {
                  if (comment.recordId !== record.id || comment.start === undefined || comment.end === undefined) continue;
                  for (let line = comment.start; line <= comment.end; line += 1) commented.add(line);
                }
                const annotations = walkFile === selected ? annotationsFor(record.id) : undefined;
                const focusIndex = walkPlacement.current?.recordId === record.id && walkFile === selected ? walkPlacement.current.index : undefined;
                return (
                  <div key={record.id} className="results-diff__record">
                    {selected.records.length > 1 && (
                      <p className="results-diff__caption">{copy.recordOf(index + 1, selected.records.length)}{record.createdAt ? ` · ${formatClock(record.createdAt, locale)}` : ''}</p>
                    )}
                    <PatchLineList
                      change={record.change}
                      label={`${display(selected.path)}${selected.records.length > 1 ? ` · ${copy.recordOf(index + 1, selected.records.length)}` : ''}`}
                      {...(selection?.recordId === record.id ? { selection: selection.range } : {})}
                      commented={commented}
                      onSelect={(range) => { setSelection(range ? { recordId: record.id, range } : undefined); if (!range) setComposing(false); }}
                      onComment={() => setComposing(true)}
                      labels={lineLabels}
                      {...(annotations ? { annotations } : {})}
                      {...(focusIndex !== undefined ? { focusIndex } : {})}
                    />
                    {selection?.recordId === record.id && (
                      <div className="results-comment" role="group" aria-label={copy.commentLabel(`${display(selected.path)}:${lineRangeLabel(selectedLines(record.change, selection.range))}`)}>
                        {composing ? (
                          <>
                            <textarea ref={noteRef} className="results-comment__input" value={note} rows={2} placeholder={copy.commentPlaceholder}
                              aria-label={copy.commentLabel(lineRangeLabel(selectedLines(record.change, selection.range)) || display(selected.path))}
                              onChange={(event) => setNote(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (note.trim()) addComment(note); }
                                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setComposing(false); }
                              }} />
                            <span className="results-comment__actions">
                              <Button size="sm" variant="primary" disabled={!note.trim()} onClick={() => addComment(note)}>{copy.addComment}</Button>
                              <Button size="sm" variant="ghost" onClick={() => setComposing(false)}>{copy.cancel}</Button>
                            </span>
                          </>
                        ) : (
                          <span className="results-comment__actions">
                            <Button size="sm" variant="secondary" onClick={() => setComposing(true)}>{copy.addComment}</Button>
                            <Button size="sm" variant="ghost" onClick={() => addComment('')}>{copy.quoteOnly}</Button>
                            <Button size="sm" variant="ghost" onClick={() => setSelection(undefined)}>{copy.clearSelection}</Button>
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {!selection && <p className="results-note">{copy.selectLinesHint}</p>}
            </section>
          )}
        </>
      )}

      <ReviewCommentTray comments={view.comments} turnActive={turnActive} onTaken={takeComments}
        onRemove={(id) => setView((current) => ({ ...current, comments: current.comments.filter((entry) => entry.id !== id) }))}
        {...(sendNow ? { sendNow } : {})} {...(insertIntoDraft ? { insertIntoDraft } : {})} {...(draftUnavailable ? { draftUnavailable } : {})} />
    </div>
  );
}
