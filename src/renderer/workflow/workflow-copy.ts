import type { PermissionPreset } from '../../shared/daemon-protocol';
import type { WorkflowNode } from '../../shared/workflow';
import { permissionPresetLabel } from '../agent-permission-copy';
import { useAppTranslation } from '../i18n';

export type WorkflowCopy = (ko: string, en: string) => string;

export function useWorkflowCopy(): WorkflowCopy {
  const { i18n } = useAppTranslation();
  const korean = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  return (ko, en) => korean ? ko : en;
}
export function workflowOperationLabel(operation: WorkflowNode['operation'], text: WorkflowCopy): string {
  const labels = { agent: text('AI 작업', 'AI task'), condition: text('조건 분기', 'Condition'), parallel: text('병렬 시작', 'Parallel'), join: text('결과 합류', 'Join'), approval: text('사용자 승인', 'Approval'), complete: text('완료', 'Complete') };
  return labels[operation];
}
export function workflowOutcomeLabel(outcome: string, text: WorkflowCopy): string {
  return ({ next: text('다음', 'Next'), passed: text('통과', 'Passed'), failed: text('실패', 'Failed'), approved: text('허용', 'Approved'), rejected: text('거절', 'Rejected') } as Record<string, string>)[outcome] ?? outcome;
}
/** A stage agent runs on its own: plan means it only plans. */
export function workflowPermissionLabel(preset: PermissionPreset, text: WorkflowCopy): string {
  return permissionPresetLabel(preset, text('ko', 'en') === 'ko' ? 'ko' : 'en', 'automated');
}
export function workflowStateLabel(state: string, text: WorkflowCopy): string {
  return ({ prepared: text('준비됨', 'Prepared'), running: text('실행 중', 'Running'), paused: text('일시정지', 'Paused'), reconciling: text('결과 확인 중', 'Reconciling'), 'awaiting-review': text('검토 대기', 'Awaiting review'), waiting: text('대기', 'Waiting'), active: text('진행 중', 'Active'), 'awaiting-approval': text('승인 대기', 'Awaiting approval'), completed: text('완료', 'Completed'), cancelled: text('취소됨', 'Cancelled'), rejected: text('거절됨', 'Rejected'), 'retry-exhausted': text('재시도 한도 도달', 'Retry limit reached') } as Record<string, string>)[state] ?? state;
}
