import { useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { Glyph, glyphIcon } from './ui/Glyph';
import type { DaemonTranscriptItem, DaemonTurn } from '../shared/daemon-protocol';
import { conversationFileChanges, reviewLines, type ConversationFileChange, type ReviewLine } from '../shared/conversation-changes';
import type { ReviewExcerpt } from '../shared/review-findings';
import { Button, Dialog, IconButton, Select } from './ui';
import { useAppTranslation } from './i18n';
import { readSessionViewState, saveSessionViewState } from './session-view-state';
import { ConversationReviewOverlayContext } from './conversation-review-overlay';
import type { ChatReviewAction } from './chat/ChatContext';
import { useChatCopy } from './chat/copy';
import { buildChatModel } from './chat/model/build-chat-model';
import { workspacePath } from './chat/model/summary';
import type { ChatReview, ChatReviewFinding } from './chat/model/types';
import {
  canFix, canReopen, findingWhere, FindingStatusChip, fixAgain, focusAfterAction, SeverityChip, StaleMark, useFindingAnnouncement, walkOrder,
} from './chat/review/review-presentation';
import { useResultsCopy } from './agent-results/copy';
import { isFindingFile, lineRangeLabel, locateFinding, type ReviewComment } from './agent-results/results-format';
import type { ResultsSendResult } from './agent-results/results-source-store';
import { ReviewCommentTray } from './agent-results/ReviewCommentTray';

interface ReviewState {
  open: boolean;
  scope: 'latest' | 'all';
  selected?: string;
  reviewed: string[];
  range?: [number, number];
  /** A range being tapped out: its first line, waiting for the last one. */
  selecting?: number;
  /** Comments collected to go together (a state saved before there were any has none). */
  comments?: ReviewComment[];
  /** `findings`: stepping through an AI review's problems (review loop); otherwise the recorded changes. */
  mode?: 'changes' | 'findings';
  walk?: { readonly reviewId: string; readonly findingId: string };
}

/** Lines shown around a problem's line from the recorded patch. */
const CONTEXT_LINES = 3;

type FindingLines =
  | { readonly kind: 'hunk'; readonly lines: readonly ReviewLine[]; readonly focus: number }
  /** The latest record that shows the problem's line has other code there: the review's lines, never anchored. */
  | { readonly kind: 'missing'; readonly excerpt?: ReviewExcerpt }
  /** The latest record for the file removes it: the review's lines, and no older patch. */
  | { readonly kind: 'deleted'; readonly excerpt?: ReviewExcerpt }
  /** No record shows the line: the lines the review read. */
  | { readonly kind: 'excerpt'; readonly excerpt: ReviewExcerpt };

/** Where an AI review's problem sits: the latest record that shows its line decides; else the lines the review kept. */
function findingLines(changes: readonly ConversationFileChange[], finding: ChatReviewFinding, workspaceRoot?: string): FindingLines | undefined {
  for (const change of [...changes].reverse()) {
    if (!isFindingFile(change.path, finding.file, workspaceRoot)) continue;
    const place = locateFinding(change, finding);
    if (place.state === 'outside') continue;
    if (place.state === 'missing' || place.state === 'deleted') {
      return { kind: place.state, ...(finding.excerpt && finding.excerpt.lines.length ? { excerpt: finding.excerpt } : {}) };
    }
    const lines = reviewLines(change);
    const from = Math.max(0, place.index - CONTEXT_LINES);
    return { kind: 'hunk', lines: lines.slice(from, place.index + CONTEXT_LINES + 1), focus: place.index - from };
  }
  return finding.excerpt && finding.excerpt.lines.length ? { kind: 'excerpt', excerpt: finding.excerpt } : undefined;
}

export function ConversationChangeReview({ sessionId, items, wide, mobile, ownerDocument, onQuote, onOpenProjectFiles, onAsideChange, openRequest = 0, hideTrigger = false, returnFocusRef,
  turns, workspaceRoot, findingsRequest, onReviewAction, onSendComments, turnActive = false, queuedTexts }: {
  sessionId: string; items: readonly DaemonTranscriptItem[]; wide: boolean; mobile: boolean; ownerDocument?: Document; onQuote?: (text: string) => void; onOpenProjectFiles?: () => void;
  /** Reports whether the review is docked beside the transcript, so the panel can reserve room without :has(). */
  onAsideChange?: (open: boolean) => void;
  /** Incremented by the transcript's "Review" action to open this review on the latest turn. */
  openRequest?: number;
  /** The host shows its own trigger (e.g. a header button) and opens the review with openRequest. */
  hideTrigger?: boolean;
  /** With hideTrigger: where focus returns when the phone's review sheet closes (the host's trigger). */
  returnFocusRef?: RefObject<HTMLButtonElement>;
  /** Turn records: a problem sent to be fixed follows its turn. */
  turns?: readonly DaemonTurn[];
  /** The conversation's working folder (recorded paths are absolute, a review's are relative). */
  workspaceRoot?: string;
  /** A review card's location was pressed: open on that problem (review loop). */
  findingsRequest?: { readonly sequence: number; readonly reviewId: string; readonly findingId?: string };
  /** Fix, dismiss or reopen the problem on screen (host actions). */
  onReviewAction?: (action: ChatReviewAction) => void;
  /** Sends the collected comments as a message of their own (queued behind a running turn). */
  onSendComments?: (text: string) => Promise<ResultsSendResult>;
  /** The conversation is answering: sent comments wait in its queue. */
  turnActive?: boolean;
  /** The messages waiting in the conversation's queue (a sent receipt says 대기열 while its message is there). */
  queuedTexts?: readonly string[];
}): JSX.Element {
  const { i18n } = useAppTranslation(); const ko = i18n.language.startsWith('ko');
  const chat = useChatCopy();
  const results = useResultsCopy();
  const HostOverlay = useContext(ConversationReviewOverlayContext);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const key = `conversation-review:${sessionId}`;
  const [state, setState] = useState<ReviewState>(() => readSessionViewState<ReviewState>(key) ?? { open: false, scope: 'latest', reviewed: [] });
  const [lineLimit, setLineLimit] = useState(400);
  const [note, setNote] = useState('');
  const asideOpen = wide && state.open;
  useEffect(() => { onAsideChange?.(asideOpen); }, [asideOpen, onAsideChange]);
  const updateWith = (patch: (current: ReviewState) => Partial<ReviewState>): void => setState(current => { const next = { ...current, ...patch(current) }; saveSessionViewState(key, next); return next; });
  const update = (patch: Partial<ReviewState>): void => updateWith(() => patch);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new request opens the review
  useEffect(() => { if (openRequest > 0) update({ open: true, scope: 'latest', mode: 'changes' }); }, [openRequest]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new request opens the problem
  useEffect(() => { if (findingsRequest) update({ open: true, mode: 'findings', walk: { reviewId: findingsRequest.reviewId, findingId: findingsRequest.findingId ?? '' } }); }, [findingsRequest?.sequence]);
  const changes = useMemo(() => conversationFileChanges(items, sessionId), [items, sessionId]);
  const latestTurn = changes.at(-1)?.turnId;
  const visible = changes.filter(change => state.scope === 'all' || change.turnId === latestTurn);
  const selected = visible.find(change => change.id === state.selected) ?? visible[0];
  const lines = useMemo(() => selected ? reviewLines(selected) : [], [selected]);
  const comments = state.comments ?? [];
  const range = state.range;
  const start = range ? Math.min(...range) : 0; const end = range ? Math.max(...range) : -1;
  const selecting = state.selecting;
  const rangeLabel = selected && range ? lineRangeLabel(lines.slice(start, end + 1)) : '';
  const commenting = Boolean(onSendComments || onQuote);
  /**
   * A tap starts a range, the next tap ends it (the same line again for one line) and a tap after that clears it: no
   * Shift on a phone. With a mouse, Shift still stretches the range from where it started.
   */
  const tapLine = (index: number, event: MouseEvent<HTMLButtonElement>): void => {
    if (!selected) return;
    const from = range ? range[0] : selecting;
    if (event.shiftKey && from !== undefined) { update({ selected: selected.id, range: [from, index], selecting: undefined }); return; }
    if (selecting !== undefined) { update({ selected: selected.id, range: [selecting, index], selecting: undefined }); return; }
    if (range) { update({ range: undefined }); setNote(''); return; }
    update({ selected: selected.id, selecting: index });
  };
  const addComment = (text: string): void => {
    if (!selected || !range) return;
    const picked = lines.slice(start, end + 1);
    const comment: ReviewComment = {
      id: `${selected.id}:${String(start)}:${String(Date.now())}`,
      path: workspacePath(selected.path, workspaceRoot),
      lines: lineRangeLabel(picked),
      quote: picked.map(line => line.text),
      text,
      recordId: selected.id,
      start,
      end,
    };
    updateWith(current => ({ comments: [...(current.comments ?? []), comment], range: undefined, selecting: undefined }));
    setNote('');
  };

  // Review loop: the card's problems one at a time, from the same model the transcript shows.
  const findingsMode = state.mode === 'findings' && Boolean(state.walk);
  const review: ChatReview | undefined = useMemo(() => {
    if (!findingsMode || !state.walk) return undefined;
    for (const row of buildChatModel({ items, ...(turns ? { turns } : {}) }).rows) {
      if (row.kind === 'review' && row.review.reviewId === state.walk.reviewId) return row.review;
    }
    return undefined;
  }, [findingsMode, items, state.walk, turns]);
  const order = review ? walkOrder(review) : [];
  const index = Math.max(0, order.findIndex(finding => finding.id === state.walk?.findingId));
  const finding = order[index];
  const title = findingsMode && finding ? chat.aiReview.card : ko ? '변경 검토' : 'Review changes';
  const openFiles = onOpenProjectFiles ? () => { update({ open: false }); onOpenProjectFiles(); } : undefined;
  const changesContent = <div className="conversation-review" data-mode="changes" data-testid="conversation-change-review">
    <div className="conversation-review__toolbar"><Select aria-label={ko ? '변경 범위' : 'Change scope'} value={state.scope} onChange={event => update({ scope: event.target.value as ReviewState['scope'], selected: undefined, range: undefined, selecting: undefined })}>
      <option value="latest">{ko ? '최근 변경 턴' : 'Latest changed turn'}</option><option value="all">{ko ? '이 대화 전체' : 'This conversation'}</option>
    </Select>{wide && <Button variant="ghost" aria-label={ko ? '검토 닫기' : 'Close review'} onClick={() => update({ open: false })}><Glyph name="x" /></Button>}</div>
    <p className="conversation-review__notice">{ko ? 'AI가 보고한 변경 기록입니다. 현재 작업 폴더 전체의 변경과 다를 수 있습니다.' : 'Changes reported by the AI. These may differ from the current working tree.'}</p>
    {openFiles && <Button variant="ghost" size="sm" onClick={openFiles}>{ko ? '현재 프로젝트 파일 열기' : 'Open current project files'}</Button>}
    {!visible.length && <p role="status">{ko ? '이 대화에서 확인 가능한 변경 패치가 없습니다.' : 'No recorded patches are available in this conversation.'}</p>}
    <ul className="conversation-review__files">{visible.map(change => <li key={change.id}><Button variant="ghost" aria-pressed={selected?.id === change.id} onClick={() => update({ selected: change.id, range: undefined, selecting: undefined })}>
      <Glyph name="diff" /><span>{change.path}</span>{state.reviewed.includes(change.id) && <span>{ko ? '확인함' : 'Reviewed'}</span>}
    </Button></li>)}</ul>
    {selected && <><p>{selected.coverage === 'fragment' ? (ko ? '부분 기록 · 파일 줄 번호는 제공되지 않았습니다.' : 'Partial record · file line numbers were not supplied.') : (ko ? '기록된 패치 · 왼쪽은 변경 전, 오른쪽은 변경 후 줄 번호입니다.' : 'Recorded patch · before and after line numbers.')} {commenting ? results.rangeHint : ''}</p>
      {selecting !== undefined && (
        <div className="conversation-review__selecting" data-testid="conversation-review-selecting">
          <span role="status"><strong>{results.rangeSelecting}</strong> {results.rangeFrom(lineRangeLabel(lines.slice(selecting, selecting + 1)))}</span>
          <Button variant="secondary" size="sm" aria-label={results.cancelRange} onClick={() => update({ selecting: undefined })} data-testid="conversation-review-selecting-cancel">{results.cancel}</Button>
        </div>
      )}
      <div className="conversation-review__patch" role="group" aria-label={selected.path}>
        {lines.slice(0, lineLimit).map((line, index) => <button key={index} type="button" className="conversation-review__line" data-kind={line.kind}
          aria-pressed={(!!range && index >= start && index <= end) || selecting === index} data-anchor={selecting === index || undefined}
          onClick={event => tapLine(index, event)}>
          <span className="conversation-review__number">{line.before ?? ''}</span><span className="conversation-review__number">{line.after ?? ''}</span><code>{line.text || ' '}</code>
        </button>)}
      </div>
      {lines.length > lineLimit && <Button variant="ghost" onClick={() => setLineLimit(value => value + 400)}>{ko ? '패치 더 보기' : 'Show more patch lines'}</Button>}
      {range && commenting && (
        <div className="conversation-review__comment" role="group" aria-label={results.commentLabel(`${workspacePath(selected.path, workspaceRoot)}:${rangeLabel}`)}>
          <label className="conversation-review__note">
            <span>{ko ? '의견 (선택)' : 'Comment (optional)'}</span>
            <textarea value={note} rows={2} placeholder={results.commentPlaceholder} onChange={event => setNote(event.target.value)} data-testid="conversation-review-note" />
          </label>
          <div className="conversation-review__toolbar">
            <Button variant="primary" size="sm" disabled={!note.trim()} onClick={() => addComment(note.trim())} data-testid="conversation-review-add">{results.addComment}</Button>
            <Button variant="secondary" size="sm" onClick={() => addComment('')} data-testid="conversation-review-quote-only">{results.quoteOnly}</Button>
            <Button variant="ghost" size="sm" onClick={() => { update({ range: undefined }); setNote(''); }}>{results.clearSelection}</Button>
          </div>
        </div>
      )}
      <div className="conversation-review__toolbar"><Button variant="ghost" onClick={() => update({ reviewed: state.reviewed.includes(selected.id) ? state.reviewed.filter(id => id !== selected.id) : [...state.reviewed, selected.id] })}>
        {state.reviewed.includes(selected.id) ? (ko ? '미확인으로 표시' : 'Mark unread') : (ko ? '확인함으로 표시' : 'Mark reviewed')}
      </Button></div>
    </>}
    <ReviewCommentTray comments={comments} turnActive={turnActive} {...(queuedTexts ? { queuedTexts } : {})}
      onTaken={ids => updateWith(current => ({ comments: (current.comments ?? []).filter(comment => !ids.includes(comment.id)) }))}
      onRemove={id => updateWith(current => ({ comments: (current.comments ?? []).filter(comment => comment.id !== id) }))}
      {...(onSendComments ? { sendNow: onSendComments } : {})}
      {...(onQuote ? { insertIntoDraft: (text: string) => { onQuote(text); if (!wide) update({ open: false }); } } : {})} />
  </div>;
  const findingsContent = finding && review ? <FindingsView review={review} finding={finding} index={index} total={order.length} changes={changes} workspaceRoot={workspaceRoot}
    onStep={findingId => update({ walk: { reviewId: review.reviewId, findingId } })}
    onAction={onReviewAction}
    {...(openFiles ? { onViewFile: openFiles } : {})}
    onShowChanges={() => update({ mode: 'changes' })} /> : null;
  const content = findingsContent ?? changesContent;
  return <>
    {!hideTrigger && <Button ref={triggerRef} className="conversation-review__trigger" variant="ghost" size="sm" leadingIcon={<Glyph name="diff" />} aria-expanded={state.open} onClick={() => update({ open: !state.open, mode: 'changes' })}>{ko ? '변경 검토' : 'Review changes'}{changes.length ? ` · ${changes.length}` : ''}</Button>}
    {mobile && HostOverlay ? state.open && <HostOverlay title={title} onClose={() => update({ open: false })} returnFocusRef={hideTrigger && returnFocusRef ? returnFocusRef : triggerRef}>{content}</HostOverlay>
      : wide && state.open ? <aside className="conversation-review__aside" aria-label={title}>{content}</aside> : <Dialog open={state.open} onOpenChange={open => update({ open })} title={title} ownerDocument={ownerDocument} variant={mobile ? 'sheet' : 'dialog'} size="lg" closeLabel={ko ? '닫기' : 'Close'}>{content}</Dialog>}
  </>;
}

/** One problem of an AI review: where it is, what the reviewer said, the lines around it, and fix or dismiss. */
function FindingsView({ review, finding, index, total, changes, workspaceRoot, onStep, onAction, onShowChanges, onViewFile }: {
  readonly review: ChatReview;
  readonly finding: ChatReviewFinding;
  readonly index: number;
  readonly total: number;
  readonly changes: readonly ConversationFileChange[];
  readonly workspaceRoot?: string;
  readonly onStep: (findingId: string) => void;
  readonly onAction?: (action: ChatReviewAction) => void;
  readonly onShowChanges: () => void;
  /** Opens the project's files (the line it can no longer find is not shown from here). */
  readonly onViewFile?: () => void;
}): JSX.Element {
  const { i18n } = useAppTranslation(); const ko = i18n.language.startsWith('ko');
  const chat = useChatCopy();
  const results = useResultsCopy();
  const titleRef = useRef<HTMLParagraphElement>(null);
  // Like a chat code block: long lines scroll sideways in a focusable region, or wrap on request.
  const [wrap, setWrap] = useState(false);
  const changed = useFindingAnnouncement([finding], chat);
  const order = walkOrder(review);
  const where = findingWhere(finding);
  const position = ko ? `문제 ${index + 1}/${total}` : `Problem ${index + 1} of ${total}`;
  const shown = findingLines(changes, finding, workspaceRoot);
  const act = (kind: ChatReviewAction['kind']) => () => {
    onAction?.({ kind, reviewId: review.reviewId, findingIds: [finding.id] });
    focusAfterAction(titleRef);
  };
  const severity = finding.severity ? chat.aiReview.severity[finding.severity] : '';
  const again = fixAgain(finding);
  const excerpt = shown?.kind === 'excerpt' || shown?.kind === 'missing' || shown?.kind === 'deleted' ? shown.excerpt : undefined;
  // The review's own lines: its line is marked only where the change does not hold other code there now.
  const excerptFocus = shown?.kind === 'excerpt' && finding.line !== undefined ? finding.line - shown.excerpt.startLine : undefined;
  return <div className="conversation-review" data-mode="findings" data-testid="conversation-change-review">
    <div className="conversation-review__findings-bar">
      <Button variant="ghost" aria-label={ko ? '이전 문제' : 'Previous problem'} disabled={index === 0} onClick={() => onStep(order[index - 1]!.id)} data-testid="conversation-review-previous"><Glyph name="back" /></Button>
      <p className="conversation-review__position"><strong>{position}</strong><code>{where}</code></p>
      <Button variant="ghost" aria-label={ko ? '다음 문제' : 'Next problem'} disabled={index === total - 1} onClick={() => onStep(order[index + 1]!.id)} data-testid="conversation-review-next"><Glyph name="next" /></Button>
    </div>
    <p className="conversation-review__finding-head">
      {finding.severity && <SeverityChip severity={finding.severity} copy={chat} />}
      <FindingStatusChip status={finding.status} copy={chat} />
      {finding.stale && <StaleMark copy={chat} />}
    </p>
    <p ref={titleRef} className="conversation-review__finding-title" tabIndex={-1} data-finding-title="">{finding.title}</p>
    {finding.status === 'not-changed' && finding.fixReason && <p className="conversation-review__reason">{chat.aiReview.fixReason(finding.fixReason)}</p>}
    {finding.body !== finding.title && <p>{finding.body}</p>}
    {finding.scenario && <p className="conversation-review__scenario"><span>{chat.aiReview.scenario}</span>{finding.scenario}</p>}
    {shown?.kind === 'missing' && (
      <div className="conversation-review__missing" role="note" data-testid="conversation-review-missing">
        <p><strong>{results.walk.missing}</strong> {results.walk.missingDetail(where)}</p>
        {onViewFile && <Button variant="secondary" size="sm" onClick={onViewFile} data-testid="conversation-review-view-file">{results.walk.viewInFile}</Button>}
      </div>
    )}
    {shown?.kind === 'deleted' && (
      <div className="conversation-review__missing" role="note" data-testid="conversation-review-deleted">
        <p><strong>{results.walk.deleted}</strong> {results.walk.deletedDetail(finding.file)}</p>
      </div>
    )}
    {shown?.kind === 'excerpt' && (
      <p className="conversation-review__notice">{ko ? '이 대화의 변경 기록에 이 줄이 없어 검토가 끝날 때 읽은 줄을 보여 줍니다.' : 'This line is not in the conversation’s recorded changes; showing the lines the review read.'}</p>
    )}
    {(shown?.kind === 'hunk' || excerpt) && (
      <div className="conversation-review__code-head">
        <span>{shown?.kind === 'hunk' ? (ko ? '변경 기록에서 그 줄 주변' : 'Around the line in the recorded change') : (ko ? '검토 때 읽은 줄' : 'As the review read it')}</span>
        <IconButton size="sm" icon={glyphIcon('wrap')} aria-label={ko ? '줄 바꿈' : 'Wrap lines'} aria-pressed={wrap} onClick={() => setWrap((value) => !value)}
          data-testid="conversation-review-wrap" />
      </div>
    )}
    {shown?.kind === 'hunk' && (
      <div className="conversation-review__patch" role="region" tabIndex={0} data-wrap={wrap || undefined} aria-label={ko ? `${where} 주변 변경` : `The change around ${where}`}>
        {shown.lines.map((line, offset) => <div key={offset} className="conversation-review__line" data-kind={line.kind} data-focus={offset === shown.focus || undefined}>
          <span className="conversation-review__number">{line.before ?? ''}</span><span className="conversation-review__number">{line.after ?? ''}</span><code>{line.text || ' '}</code>
        </div>)}
      </div>
    )}
    {excerpt && (
      <div className="conversation-review__patch" role="region" tabIndex={0} data-wrap={wrap || undefined} aria-label={results.walk.excerptLabel(where)}>
        {excerpt.lines.map((text, offset) => <div key={offset} className="conversation-review__line" data-kind="context" data-focus={offset === excerptFocus || undefined}>
          <span className="conversation-review__number" /><span className="conversation-review__number">{excerpt.startLine + offset}</span><code>{text || ' '}</code>
        </div>)}
      </div>
    )}
    {!shown && <p className="conversation-review__notice">{ko ? '변경 범위 밖 · 보여 줄 줄이 없습니다.' : 'Outside the change · no lines to show.'}</p>}
    <div className="conversation-review__toolbar conversation-review__finding-actions">
      {onAction && canFix(finding) && <>
        <Button variant="primary" aria-label={again ? chat.aiReview.fixAgainFinding(where) : chat.aiReview.fixFinding(where)} onClick={act('fix')} data-testid="conversation-review-fix">
          {again ? chat.aiReview.fixAgain : chat.aiReview.fix}
        </Button>
        <Button variant="secondary" aria-label={chat.aiReview.dismissFinding(where)} onClick={act('dismiss')} data-testid="conversation-review-dismiss">{chat.aiReview.dismiss}</Button>
      </>}
      {onAction && canReopen(finding) && <Button variant="secondary" aria-label={chat.aiReview.reopenFinding(where)} onClick={act('reopen')} data-testid="conversation-review-reopen">{chat.aiReview.reopen}</Button>}
      <Button variant="ghost" onClick={onShowChanges}>{ko ? '변경 모두 보기' : 'All changes'}</Button>
    </div>
    <p className="ez-ui-visually-hidden" aria-live="polite" aria-atomic="true">{[position, where, severity, finding.title].filter(Boolean).join(' · ')}</p>
    <p className="ez-ui-visually-hidden" aria-live="polite" data-testid="conversation-review-status">{changed}</p>
  </div>;
}
