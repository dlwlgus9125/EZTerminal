import { Glyph } from '../ui/Glyph';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DaemonSnapshot } from '../../shared/daemon-protocol';
import type { GitDiffResult } from '../../shared/git-status';
import {
  isRunOwnedWorkspace,
  worktreeCleanupSummary,
  type WorkspaceWorktreeAccess,
  type WorkspaceWorktreeStatusView,
} from '../../shared/workspace-worktree';
import { useAppTranslation } from '../i18n';
import { Button, Dialog, EmptyState, ErrorState, LoadingState, Led, type LedTone } from '../ui';
import { useLiveTerminalSessions, withLiveTerminalSessions } from '../use-live-terminal-sessions';
import { WorktreeMergeDialog } from '../WorktreeDialogs';
import type { ProjectRef } from './ProjectDialogHost';
import { useShellText } from './shell-text';
import './project-dialogs.css';

/** A worktree the person works in (a flow run's own worktrees are the run's, not listed). */
export interface ProjectWorktree {
  readonly workspaceId: string;
  readonly name: string;
  readonly rootPath: string;
  /** A conversation there has a turn going, queued or waiting. */
  readonly working: boolean;
}

const BUSY = new Set(['starting', 'working', 'blocked', 'queued']);

export function projectWorktrees(snapshot: DaemonSnapshot | null, projectId: string): ProjectWorktree[] {
  if (!snapshot) return [];
  const busy = new Set(snapshot.agents.filter((agent) => BUSY.has(agent.state)).map((agent) => agent.sessionId));
  return snapshot.workspaces
    .filter((workspace) => workspace.projectId === projectId && workspace.kind === 'worktree' && !workspace.archivedAt && !isRunOwnedWorkspace(workspace.id))
    .map((workspace) => ({
      workspaceId: workspace.id,
      name: workspace.name,
      rootPath: workspace.rootPath,
      working: snapshot.sessions.some((session) => session.workspaceId === workspace.id && busy.has(session.id)),
    }));
}

type WorktreeState = 'working' | 'review' | 'done' | 'clean';
const LAMP: Record<WorktreeState, LedTone> = { working: 'on', review: 'amber', done: 'ok', clean: 'idle' };

/** This project's worktrees: where each stands, merging one home, or making a new one. */
export function WorktreesDialog({ project, snapshot, worktrees, reloadKey, onClose, onNew, onMerge }: {
  readonly project: ProjectRef;
  readonly snapshot: DaemonSnapshot | null;
  readonly worktrees: Pick<WorkspaceWorktreeAccess, 'status'>;
  /** Changes when the list is returned to (after a merge or cleanup): git is read again. */
  readonly reloadKey: number;
  readonly onClose: () => void;
  readonly onNew: () => void;
  readonly onMerge: (worktree: ProjectWorktree) => void;
}): JSX.Element {
  const { text } = useShellText();
  const rows = useMemo(() => projectWorktrees(snapshot, project.projectId), [snapshot, project.projectId]);
  const [statuses, setStatuses] = useState<Readonly<Record<string, WorkspaceWorktreeStatusView>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    void worktrees.status(project.projectId)
      .then((result) => {
        if (!alive) return;
        if (!result.ok) { setError(result.message); return; }
        setStatuses(Object.fromEntries(result.value.map((status) => [status.workspaceId, status])));
      })
      .catch((reason: unknown) => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, [worktrees, project.projectId, reloadKey, revision]);

  const label: Record<WorktreeState, string> = {
    working: text('작업 중', 'In progress'),
    review: text('검토 대기', 'Ready to review'),
    done: text('완료', 'Done'),
    clean: text('변경 없음', 'No changes'),
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={text(`워크트리 · ${project.name}`, `Worktrees · ${project.name}`)}
      description={text('브랜치마다 따로 연 작업 폴더입니다. 끝난 작업을 병합하고 정리합니다.', 'A folder of its own for each branch. Merge finished work home, then clean up.')}
      icon={<Glyph name="wt" />}
      closeLabel={text('닫기', 'Close')}
      size="lg"
      className="ez-project-dialog"
      testId="worktrees-dialog"
      footer={(
        <Button variant="primary" leadingIcon={<Glyph name="wt" />} onClick={onNew} data-testid="worktrees-new">
          {text('새 워크트리…', 'New worktree…')}
        </Button>
      )}
    >
      <div className="ez-project-list">
        {error && (
          <ErrorState
            title={text('워크트리 상태를 읽지 못했습니다.', 'The worktree status could not be read.')}
            description={error}
            action={<Button size="sm" onClick={() => setRevision((value) => value + 1)}>{text('다시 시도', 'Retry')}</Button>}
          />
        )}
        {rows.length === 0 && !error && (
          <EmptyState
            title={text('이 프로젝트에 워크트리가 없습니다.', 'This project has no worktrees.')}
            description={text('새 워크트리를 만들면 그 브랜치에서 새 대화가 열립니다.', 'A new worktree opens a conversation on its branch.')}
          />
        )}
        {rows.length > 0 && statuses === null && !error && <LoadingState label={text('워크트리 상태를 읽는 중…', 'Reading the worktrees…')} />}
        {rows.length > 0 && statuses !== null && (
          <ul className="ez-project-list__rows" aria-label={text('워크트리', 'Worktrees')}>
            {rows.map((row) => {
              const status = statuses[row.workspaceId];
              const state: WorktreeState = row.working ? 'working' : status?.status ?? 'clean';
              const name = status?.branch ?? row.name;
              const facts = status ? [
                status.ahead > 0 ? text(`앞선 커밋 ${status.ahead}`, `${status.ahead} commits ahead`) : '',
                status.dirty ? text('커밋 안 된 변경 있음', 'Uncommitted changes') : '',
              ].filter(Boolean).join(' · ') : '';
              return (
                <li key={row.workspaceId} className="ez-project-list__row" data-testid="worktree-row" data-workspace={row.workspaceId} data-state={state}>
                  <div className="ez-project-list__open" title={row.rootPath}>
                    <span className="ez-project-list__name"><Led tone={LAMP[state]} />{name}</span>
                    <span className="ez-project-list__meta">{label[state]}{facts ? ` · ${facts}` : ''}</span>
                  </div>
                  <Button
                    size="sm"
                    leadingIcon={<Glyph name="merge" />}
                    aria-label={`${text('병합', 'Merge')}: ${name}`}
                    onClick={() => onMerge(row)}
                    data-testid="workspace-merge"
                  >
                    {text('병합…', 'Merge…')}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/** The existing merge dialog for one worktree: commit, merge into the base branch, clean up. */
export function WorktreeMergeStep({ project, worktree, snapshot, worktrees, terminals, onClose, onReview }: {
  readonly project: ProjectRef;
  readonly worktree: ProjectWorktree;
  readonly snapshot: DaemonSnapshot | null;
  readonly worktrees: WorkspaceWorktreeAccess;
  /** Which terminals still run (a terminal's record outlives its process). */
  readonly terminals?: Parameters<typeof useLiveTerminalSessions>[0];
  readonly onClose: () => void;
  /** 변경 검토: absent where the changes cannot be read. */
  readonly onReview?: () => void;
}): JSX.Element {
  const [status, setStatus] = useState<WorkspaceWorktreeStatusView>();
  const live = useLiveTerminalSessions(terminals);
  const effective = useMemo(() => withLiveTerminalSessions(snapshot, live), [snapshot, live]);
  const refresh = useCallback(async (): Promise<void> => {
    const result = await worktrees.status(project.projectId).catch(() => null);
    if (result?.ok) setStatus(result.value.find((candidate) => candidate.workspaceId === worktree.workspaceId));
  }, [worktrees, project.projectId, worktree.workspaceId]);
  return (
    <WorktreeMergeDialog
      open
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={worktree.name}
      {...(status ? { status } : {})}
      onRefresh={refresh}
      {...(onReview ? { onReview } : {})}
      onCommit={(message) => worktrees.commit(worktree.workspaceId, message)}
      onMerge={() => worktrees.merge(worktree.workspaceId)}
      cleanup={{ ...worktreeCleanupSummary(effective, worktree.workspaceId), run: () => worktrees.remove(worktree.workspaceId) }}
    />
  );
}

/** A worktree's uncommitted and committed changes as git shows them (the merge dialog's 변경 검토). */
export function WorktreeDiffDialog({ worktree, loadDiff, onClose }: {
  readonly worktree: ProjectWorktree;
  readonly loadDiff: (directory: string) => Promise<GitDiffResult>;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [result, setResult] = useState<GitDiffResult | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    void loadDiff(worktree.rootPath)
      .catch((): GitDiffResult => ({ ok: false, error: 'git-failed' }))
      .then((value) => { if (current === generation.current) setResult(value); });
  }, [loadDiff, worktree.rootPath]);
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }} title={`${t('agentHub.diffTitle')} · ${worktree.name}`} size="lg"
      closeLabel={t('agentHub.diffClose')} testId="worktree-diff-dialog">
      {result === null && <p className="agent-diff-note">{t('agentHub.diffTitle')}…</p>}
      {result && !result.ok && (
        <p className="agent-diff-note" role="alert">{result.error === 'not-a-repository' ? t('agentHub.diffUnavailable') : t('agentHub.approvalFailed')}</p>
      )}
      {result?.ok && (
        <>
          {result.text.trim().length > 0 && <pre className="agent-diff">{result.text}</pre>}
          {result.text.trim().length === 0 && !result.truncated && result.omissions.length === 0 && <p className="agent-diff-note">{t('agentHub.diffEmpty')}</p>}
          {result.truncated && <p className="agent-diff-note" role="status">{t('agentHub.diffTruncated')}</p>}
          {result.omissions.length > 0 && (
            <ul className="agent-diff-omissions">
              {result.omissions.map((omission) => (
                <li key={`${omission.path}\0${omission.reason}`}><code>{omission.path}</code> — {t(`agentHub.diffOmissionReason.${omission.reason}`)}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </Dialog>
  );
}
