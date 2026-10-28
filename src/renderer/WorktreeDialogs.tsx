import { Glyph } from './ui/Glyph';
import { useEffect, useRef, useState } from 'react';

import type { RemovedWorkspaceWorktree, WorkspaceWorktreeIpcResult, WorkspaceWorktreeStatusView } from '../shared/workspace-worktree';
import { useAppTranslation } from './i18n';
import { Button, Dialog, Field, Input } from './ui';
import './worktree-dialogs.css';

const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/u;

function useText(): (korean: string, english: string) => string {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  return (korean, english) => (ko ? korean : english);
}

/** A new place to work: a branch in its own worktree, next to the project's checkout. */
export function NewWorktreeDialog({ open, onOpenChange, projectName, createLabel, onCreate }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectName: string;
  /** Defaults to "create and start a chat". */
  readonly createLabel?: string;
  readonly onCreate: (branch: string) => Promise<WorkspaceWorktreeIpcResult<{ readonly workspaceId: string }>>;
}): JSX.Element {
  const text = useText();
  const [branch, setBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { if (open) { setBranch(''); setError(undefined); } }, [open]);
  const invalid = branch.trim().length > 0 && !BRANCH.test(branch.trim());
  const create = async (): Promise<void> => {
    if (!branch.trim() || invalid || busy) return;
    setBusy(true);
    setError(undefined);
    const result = await onCreate(branch.trim());
    setBusy(false);
    if (result.ok) onOpenChange(false);
    else setError(result.message);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }} size="sm"
      title={text('새 워크트리', 'New worktree')} icon={<Glyph name="wt" />}
      description={text(`${projectName}의 새 브랜치를 따로 열어 작업합니다. 지금 작업 위치의 커밋되지 않은 변경은 옮겨지지 않습니다.`,
        `Work on a new ${projectName} branch in its own folder. Uncommitted changes in the current checkout stay where they are.`)}
      closeLabel={text('닫기', 'Close')} testId="new-worktree-dialog"
      footer={<>
        <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>{text('취소', 'Cancel')}</Button>
        <Button variant="primary" loading={busy} disabled={!branch.trim() || invalid} onClick={() => void create()} data-testid="new-worktree-create">{createLabel ?? text('만들고 새 대화', 'Create and start a chat')}</Button>
      </>}>
      <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <Field label={text('브랜치 이름', 'Branch name')} error={invalid ? text('영문·숫자와 . _ / - 만 쓸 수 있습니다.', 'Use letters, numbers and . _ / - only.') : error}>
          <Input value={branch} maxLength={200} placeholder="feature/login-review" autoFocus onChange={(event) => setBranch(event.currentTarget.value)} data-testid="new-worktree-branch" />
        </Field>
      </form>
    </Dialog>
  );
}

/**
 * Bring a worktree's work home: see what it holds, commit what is uncommitted,
 * and merge its branch into the main checkout's branch. Each is a click. Once
 * merged, the worktree can be cleaned up after a confirmation that says what goes.
 */
export function WorktreeMergeDialog({ open, onOpenChange, title, status, onRefresh, onReview, onCommit, onMerge, cleanup }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly status?: WorkspaceWorktreeStatusView;
  readonly onRefresh: () => Promise<void>;
  readonly onReview?: () => void;
  readonly onCommit: (message: string) => Promise<WorkspaceWorktreeIpcResult<{ readonly commit: string }>>;
  readonly onMerge: () => Promise<WorkspaceWorktreeIpcResult<{ readonly into: string; readonly commit: string }>>;
  /** Offered once the work is merged: the chats it archives and whether something still runs there. */
  readonly cleanup?: {
    readonly chats: number;
    readonly busy: boolean;
    readonly run: () => Promise<WorkspaceWorktreeIpcResult<RemovedWorkspaceWorktree>>;
  };
}): JSX.Element {
  const text = useText();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'commit' | 'merge' | 'cleanup' | null>(null);
  const [error, setError] = useState<string>();
  const [merged, setMerged] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [cleanedNotes, setCleanedNotes] = useState<readonly string[]>();
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) { setMessage(''); setError(undefined); setMerged(undefined); setConfirming(false); setCleanedNotes(undefined); void onRefresh(); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Asking to delete something puts focus on the way back, not on the delete.
  useEffect(() => { if (confirming) backRef.current?.focus(); }, [confirming]);
  const branch = status?.branch ?? title;
  const base = status?.baseBranch ?? 'main';
  const cleanable = Boolean(cleanup && status && !status.dirty && status.ahead === 0 && (merged || status.merged));
  const runCleanup = async (): Promise<void> => {
    if (!cleanup) return;
    setBusy('cleanup');
    setError(undefined);
    const result = await cleanup.run();
    setBusy(null);
    setConfirming(false);
    // Refusals the person can act on are said in their language; git's own failures stay as git wrote them.
    if (!result.ok && result.reason === 'in-use') {
      setError(text('이 워크트리를 아직 쓰는 것이 있어 정리하지 않았습니다(실행 중인 대화, 그곳에서 연 터미널이나 편집기). 멈추거나 닫은 뒤 다시 정리하세요. 다시 해도 안전합니다.',
        'Something is still using this worktree (a running chat, or a terminal or editor opened there), so nothing was cleaned up. Stop or close it, then clean up again; that is safe.'));
    } else if (!result.ok && (result.reason === 'not-merged' || result.reason === 'dirty-worktree')) {
      setError(text('병합되지 않았거나 커밋 안 된 변경이 있어 정리하지 않았습니다. 커밋하고 병합한 뒤 정리하세요.',
        'Not cleaned up: there is unmerged work or uncommitted changes. Commit and merge first.'));
    } else if (!result.ok) setError(result.message);
    else if (result.value.notes.length) setCleanedNotes(result.value.notes);
    else onOpenChange(false);
    await onRefresh();
  };
  if (cleanedNotes) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange} size="md" title={text(`${branch} 정리`, `Clean up ${branch}`)} icon={<Glyph name="trash" />}
        closeLabel={text('닫기', 'Close')} testId="worktree-merge-dialog"
        footer={<Button variant="secondary" onClick={() => onOpenChange(false)}>{text('닫기', 'Close')}</Button>}>
        <div className="worktree-merge">
          <p className="worktree-merge__done" role="status">{text('워크트리를 정리했습니다.', 'The worktree is cleaned up.')}</p>
          <ul className="worktree-merge__notes" data-testid="worktree-cleanup-notes">{cleanedNotes.map((note) => <li key={note}>{note}</li>)}</ul>
        </div>
      </Dialog>
    );
  }
  if (confirming && cleanup) {
    return (
      <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }} size="md" tone="danger" initialFocusRef={backRef}
        title={text(`${branch} 정리`, `Clean up ${branch}`)} icon={<Glyph name="trash" />}
        closeLabel={text('닫기', 'Close')} testId="worktree-merge-dialog"
        footer={<>
          <Button ref={backRef} variant="secondary" disabled={busy !== null} onClick={() => setConfirming(false)}>{text('돌아가기', 'Back')}</Button>
          <Button variant="danger" leadingIcon={<Glyph name="trash" />} loading={busy === 'cleanup'} disabled={busy !== null || cleanup.busy}
            onClick={() => void runCleanup()} data-testid="worktree-cleanup-confirm">{text('정리', 'Clean up')}</Button>
        </>}>
        <div className="worktree-merge">
          <ul className="worktree-merge__consequences" data-testid="worktree-cleanup-consequences">
            <li>{text('워크트리 폴더를 지웁니다.', 'Deletes the worktree folder.')}</li>
            <li>{text(`브랜치 ${branch}를 삭제합니다. 작업은 ${base}에 병합돼 있습니다.`, `Deletes the branch ${branch}; its work is merged into ${base}.`)}</li>
            {cleanup.chats > 0 && <li>{text(`이 위치의 대화 ${cleanup.chats}개를 보관합니다. 기록은 남지만 더 이어 갈 수 없습니다.`, `Archives the ${cleanup.chats} chat(s) here. Their history stays, but they cannot continue.`)}</li>}
          </ul>
          <p className="worktree-merge__warning">{text('되돌릴 수 없습니다.', 'This cannot be undone.')}</p>
          {cleanup.busy && <p className="worktree-merge__note" role="status">{text('이 위치에서 아직 실행 중인 대화나 터미널이 있습니다. 멈춘 뒤 정리하세요.', 'A chat or terminal is still running here. Stop it, then clean up.')}</p>}
        </div>
      </Dialog>
    );
  }
  const run = async <T,>(kind: 'commit' | 'merge', action: () => Promise<WorkspaceWorktreeIpcResult<T>>, done: (value: T) => void): Promise<void> => {
    setBusy(kind);
    setError(undefined);
    const result = await action();
    setBusy(null);
    if (result.ok) done(result.value);
    else setError(result.message);
    await onRefresh();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }} size="md"
      title={text(`${branch} 병합`, `Merge ${branch}`)} icon={<Glyph name="merge" />}
      description={text(`${branch}의 작업을 ${base}로 합칩니다. ${base}에 병합 커밋이 하나 생깁니다.`, `Brings ${branch} into ${base} with one merge commit.`)}
      closeLabel={text('닫기', 'Close')} testId="worktree-merge-dialog"
      footer={<>
        <Button variant="secondary" disabled={busy !== null} onClick={() => onOpenChange(false)}>{merged ? text('닫기', 'Close') : text('취소', 'Cancel')}</Button>
        {cleanable && <Button variant="secondary" leadingIcon={<Glyph name="trash" />} disabled={busy !== null}
          onClick={() => { setError(undefined); setConfirming(true); }} data-testid="worktree-cleanup">{text('워크트리 정리…', 'Clean up worktree…')}</Button>}
        {!merged && !cleanable && <Button variant="primary" loading={busy === 'merge'} disabled={busy !== null || !status || status.dirty || status.ahead === 0}
          onClick={() => void run('merge', onMerge, (value) => setMerged(value.into))} data-testid="worktree-merge-confirm">{text(`${base}로 병합`, `Merge into ${base}`)}</Button>}
      </>}>
      <div className="worktree-merge">
        <dl className="worktree-merge__facts">
          <div><dt>{text('보낼 커밋', 'Commits to merge')}</dt><dd data-testid="worktree-merge-ahead">{status ? String(status.ahead) : '…'}</dd></div>
          <div><dt>{text('커밋 안 된 변경', 'Uncommitted changes')}</dt><dd>{status ? status.dirty ? text('있음', 'Yes') : text('없음', 'None') : '…'}</dd></div>
        </dl>
        {onReview && <Button variant="ghost" size="sm" onClick={onReview}>{text('변경 검토 열기', 'Open change review')}</Button>}
        {status?.dirty && !merged && (
          <div className="worktree-merge__commit">
            <Field label={text('먼저 커밋할 메시지', 'Commit these changes first')}>
              <Input value={message} maxLength={2_000} placeholder={text('예: 로그인 오류 문구 정리', 'e.g. Tidy the login error copy')}
                onChange={(event) => setMessage(event.currentTarget.value)} data-testid="worktree-commit-message" />
            </Field>
            <Button variant="secondary" size="sm" loading={busy === 'commit'} disabled={busy !== null || !message.trim()}
              onClick={() => void run('commit', () => onCommit(message), () => setMessage(''))} data-testid="worktree-commit">{text('변경 커밋', 'Commit changes')}</Button>
          </div>
        )}
        {status && !status.dirty && status.ahead === 0 && !merged && (
          <p className="worktree-merge__note">{status.merged ? text(`이미 ${base}에 병합됐습니다.`, `Already merged into ${base}.`) : text('아직 병합할 커밋이 없습니다.', 'Nothing to merge yet.')}</p>
        )}
        {merged && <p className="worktree-merge__done" role="status">{text(`${branch}를 ${merged}에 병합했습니다.`, `Merged ${branch} into ${merged}.`)}</p>}
        {error && <p className="worktree-merge__error" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}
