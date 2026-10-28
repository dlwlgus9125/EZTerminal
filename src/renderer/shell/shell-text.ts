import { useCallback } from 'react';

import { useAppTranslation } from '../i18n';
import type { ConversationState, LiveFlow, WaitingItem } from './shell-model';

export type ShellText = (ko: string, en: string) => string;

/** The shell's words in the current language (Korean first, like the approved prototype). */
export function useShellText(): { readonly text: ShellText; readonly ko: boolean } {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith('ko');
  const text = useCallback<ShellText>((korean, english) => (ko ? korean : english), [ko]);
  return { text, ko };
}

export function providerName(providerId: string): string {
  if (providerId === 'claude') return 'Claude';
  if (providerId === 'codex') return 'Codex';
  return providerId ? providerId[0]!.toUpperCase() + providerId.slice(1) : 'AI';
}

export function conversationStateText(state: ConversationState, text: ShellText): string {
  switch (state) {
    case 'working': return text('작업 중', 'Working');
    case 'approval': return text('승인 기다림', 'Waiting for approval');
    case 'question': return text('답 기다림', 'Waiting for your answer');
    case 'failed': return text('오류로 멈춤', 'Stopped on an error');
    case 'stopped': return text('멈춤', 'Stopped');
    case 'done': return text('끝남', 'Finished');
    case 'new': return text('새 대화', 'New');
  }
}

export function flowPhaseText(phase: LiveFlow['phase'], text: ShellText): string {
  switch (phase) {
    case 'never-run': return text('아직 실행 안 함', 'Not run yet');
    case 'prepared': return text('준비됨', 'Prepared');
    case 'running': return text('실행 중', 'Running');
    case 'awaiting-approval': return text('승인 기다림', 'Waiting for approval');
    case 'paused': return text('멈춤', 'Paused');
    case 'completed': return text('끝남', 'Finished');
    case 'cancelled': return text('취소됨', 'Cancelled');
    case 'attention': return text('확인 필요', 'Needs a look');
  }
}

export function waitingKindText(kind: WaitingItem['kind'], text: ShellText, asks?: WaitingItem['asks']): string {
  if (kind === 'flow-approval' && asks === 'answer') return text('워크플로 답변', 'Workflow answer');
  switch (kind) {
    case 'command': return text('명령 실행 승인', 'Run a command');
    case 'file-change': return text('파일 변경 승인', 'Change files');
    case 'tool': return text('도구 사용 승인', 'Use a tool');
    case 'question': return text('질문', 'Question');
    case 'plan': return text('계획 승인', 'Approve the plan');
    case 'other': return text('승인', 'Approval');
    case 'flow-approval': return text('워크플로 승인', 'Workflow approval');
    case 'terminal-agent': return text('터미널 에이전트', 'Terminal agent');
  }
}
