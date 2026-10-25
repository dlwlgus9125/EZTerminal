import { FolderX } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { CleanedFolderEntry, RunCleanupOutcome, RunCleanupPlan, RunFolderKeepCode, RunFolderPlan, RunRetentionAccess } from '../../shared/run-retention';
import { Badge, Button, Dialog, LoadingState } from '../ui';
import type { WorkflowCopy } from './workflow-copy';

/** Why a folder stays, in the person's language (the host's own English when the code is unknown). */
export function runFolderKeepText(code: RunFolderKeepCode | undefined, reason: string | undefined, text: WorkflowCopy): string {
  const words: Record<RunFolderKeepCode, [string, string]> = {
    'head-moved': ['이 실행이 남긴 커밋에서 바뀌었습니다.', 'It moved from the commit this run left.'],
    'git-in-progress': ['진행 중인 Git 작업(병합·리베이스 등)이 있습니다.', 'Git work (a merge, a rebase…) is in progress there.'],
    sparse: ['일부만 체크아웃된 폴더입니다.', 'It is a sparse checkout.'],
    'unchecked-entries': ['Git이 변경을 확인하지 않도록 설정된 파일이 있습니다.', 'Some files are set so that Git does not check them.'],
    submodule: ['하위 모듈이 있습니다.', 'It has a submodule.'],
    'nested-repository': ['그 안에 따로 만든 Git 저장소가 있습니다.', 'It holds a Git repository of its own.'],
    untracked: ['Git이 보관하지 않는 파일이 있습니다(무시된 파일 포함).', 'It has files Git does not keep (ignored ones included).'],
    changed: ['Git에 넣지 않은 변경이 있습니다.', 'It has changes not added to Git.'],
    'staged-differs': ['올려 둔 파일이 이 실행의 결과와 다릅니다.', 'Its staged files differ from this run’s result.'],
    lfs: ['Git LFS를 씁니다.', 'It uses Git LFS.'],
    filter: ['Git이 일부 파일에 필터 프로그램을 실행합니다.', 'Git runs a filter program on some of its files.'],
    unchecked: ['확인하지 못했습니다.', 'It could not be checked.'],
    'not-ezterminal': ['EZTerminal이 이 프로젝트에 만든 작업 폴더가 아닙니다.', 'It is not a work folder EZTerminal created for this project.'],
    locked: ['Git에서 잠겨 있습니다.', 'It is locked in Git.'],
    'project-inside': ['그 안에 프로젝트가 등록되어 있습니다.', 'A project is registered in it.'],
    shared: ['다른 대화·작업 공간·프로젝트도 이 폴더를 씁니다.', 'Another conversation, workspace or project uses it.'],
    'no-record': ['비교할 결과 기록이 없습니다.', 'It has no result record to check it against.'],
    'result-mismatch': ['보관된 결과가 기록과 다릅니다.', 'Its kept result does not match its record.'],
    busy: ['아직 그 폴더에서 무언가 실행 중입니다. 멈춘 뒤 다시 정리하세요.', 'Something still runs there. Stop it and clean up again.'],
    'in-use': ['세션이 그 폴더를 쓰고 있습니다.', 'A session is using that folder.'],
    held: ['다른 프로그램이 그 폴더를 쓰고 있습니다. 닫은 뒤 다시 정리하세요.', 'A program still uses that folder. Close it and clean up again.'],
    'run-changed': ['실행이나 결과 기록이 바뀌었습니다.', 'Its run or result record changed.'],
    failed: ['정리하지 못했습니다.', 'It could not be cleaned up.'],
  };
  const known = code ? words[code] : undefined;
  return known ? text(known[0], known[1]) : reason ?? text('남겼습니다.', 'It was kept.');
}

/**
 * 작업 폴더 정리 (I2-7): the work folders of this flow's older finished runs. Only folders that hold nothing of the
 * person's are offered (a file Git does not keep, ignored ones included, keeps a folder, with why); the person removes
 * them in one go. Results, changes and stage conversations stay readable afterwards.
 */
export function RunFolderCleanupDialog({ open, onOpenChange, projectId, subprojectId, access, text, onCleaned }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: string;
  readonly subprojectId: string;
  readonly access: RunRetentionAccess;
  readonly text: WorkflowCopy;
  /** After a cleanup removed folders (the flow screen marks those runs). */
  readonly onCleaned?: (cleaned: readonly CleanedFolderEntry[]) => void;
}): JSX.Element {
  const [plan, setPlan] = useState<RunCleanupPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RunCleanupOutcome | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!open) { setPlan(null); setOutcome(null); setError(null); return; }
    let alive = true;
    void access.plan(projectId).then(result => {
      if (!alive) return;
      if (result.ok) { setPlan(result.value); setError(null); } else setError(result.message);
    });
    return () => { alive = false; };
  }, [open, access, projectId, generation]);
  const runs = plan?.runs.filter(run => run.subprojectId === subprojectId) ?? [];
  const removable = runs.flatMap(run => run.folders.filter(folder => folder.state === 'removable'));
  // A run whose folders are all gone (or had none) can still let its planning baseline go (기획 기준본 정리).
  const baselines = runs.filter(run => run.baseline).length;
  const clean = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const result = await access.cleanup(projectId, runs.filter(run => run.baseline || run.folders.some(folder => folder.state === 'removable')).map(run => run.runId));
      if (!result.ok) { setError(result.message); return; }
      // The outcome shows with the list read again, so the two never disagree.
      const next = await access.plan(projectId);
      setOutcome(result.value);
      if (next.ok) { setPlan(next.value); onCleaned?.(next.value.cleaned); }
    } finally { setBusy(false); }
  };
  const kind = (value: RunFolderPlan['kind']) => (value === 'attempt' ? text('단계 작업 폴더', 'Stage work folder')
    : value === 'validation' ? text('검증 폴더', 'Validation folder') : text('통합 폴더', 'Integration folder'));
  return <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }} dismissible={!busy} size="lg" icon={<FolderX aria-hidden="true" />}
    title={text('작업 폴더 정리', 'Clean up work folders')} closeLabel={text('닫기', 'Close')}
    description={text('흐름마다 최근 실행 3개의 작업 폴더는 남깁니다. 그보다 오래된 끝난 실행의 폴더 중 Git이 보관하지 않는 파일(무시된 파일 포함)이 없는 것만 정리하고, 폴더가 모두 정리된 실행이 만든 기획 기준본도 지웁니다. 결과·변경·단계 대화는 정리 뒤에도 그대로 볼 수 있습니다.',
      'Each flow keeps the work folders of its newest 3 runs. Of older finished runs, only folders holding no file Git does not keep (ignored ones included) are cleaned up, and the planning baselines of runs whose folders are all gone go too. Results, changes and stage conversations stay readable afterwards.')}
    footer={<><Button disabled={busy} onClick={() => onOpenChange(false)} data-testid="run-folder-cleanup-close">{text('닫기', 'Close')}</Button>
      <Button variant="primary" disabled={busy || (removable.length === 0 && baselines === 0)} onClick={() => void clean()} data-testid="run-folder-cleanup-confirm">
        {busy ? text('정리하는 중…', 'Cleaning up…') : removable.length === 0 && baselines > 0 ? text(`기획 기준본 ${baselines}개 정리`, `Clean up ${baselines} planning baseline${baselines === 1 ? '' : 's'}`)
          : text(`폴더 ${removable.length}개 정리`, `Clean up ${removable.length} folder${removable.length === 1 ? '' : 's'}`)}</Button></>}>
    <div className="workflow-folder-cleanup" data-testid="run-folder-cleanup">
      {error && <p role="alert" className="workflow-error">{error} <Button size="sm" variant="ghost" onClick={() => setGeneration(value => value + 1)}>{text('다시 확인', 'Check again')}</Button></p>}
      {outcome && <p role="status">{text(`폴더 ${outcome.removed}개를 정리했습니다.`, `Cleaned up ${outcome.removed} folder${outcome.removed === 1 ? '' : 's'}.`)}
        {!!outcome.baselinesRemoved && text(` 기획 기준본 ${outcome.baselinesRemoved}개도 정리했습니다.`, ` ${outcome.baselinesRemoved} planning baseline${outcome.baselinesRemoved === 1 ? '' : 's'} too.`)}
        {!!outcome.baselinesKept && text(` 기획 기준본 ${outcome.baselinesKept}개는 남겼습니다(다른 기획 내용이 참조하게 됐거나 저장하지 못함${outcome.baselineError ? `: ${outcome.baselineError}` : ''}).`,
          ` ${outcome.baselinesKept} planning baseline${outcome.baselinesKept === 1 ? '' : 's'} stayed (something came to refer to it, or it could not be written${outcome.baselineError ? `: ${outcome.baselineError}` : ''}).`)}
        {outcome.kept.length > 0 && text(` ${outcome.kept.length}개는 남겼습니다(아래 이유).`, ` ${outcome.kept.length} stayed (see why below).`)}</p>}
      {/* A folder the cleanup just kept may be gone from the list read again (its run became busy): its reason still shows. */}
      {outcome && outcome.kept.some(entry => entry.path && !runs.some(run => run.folders.some(folder => folder.path === entry.path))) && <ul className="workflow-folder-cleanup__runs">
        <li><strong>{text('이번에 남긴 폴더', 'Kept this time')}</strong><ul>{outcome.kept.filter(entry => entry.path && !runs.some(run => run.folders.some(folder => folder.path === entry.path))).map(entry =>
          <li key={entry.path} data-state="kept"><span><code>{entry.path}</code></span><Badge variant="warning">{text('남김', 'Kept')}</Badge> <small>{runFolderKeepText(entry.code, entry.reason, text)}</small></li>)}</ul></li>
      </ul>}
      {!plan && !error ? <LoadingState label={text('작업 폴더 확인 중', 'Checking work folders')} />
        : runs.length === 0 ? <p>{text('정리할 작업 폴더가 없습니다.', 'There are no work folders to clean up.')}</p>
          : <ul className="workflow-folder-cleanup__runs">{runs.map(run => <li key={run.runId}>
            <strong>{text(`실행 #${run.runNumber}`, `Run #${run.runNumber}`)}</strong>
            {run.why === 'launch-leftover' && <Badge>{text('시작하지 못한 실행', 'Run that never started')}</Badge>}
            {run.baseline && <small data-testid="run-folder-cleanup-baseline">{text('이 실행이 만든 기획 기준본도 정리할 수 있습니다.', 'The planning baseline this run made can go too.')}</small>}
            <ul>{run.folders.map(listed => {
              // What the cleanup just reported for a folder wins over the list read again (a busy chat is not in the plan).
              const stayed = outcome?.kept.find(entry => entry.path === listed.path);
              const folder = stayed && listed.state !== 'removed' ? { ...listed, state: 'kept' as const, code: stayed.code, reason: stayed.reason } : listed;
              return <li key={folder.path} data-state={folder.state}>
                <span>{kind(folder.kind)} · <code>{folder.path}</code></span>
                {folder.state === 'removable' ? <Badge variant="success">{text('정리할 수 있음', 'Can be cleaned up')}</Badge>
                  : folder.state === 'removed' ? <Badge>{text('정리됨', 'Cleaned up')}</Badge>
                    : <><Badge variant="warning">{text('남김', 'Kept')}</Badge> <small>{runFolderKeepText(folder.code, folder.reason, text)}</small></>}
              </li>;
            })}</ul>
          </li>)}</ul>}
    </div>
  </Dialog>;
}
