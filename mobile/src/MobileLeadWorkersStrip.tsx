import { Archive, ChevronUp, CircleStop, GitMerge, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  EMPTY_AGENT_ACTIVITY_SNAPSHOT,
  type AgentActivitySnapshot,
  type AgentDecision,
  type AgentDecisionResult,
} from '../../src/shared/agent';
import {
  isTerminalCollaborationRun,
  isTerminalCollaborationTask,
  type AgentOrchestrationSnapshot,
  type CollaborationRun,
  type CollaborationTask,
} from '../../src/shared/agent-orchestration';
import { useAppTranslation } from '../../src/renderer/i18n';
import { MobileActionSheet } from './MobileActionSheet';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

function visibleRun(snapshot: AgentOrchestrationSnapshot, leadSessionId: string): CollaborationRun | null {
  const runs = snapshot.runs
    .filter((run) => (
      run.leadSessionId === leadSessionId
      && run.tasks.some((task) => task.archivedAt === undefined)
    ))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return runs.find((run) => !isTerminalCollaborationRun(run.state)) ?? runs[0] ?? null;
}

function needsAttention(task: CollaborationTask): boolean {
  return task.state === 'blocked' || task.state === 'failed' || task.state === 'stale';
}

export function MobileLeadWorkersStrip({
  snapshot,
  activitySnapshot = EMPTY_AGENT_ACTIVITY_SNAPSHOT,
  leadSessionId,
  transport,
  connected,
}: {
  readonly snapshot: AgentOrchestrationSnapshot;
  readonly activitySnapshot?: AgentActivitySnapshot;
  readonly leadSessionId: string;
  readonly transport: WsEzTerminalTransport;
  readonly connected: boolean;
}): JSX.Element | null {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const run = useMemo(
    () => visibleRun(snapshot, leadSessionId),
    [leadSessionId, snapshot],
  );
  const tasks = useMemo(
    () => run?.tasks.filter((task) => task.archivedAt === undefined) ?? [],
    [run],
  );
  const approvalsByActivity = useMemo(() => new Map(activitySnapshot.items.flatMap((activity) => (
    activity.approval ? [[activity.id, activity.approval] as const] : []
  ))), [activitySnapshot.items]);

  useEffect(() => {
    if (!run) setOpen(false);
  }, [run]);

  if (!run) return null;

  const active = tasks.filter((task) => (
    !isTerminalCollaborationTask(task.state) && task.state !== 'awaiting-merge'
  )).length;
  const attention = tasks.filter(needsAttention).length;
  const mergeReady = tasks.filter((task) => task.state === 'awaiting-merge').length;

  const actOnTask = async (task: CollaborationTask): Promise<void> => {
    if (busyId !== null || !connected) return;
    setBusyId(task.taskId);
    setMessage(null);
    const terminal = isTerminalCollaborationTask(task.state) || task.state === 'awaiting-merge';
    const result = await (terminal
      ? transport.archiveOrchestrationWorker(run.runId, task.taskId)
      : transport.cancelOrchestrationWorker(run.runId, task.taskId))
      .catch(() => ({
        ok: false as const,
        error: 'unavailable' as const,
        message: t('leadWorkers.actionFailed'),
      }));
    if (!result.ok) setMessage(result.message);
    setBusyId(null);
  };

  const stopRun = async (): Promise<void> => {
    if (busyId !== null || !connected) return;
    setBusyId(run.runId);
    setMessage(null);
    const result = await transport.stopOrchestrationRun(run.runId).catch(() => ({
      ok: false as const,
      error: 'unavailable' as const,
      message: t('leadWorkers.actionFailed'),
    }));
    if (!result.ok) setMessage(result.message);
    setBusyId(null);
  };

  const decideApproval = async (
    task: CollaborationTask,
    approvalId: string,
    decision: AgentDecision,
  ): Promise<void> => {
    const activityId = task.worker?.activityId;
    if (!activityId || busyId !== null || !connected) return;
    setBusyId(`approval:${approvalId}`);
    setMessage(null);
    const result = await transport.decideAgentApproval(activityId, approvalId, decision)
      .catch((): AgentDecisionResult => ({ ok: false, error: 'outcome-unknown' }));
    if (!result.ok) setMessage(t('agentHub.approvalFailed'));
    setBusyId(null);
  };

  return (
    <aside className="mobile-lead-workers" data-testid="mobile-lead-workers">
      <button
        ref={(element) => {
          returnFocusRef.current = element;
        }}
        type="button"
        className="mobile-lead-workers__summary"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <LoaderCircle className={active > 0 ? 'mobile-lead-workers__spin' : undefined} aria-hidden="true" />
        <strong>{t('leadWorkers.summary', { active, total: tasks.length })}</strong>
        {attention > 0 && (
          <span className="mobile-lead-workers__count mobile-lead-workers__count--warning">
            <TriangleAlert aria-hidden="true" /> {attention}
          </span>
        )}
        {mergeReady > 0 && (
          <span className="mobile-lead-workers__count mobile-lead-workers__count--success">
            <GitMerge aria-hidden="true" /> {mergeReady}
          </span>
        )}
        <ChevronUp aria-hidden="true" />
      </button>

      {open && (
        <MobileActionSheet
          title={t('leadWorkers.title')}
          description={t('leadWorkers.summary', { active, total: tasks.length })}
          onClose={() => setOpen(false)}
          returnFocusRef={returnFocusRef}
          focusKey={`${run.runId}:${run.revision}`}
          testId="mobile-lead-workers-sheet"
        >
          {tasks.map((task) => {
            const terminal = isTerminalCollaborationTask(task.state) || task.state === 'awaiting-merge';
            const approval = task.worker?.activityId
              ? approvalsByActivity.get(task.worker.activityId)
              : undefined;
            return (
              <div
                className="mobile-lead-worker-row"
                key={task.taskId}
                data-state={task.state}
              >
                <span className="mobile-lead-worker-row__copy">
                  <strong>{task.title}</strong>
                  <small>
                    {t(`leadWorkers.state.${task.state}`)}
                    {task.writeScopes.length > 0 ? ` · ${task.writeScopes.join(', ')}` : ''}
                  </small>
                  {(task.result?.summary || task.error) && <span>{task.result?.summary ?? task.error}</span>}
                </span>
                <button
                  type="button"
                  className={terminal ? 'mob-icon-btn' : 'mob-icon-btn mobile-lead-worker-row__stop'}
                  aria-label={terminal
                    ? t('leadWorkers.archiveName', { name: task.title })
                    : t('leadWorkers.stopName', { name: task.title })}
                  disabled={!connected || busyId !== null}
                  onClick={() => void actOnTask(task)}
                >
                  {terminal ? <Archive aria-hidden="true" /> : <CircleStop aria-hidden="true" />}
                </button>
                {approval?.pending && (
                  <div className="mobile-lead-worker-row__approval" data-testid="mobile-lead-worker-approval">
                    <code>{approval.command ?? approval.toolName}</code>
                    <span>
                      <button
                        type="button"
                        className="mob-btn-warning"
                        disabled={!connected || busyId !== null}
                        onClick={() => void decideApproval(task, approval.approvalId, 'allow')}
                      >
                        {t('agentHub.approve')}
                      </button>
                      <button
                        type="button"
                        className="mob-btn-ghost"
                        disabled={!connected || busyId !== null}
                        onClick={() => void decideApproval(task, approval.approvalId, 'deny')}
                      >
                        {t('agentHub.deny')}
                      </button>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
          {message && <p className="mobile-lead-workers__message" role="alert">{message}</p>}
          {!isTerminalCollaborationRun(run.state) && (
            <button
              type="button"
              className="mobile-action-sheet-row mobile-action-sheet-row--danger"
              disabled={!connected || busyId !== null}
              onClick={() => void stopRun()}
              data-testid="mobile-lead-workers-stop-all"
            >
              <span className="mobile-action-sheet-row-label">{t('leadWorkers.stopAll')}</span>
            </button>
          )}
        </MobileActionSheet>
      )}
    </aside>
  );
}
