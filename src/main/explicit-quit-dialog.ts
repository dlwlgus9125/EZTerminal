import type { MessageBoxOptions } from 'electron';

export type ExplicitQuitDialogLocale = 'en' | 'ko';

/** Build the native explicit-Quit warning without coupling its policy to Electron globals. */
export function buildExplicitQuitDialogOptions(
  locale: ExplicitQuitDialogLocale,
  hasPendingStructuredAgentCreate: boolean,
): MessageBoxOptions {
  const korean = locale === 'ko';
  const ordinaryDetail = korean
    ? '실행 중인 터미널과 에이전트 세션이 모두 종료됩니다. 창만 닫으려면 취소한 뒤 닫기 버튼을 사용하세요.'
    : 'All running terminal and agent sessions will stop. To close only the window, cancel and use the window close button.';
  const pendingCreateDetail = korean
    ? '확인이 끝나지 않은 Agent 생성 복구 정보는 종료할 때 폐기됩니다. 생성 명령이 이미 전달됐다면 다음 실행에서 새 Agent를 만들 때 중복될 수 있습니다. 실행 중인 터미널과 에이전트 세션도 모두 종료됩니다. 창만 닫으려면 취소한 뒤 닫기 버튼을 사용하세요.'
    : 'Unconfirmed Agent creation recovery information will be discarded when EZTerminal quits. If the create command was already delivered, creating another Agent after restart could produce a duplicate. All running terminal and agent sessions will stop. To close only the window, cancel and use the window close button.';

  return {
    type: 'warning',
    title: 'EZTerminal',
    message: korean ? 'EZTerminal을 종료할까요?' : 'Quit EZTerminal?',
    detail: hasPendingStructuredAgentCreate ? pendingCreateDetail : ordinaryDetail,
    buttons: korean ? ['취소', '종료'] : ['Cancel', 'Quit'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
