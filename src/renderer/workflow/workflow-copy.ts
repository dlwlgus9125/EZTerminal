import type { PermissionPreset } from '../../shared/daemon-protocol';
import type { WorkflowNode, WorkflowRepeat } from '../../shared/workflow';
import { permissionPresetLabel } from '../agent-permission-copy';
import { useAppTranslation } from '../i18n';

export type WorkflowCopy = (ko: string, en: string) => string;

export function useWorkflowCopy(): WorkflowCopy {
  const { i18n } = useAppTranslation();
  const korean = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  return (ko, en) => korean ? ko : en;
}
export function workflowOperationLabel(operation: WorkflowNode['operation'], text: WorkflowCopy): string {
  const labels = { agent: text('AI 작업', 'AI task'), condition: text('조건 분기', 'Condition'), parallel: text('병렬 시작', 'Parallel'), join: text('결과 합류', 'Join'), approval: text('사용자 승인', 'Approval'), complete: text('완료', 'Complete'), answer: text('내 답변 기다림', 'Waits for my answer') };
  return labels[operation];
}
export function workflowOutcomeLabel(outcome: string, text: WorkflowCopy): string {
  return ({ next: text('다음', 'Next'), passed: text('통과', 'Passed'), failed: text('실패', 'Failed'), approved: text('허용', 'Approved'), rejected: text('거절', 'Rejected') } as Record<string, string>)[outcome] ?? outcome;
}
/** A model's reasoning effort as the conversation composer names it. */
export function workflowEffortLabel(effort: string, text: WorkflowCopy): string {
  return ({ minimal: text('최소', 'Minimal'), low: text('낮음', 'Low'), medium: text('보통', 'Medium'), high: text('높음', 'High'), xhigh: text('매우 높음', 'Extra high'), max: text('최대', 'Max') } as Record<string, string>)[effort] ?? effort;
}
/** 0 = Sunday ... 6 = Saturday, short. */
export function workflowWeekdayLabel(weekday: number, text: WorkflowCopy): string {
  return text('일월화수목금토'[weekday] ?? '', ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday] ?? '');
}
/** 반복 as one phrase: 매일 09:00 / 매주 월 09:00. */
export function workflowRepeatLabel(repeat: Pick<WorkflowRepeat, 'cadence' | 'weekday' | 'time'>, text: WorkflowCopy): string {
  return repeat.cadence === 'weekly'
    ? text(`매주 ${workflowWeekdayLabel(repeat.weekday ?? 0, text)} ${repeat.time}`, `Weekly ${workflowWeekdayLabel(repeat.weekday ?? 0, text)} ${repeat.time}`)
    : text(`매일 ${repeat.time}`, `Daily ${repeat.time}`);
}
/** A stage agent runs on its own: plan means it only plans. */
export function workflowPermissionLabel(preset: PermissionPreset, text: WorkflowCopy): string {
  return permissionPresetLabel(preset, text('ko', 'en') === 'ko' ? 'ko' : 'en', 'automated');
}
const ISSUE_KO: Record<string, string> = {
  'ambiguous-join': '여러 갈래가 들어오면 결과 합류 단계가 필요합니다.',
  'ambiguous-output': '여러 단계로 나누려면 병렬 시작을 쓰세요.',
  'approval-port': '승인 단계에는 허용 연결이 하나 필요합니다.',
  'complete-output': '완료 단계에서는 나가는 연결을 만들 수 없습니다.',
  'condition-order': '조건이 판단할 단계는 조건보다 앞에 있어야 합니다.',
  'condition-ports': '조건 분기에는 통과와 실패 연결이 하나씩 필요합니다.',
  'condition-source': '이 조건이 판단할, 검증된 결과를 내는 AI 단계를 고르세요.',
  'duplicate-edge': '연결 ID가 중복됩니다.',
  'duplicate-node': '단계 ID가 중복됩니다.',
  'incomplete-task': 'AI 단계에는 지시와 완료 조건이 필요합니다.',
  'invalid-port': '이 단계에는 없는 연결 조건입니다.',
  'join-policy': '들어오는 갈래를 어떻게 합칠지 고르세요.',
  'missing-entry': '시작 단계를 지정하세요.',
  'missing-input': '참조한 입력 단계가 없거나 자기 자신입니다.',
  'missing-node': '연결이 없는 단계를 가리킵니다.',
  'missing-provider': '이 단계를 실행할 AI와 모델을 고르세요.',
  'missing-scope': '파일을 수정하는 단계에는 허용 경로가 필요합니다.',
  'no-completion': '이 단계에서 완료까지 가는 길이 없습니다.',
  'parallel-branches': '병렬 시작에는 갈래가 두 개 이상 필요합니다.',
  permission: '관리형 실행에는 범위가 정해진 권한이 필요합니다.',
  'result-order': '실행 결과 입력은 앞쪽 AI 단계를 가리켜야 합니다.',
  'retry-condition': '재시도 고리 안의 조건이 판단하는 단계도 다시 실행되어야 합니다.',
  'retry-join': '결과 합류의 모든 입력이 같은 회차가 되도록 병렬 시작에서 재시도하세요.',
  'retry-port': '재시도 연결은 실패나 거절에서만 나갈 수 있습니다.',
  'retry-target': '재시도는 실패를 판단한 단계보다 앞 단계로 돌아가야 합니다.',
  'unbounded-cycle': '횟수 제한이 없는 순환이 있습니다.',
  unreachable: '시작 단계에서 이 단계로 올 수 없습니다.',
  'missing-agent': '이 PC의 설정에 없는 에이전트입니다. 에이전트를 다시 배정하세요.',
  'answer-prompt': '이 단계가 사람에게 물어볼 내용을 쓰세요.',
  'answer-result': '답변 단계는 AI 단계의 결과만 보여 줄 수 있습니다.',
  'duplicate-check': '확인 명령 ID가 중복됩니다.',
  'check-stage': '확인 명령은 AI 단계에만 둘 수 있습니다.',
  'review-off-unconfirmed': '검토를 끄고 확인 명령도 없으면, 바로 뒤에 사람이 결과를 수락하는 승인 단계가 있어야 합니다.',
};
/** Validator issues carry English messages; the code picks the Korean wording. */
export function workflowIssueLabel(issue: { readonly code: string; readonly message: string }, text: WorkflowCopy): string {
  return text(ISSUE_KO[issue.code] ?? issue.message, issue.message);
}
export function workflowStateLabel(state: string, text: WorkflowCopy): string {
  return ({ prepared: text('준비됨', 'Prepared'), running: text('실행 중', 'Running'), paused: text('일시정지', 'Paused'), reconciling: text('결과 확인 중', 'Reconciling'), 'awaiting-review': text('검토 대기', 'Awaiting review'), waiting: text('대기', 'Waiting'), active: text('진행 중', 'Active'), 'awaiting-approval': text('승인 대기', 'Awaiting approval'), 'awaiting-answer': text('답변 대기', 'Awaiting your answer'), completed: text('완료', 'Completed'), cancelled: text('취소됨', 'Cancelled'), rejected: text('거절됨', 'Rejected'), 'retry-exhausted': text('재시도 한도 도달', 'Retry limit reached') } as Record<string, string>)[state] ?? state;
}
