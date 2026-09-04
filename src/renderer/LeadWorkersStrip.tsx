import { Archive, ChevronDown, ChevronUp, CircleStop, GitMerge, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { AgentApproval, AgentDecision, AgentDecisionResult } from '../shared/agent';
import {
  isTerminalCollaborationRun,
  isTerminalCollaborationTask,
  type AgentOrchestrationSnapshot,
  type CollaborationRun,
  type CollaborationTask,
} from '../shared/agent-orchestration';
import { useAppTranslation } from './i18n';
import { Badge, Button, IconButton } from './ui';

interface LeadWorkersStripProps {
  readonly snapshot: AgentOrchestrationSnapshot;
  readonly leadSessionId: string | null;
  readonly approvalsByActivity?: ReadonlyMap<string, AgentApproval>;
  readonly onDecideApproval?: (
    activityId: string,
    approvalId: string,
    decision: AgentDecision,
  ) => Promise<AgentDecisionResult>;
}

function visibleRun(snapshot: AgentOrchestrationSnapshot, leadSessionId: string): CollaborationRun | null {
  const runs = snapshot.runs
    .filter((run) => run.leadSessionId === leadSessionId && run.tasks.some((task) => task.archivedAt === undefined))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return runs.find((run) => !isTerminalCollaborationRun(run.state)) ?? runs[0] ?? null;
}

function taskTone(task: CollaborationTask): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  if (task.state === 'failed' || task.state === 'stale') return 'danger';
  if (task.state === 'blocked' || task.state === 'awaiting-verification') return 'warning';
  if (task.state === 'completed' || task.state === 'awaiting-merge') return 'success';
  if (task.state === 'working' || task.state === 'verifying' || task.state === 'starting') return 'info';
  return 'neutral';
}

export function LeadWorkersStrip({
  snapshot,
  leadSessionId,
  approvalsByActivity,
  onDecideApproval,
}: LeadWorkersStripProps): JSX.Element | null {
  const { t } = useAppTranslation();
  const [expanded, setExpanded] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = useMemo(
    () => leadSessionId ? visibleRun(snapshot, leadSessionId) : null,
    [leadSessionId, snapshot],
  );
  if (!run) return null;
  const tasks = run.tasks.filter((task) => task.archivedAt === undefined);
  const active = tasks.filter((task) => !isTerminalCollaborationTask(task.state)
    && task.state !== 'awaiting-merge').length;
  const attention = tasks.filter((task) => task.state === 'blocked' || task.state === 'failed' || task.state === 'stale').length;
  const mergeReady = tasks.filter((task) => task.state === 'awaiting-merge').length;

  const cancelTask = async (taskId: string): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || busyTaskId) return;
    setBusyTaskId(taskId);
    setMessage(null);
    const result = await desktop.cancelOrchestrationWorker(run.runId, taskId)
      .catch(() => ({ ok: false, error: 'unavailable', message: t('leadWorkers.actionFailed') } as const));
    if (!result.ok) setMessage(result.message);
    setBusyTaskId(null);
  };

  const archiveTask = async (taskId: string): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || busyTaskId) return;
    setBusyTaskId(taskId);
    setMessage(null);
    const result = await desktop.archiveOrchestrationWorker(run.runId, taskId)
      .catch(() => ({ ok: false, error: 'unavailable', message: t('leadWorkers.actionFailed') } as const));
    if (!result.ok) setMessage(result.message);
    setBusyTaskId(null);
  };

  const decideApproval = async (
    task: CollaborationTask,
    approval: AgentApproval,
    decision: AgentDecision,
  ): Promise<void> => {
    const activityId = task.worker?.activityId;
    if (!activityId || !onDecideApproval || busyTaskId) return;
    setBusyTaskId(`approval:${approval.approvalId}`);
    setMessage(null);
    const result = await onDecideApproval(activityId, approval.approvalId, decision)
      .catch((): AgentDecisionResult => ({ ok: false, error: 'outcome-unknown' }));
    if (!result.ok) setMessage(t('agentHub.approvalFailed'));
    setBusyTaskId(null);
  };

  const stopRun = async (): Promise<void> => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || busyTaskId) return;
    setBusyTaskId(run.runId);
    setMessage(null);
    const result = await desktop.stopOrchestrationRun(run.runId)
      .catch(() => ({ ok: false, error: 'unavailable', message: t('leadWorkers.actionFailed') } as const));
    if (!result.ok) setMessage(result.message);
    setBusyTaskId(null);
  };

  return (
    <aside className="lead-workers" data-testid="lead-workers" aria-label={t('leadWorkers.title')}>
      <div className="lead-workers__summary">
        <button
          type="button"
          className="lead-workers__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <LoaderCircle className={active > 0 ? 'lead-workers__spin' : undefined} aria-hidden="true" />
          <strong>{t('leadWorkers.summary', { active, total: tasks.length })}</strong>
          {attention > 0 && <Badge variant="warning"><TriangleAlert aria-hidden="true" /> {attention}</Badge>}
          {mergeReady > 0 && <Badge variant="success"><GitMerge aria-hidden="true" /> {mergeReady}</Badge>}
          {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </button>
        {!isTerminalCollaborationRun(run.state) && (
          <Button size="sm" variant="ghost" disabled={busyTaskId !== null} onClick={() => void stopRun()}>
            {t('leadWorkers.stopAll')}
          </Button>
        )}
      </div>
      {expanded && (
        <div className="lead-workers__details">
          {tasks.map((task) => {
            const terminal = isTerminalCollaborationTask(task.state) || task.state === 'awaiting-merge';
            const approval = task.worker?.activityId
              ? approvalsByActivity?.get(task.worker.activityId)
              : undefined;
            return (
              <article className="lead-workers__task" key={task.taskId}>
                <div className="lead-workers__task-copy">
                  <strong>{task.title}</strong>
                  <span>{task.mode}{task.writeScopes.length ? ` · ${task.writeScopes.join(', ')}` : ''}</span>
                  {(task.result?.summary || task.error) && <small>{task.result?.summary ?? task.error}</small>}
                </div>
                <Badge variant={taskTone(task)}>{t(`leadWorkers.state.${task.state}`)}</Badge>
                <IconButton
                  icon={terminal ? Archive : CircleStop}
                  aria-label={terminal
                    ? t('leadWorkers.archiveName', { name: task.title })
                    : t('leadWorkers.stopName', { name: task.title })}
                  disabled={busyTaskId !== null}
                  onClick={() => void (terminal ? archiveTask(task.taskId) : cancelTask(task.taskId))}
                />
                {approval?.pending && (
                  <div className="lead-workers__approval" data-testid="lead-worker-approval">
                    <code>{approval.command ?? approval.toolName}</code>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!onDecideApproval || busyTaskId !== null}
                      onClick={() => void decideApproval(task, approval, 'allow')}
                    >
                      {t('agentHub.approve')}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={!onDecideApproval || busyTaskId !== null}
                      onClick={() => void decideApproval(task, approval, 'deny')}
                    >
                      {t('agentHub.deny')}
                    </Button>
                  </div>
                )}
              </article>
            );
          })}
          {message && <p className="lead-workers__message" role="status">{message}</p>}
        </div>
      )}
    </aside>
  );
}
