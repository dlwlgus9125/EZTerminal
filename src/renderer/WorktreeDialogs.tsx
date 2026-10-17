import { GitBranch, GitMerge } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { WorkspaceWorktreeIpcResult, WorkspaceWorktreeStatusView } from '../shared/workspace-worktree';
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
      title={text('새 워크트리', 'New worktree')} icon={<GitBranch aria-hidden="true" />}
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
 * and merge its branch into the main checkout's branch. Each is a click.
 */
export function WorktreeMergeDialog({ open, onOpenChange, title, status, onRefresh, onReview, onCommit, onMerge }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly status?: WorkspaceWorktreeStatusView;
  readonly onRefresh: () => Promise<void>;
  readonly onReview?: () => void;
  readonly onCommit: (message: string) => Promise<WorkspaceWorktreeIpcResult<{ readonly commit: string }>>;
  readonly onMerge: () => Promise<WorkspaceWorktreeIpcResult<{ readonly into: string; readonly commit: string }>>;
}): JSX.Element {
  const text = useText();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'commit' | 'merge' | null>(null);
  const [error, setError] = useState<string>();
  const [merged, setMerged] = useState<string>();
  useEffect(() => { if (open) { setMessage(''); setError(undefined); setMerged(undefined); void onRefresh(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const branch = status?.branch ?? title;
  const base = status?.baseBranch ?? 'main';
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
      title={text(`${branch} 병합`, `Merge ${branch}`)} icon={<GitMerge aria-hidden="true" />}
      description={text(`${branch}의 작업을 ${base}로 합칩니다. ${base}에 병합 커밋이 하나 생깁니다.`, `Brings ${branch} into ${base} with one merge commit.`)}
      closeLabel={text('닫기', 'Close')} testId="worktree-merge-dialog"
      footer={<>
        <Button variant="secondary" disabled={busy !== null} onClick={() => onOpenChange(false)}>{merged ? text('닫기', 'Close') : text('취소', 'Cancel')}</Button>
        {!merged && <Button variant="primary" loading={busy === 'merge'} disabled={busy !== null || !status || status.dirty || status.ahead === 0}
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
