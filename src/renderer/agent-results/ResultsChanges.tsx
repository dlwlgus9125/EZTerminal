import { FileMinus2, FilePen, FilePlus2, FileSymlink, RefreshCw, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { gitDiffFileChanges, patchKind, type ConversationFileChange, type FileChangeKind, type RecordedFileChange, type ReviewLine } from '../../shared/conversation-changes';
import type { GitDiffResult, GitDirectoryStatus } from '../../shared/git-status';
import { formatClock, useChatLocale } from '../chat/copy';
import { workspacePath } from '../chat/model/summary';
import { Button, EmptyState, IconButton, LoadingState, Select, Status } from '../ui';
import type { BackfillState } from './ConversationResults';
import type { DerivedResults } from './derive-results';
import { orderedRange, PatchLineList, selectedLines, type LineRange } from './PatchLineList';
import { useResultsCopy } from './copy';
import { formatReviewComments, lineRangeLabel, REVIEW_DRAFT_LIMIT, resolveWorkspacePath, samePath, type ReviewComment } from './results-format';
import { useResultsViewState, type ResultsServices } from './results-services';

export type ChangeScope = 'turn' | 'all' | 'git';

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
  readonly diff?: GitDiffResult;
  readonly at?: number;
}

interface ReviewState {
  readonly scope: ChangeScope;
  readonly turnId?: string;
  readonly path?: string;
  readonly reviewed: readonly string[];
  readonly comments: readonly ReviewComment[];
}

const KIND_ICON = { add: FilePlus2, delete: FileMinus2, rename: FileSymlink, update: FilePen } as const;

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

function gitEntries(diff: GitDiffResult | undefined): FileEntry[] {
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
    return { key: `git:${change.path}`, path: change.path, kind: patchKind(change), added, removed, records: [{ id: `git:${change.path}`, change }] };
  });
}

function useGitScope(workspaceRoot: string | undefined, services: ResultsServices, active: boolean, turnActive: boolean, artifactSequence: number): [GitState, () => void] {
  const [state, setState] = useState<GitState>({ phase: 'idle' });
  const request = useRef(0);
  const refresh = (): void => {
    if (!workspaceRoot || !services.getGitDiff || !services.getGitStatus) return;
    const id = ++request.current;
    setState((current) => ({ ...current, phase: current.phase === 'ready' ? 'ready' : 'loading' }));
    void Promise.all([services.getGitStatus(workspaceRoot), services.getGitDiff(workspaceRoot)])
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
  useEffect(() => {
    if (!active || artifactSequence === 0) return undefined;
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

export function ResultsChanges({ sessionId, workspaceRoot, derived, transcriptFloor, backfill, onLoadEarlier, onCancelEarlier, services, insertIntoDraft, draftUnavailable, target, turnActive, onViewFile }: {
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
  /** A turn or file the conversation asked to show. */
  readonly target?: { readonly sequence: number; readonly turnId?: string; readonly path?: string };
  readonly turnActive: boolean;
  readonly onViewFile?: (path: string) => void;
}): JSX.Element {
  const copy = useResultsCopy();
  const locale = useChatLocale();
  const scopeId = useId();
  const [view, setView] = useResultsViewState<ReviewState>(`agent-results:review:${sessionId}`, { scope: 'turn', reviewed: [], comments: [] });
  const [selection, setSelection] = useState<{ readonly recordId: string; readonly range: LineRange }>();
  const [composing, setComposing] = useState(false);
  const [note, setNote] = useState('');
  const [inserted, setInserted] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [git, refreshGit] = useGitScope(workspaceRoot, services, view.scope === 'git', turnActive, derived.artifactSequence);

  // A turn or file link from the conversation picks the scope and file it points at.
  const handled = useRef(0);
  useEffect(() => {
    if (!target || target.sequence === handled.current) return;
    handled.current = target.sequence;
    setView((current) => ({
      ...current,
      scope: target.turnId ? 'turn' : current.scope === 'git' ? 'all' : current.scope,
      ...(target.turnId ? { turnId: target.turnId } : {}),
      ...(target.path ? { path: target.path } : {}),
    }));
    setSelection(undefined);
  }, [setView, target]);

  const latestTurn = derived.turns.at(-1);
  const turnId = view.turnId && derived.turns.some((turn) => turn.turnId === view.turnId) ? view.turnId : latestTurn?.turnId;
  const selectedTurn = derived.turns.find((turn) => turn.turnId === turnId);
  const entries = useMemo(() => {
    if (view.scope === 'git') return gitEntries(git.diff);
    const changes = view.scope === 'all' ? derived.changes : derived.changes.filter((change) => change.turnId === turnId);
    return groupRecords(changes);
  }, [derived.changes, git.diff, turnId, view.scope]);
  const selected = entries.find((entry) => view.path && samePath(entry.path, view.path)) ?? entries[0];
  const reviewed = new Set(view.reviewed);
  const display = (path: string): string => workspacePath(path, workspaceRoot);

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
    setInserted(false);
  };
  const draftText = formatReviewComments(view.comments, locale);
  const tooLong = draftText.length > REVIEW_DRAFT_LIMIT;
  const insert = (): void => {
    if (!insertIntoDraft || tooLong || !draftText) return;
    insertIntoDraft(draftText);
    setView((current) => ({ ...current, comments: [] }));
    setInserted(true);
  };
  useEffect(() => { if (composing) noteRef.current?.focus(); }, [composing]);
  const lineLabels = useMemo(() => ({
    showMore: copy.showMoreLines,
    line: (line: ReviewLine) => copy.patchLine(line.kind, line.after ?? line.before, line.text),
  }), [copy]);

  const scopeValue = view.scope;
  const pendingEarlier = view.scope === 'all' && transcriptFloor > 0 && backfill.phase !== 'done';

  return (
    <div className="results-changes" data-testid="results-changes">
      <div className="results-toolbar">
        <label className="results-visually-hidden" htmlFor={scopeId}>{copy.scope}</label>
        <Select id={scopeId} aria-label={copy.scope} value={scopeValue === 'turn' && turnId ? `turn:${turnId}` : scopeValue}
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
          {workspaceRoot && services.getGitDiff && <option value="git">{copy.scopeGit}</option>}
        </Select>
        {view.scope === 'git' && (
          <IconButton size="sm" icon={RefreshCw} aria-label={copy.refresh} onClick={refreshGit} disabled={git.phase === 'loading'} />
        )}
      </div>
      <p className="results-note">
        {view.scope === 'git' ? copy.gitNotice : copy.reportedNotice}
        {view.scope === 'git' && git.at && <> · {copy.refreshedAt(formatClock(new Date(git.at).toISOString(), locale))}</>}
        {view.scope === 'git' && git.status?.availability === 'ready' && git.status.branch && <> · {copy.branch(git.status.branch)}</>}
      </p>
      {view.scope === 'turn' && selectedTurn && view.turnId && view.turnId !== latestTurn?.turnId && selectedTurn.createdAt && (
        <p className="results-note">{copy.scopeSelectedTurn(formatClock(selectedTurn.createdAt, locale))}</p>
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
      {view.scope === 'git' && git.phase === 'loading' && !git.diff && <LoadingState label={copy.gitLoading} />}
      {view.scope === 'git' && git.phase === 'error' && <Status variant="danger">{copy.gitUnavailable}</Status>}
      {view.scope === 'git' && git.diff && !git.diff.ok && (
        <Status variant={git.diff.error === 'not-a-repository' ? 'neutral' : 'danger'}>{git.diff.error === 'not-a-repository' ? copy.gitNotRepository : copy.gitUnavailable}</Status>
      )}
      {view.scope === 'git' && git.diff?.ok && git.diff.truncated && <Status variant="warning">{copy.gitTruncated}</Status>}
      {view.scope === 'git' && git.diff?.ok && git.diff.omissions.length > 0 && <Status variant="neutral">{copy.gitOmitted(git.diff.omissions.length)}</Status>}

      {entries.length === 0 ? (
        view.scope === 'git'
          ? (git.diff?.ok && <EmptyState title={copy.gitClean} />)
          : derived.changes.length === 0
            ? <EmptyState title={copy.noChanges} description={copy.noChangesHint} />
            : <p className="results-note">{copy.noTurnChanges}</p>
      ) : (
        <>
          <ul className="results-file-list" aria-label={copy.fileList}>
            {entries.map((entry) => {
              const Icon = KIND_ICON[entry.kind];
              const done = entry.records.every((record) => reviewed.has(record.id));
              return (
                <li key={entry.key}>
                  <button type="button" className="results-file" aria-pressed={selected?.key === entry.key} onClick={() => choose(entry.path)} data-kind={entry.kind}>
                    <Icon className="results-file__icon" aria-hidden="true" />
                    <span className="results-file__path" title={display(entry.path)}>{display(entry.path)}</span>
                    {entry.kind !== 'update' && <span className="results-file__kind">{entry.kind === 'add' ? copy.created : entry.kind === 'delete' ? copy.deleted : copy.renamed}</span>}
                    <span className="results-file__counts">
                      {entry.added > 0 && <span className="results-added">+{entry.added}</span>}
                      {entry.removed > 0 && <span className="results-removed">−{entry.removed}</span>}
                    </span>
                    {done && view.scope !== 'git' && <span className="results-file__reviewed">{copy.reviewed}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {selected && (
            <section className="results-diff" aria-label={display(selected.path)}>
              <header className="results-diff__header">
                <span className="results-diff__path" title={display(selected.path)}>{display(selected.path)}</span>
                <span className="results-diff__actions">
                  {onViewFile && selected.kind !== 'delete' && (
                    <Button variant="ghost" size="sm" onClick={() => onViewFile(view.scope === 'git' ? resolveWorkspacePath(selected.path, workspaceRoot) ?? selected.path : selected.path)}>{copy.viewFile}</Button>
                  )}
                  {view.scope !== 'git' && (
                    <Button variant="ghost" size="sm" onClick={() => toggleReviewed(selected)}>
                      {selected.records.every((record) => reviewed.has(record.id)) ? copy.markUnread : copy.markReviewed}
                    </Button>
                  )}
                </span>
              </header>
              <p className="results-note">{selected.records.some((record) => record.change.coverage === 'fragment') ? copy.fragmentNote : copy.patchNote}</p>
              {selected.records.map((record, index) => {
                const commented = new Set<number>();
                for (const comment of view.comments) {
                  if (comment.recordId !== record.id || comment.start === undefined || comment.end === undefined) continue;
                  for (let line = comment.start; line <= comment.end; line += 1) commented.add(line);
                }
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

      {(view.comments.length > 0 || inserted) && (
        <section className="results-tray" aria-label={copy.comments(view.comments.length)}>
          {view.comments.length > 0 && (
            <>
              <ul className="results-tray__list">
                {view.comments.map((comment) => (
                  <li key={comment.id} className="results-tray__item">
                    <span className="results-tray__where">{comment.lines ? `${comment.path}:${comment.lines}` : comment.path}</span>
                    {comment.text && <span className="results-tray__text">{comment.text}</span>}
                    <IconButton size="sm" icon={X} aria-label={copy.removeComment}
                      onClick={() => setView((current) => ({ ...current, comments: current.comments.filter((entry) => entry.id !== comment.id) }))} />
                  </li>
                ))}
              </ul>
              <div className="results-tray__footer">
                <Button variant="primary" size="sm" disabled={!insertIntoDraft || tooLong} onClick={insert} title={copy.insertDraftHint}>
                  {copy.insertDraft} · {copy.comments(view.comments.length)}
                </Button>
                <span className="results-note">
                  {tooLong ? copy.tooLong : !insertIntoDraft ? (draftUnavailable === 'history' ? copy.draftHistory : copy.draftDisabled) : copy.insertDraftHint}
                </span>
              </div>
            </>
          )}
          {inserted && view.comments.length === 0 && <p className="results-note" role="status">{copy.insertedDraft}</p>}
        </section>
      )}
    </div>
  );
}
