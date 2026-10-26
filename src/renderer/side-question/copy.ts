import type { AgentSideQuestionErrorCode } from '../../shared/agent-side-question';

export interface SideQuestionCopy {
  readonly title: string;
  readonly subtitle: string;
  readonly threadLabel: string;
  readonly empty: string;
  readonly placeholder: string;
  readonly inputLabel: string;
  readonly send: string;
  readonly stop: string;
  readonly clear: string;
  readonly close: string;
  readonly you: string;
  readonly pending: string;
  readonly noAnswer: string;
  readonly retry: string;
  readonly resizeWidth: string;
  readonly resizeHeight: string;
  readonly errors: Readonly<Record<AgentSideQuestionErrorCode, string>>;
}

const COPY: Readonly<Record<'en' | 'ko', SideQuestionCopy>> = {
  en: {
    title: 'btw',
    subtitle: 'Answers from this conversation, without tools. Nothing is saved.',
    threadLabel: 'Side questions and answers',
    empty: 'Ask about anything already in this conversation. The conversation keeps going meanwhile.',
    placeholder: 'Ask a side question',
    inputLabel: 'Side question',
    send: 'Ask',
    stop: 'Stop',
    clear: 'Clear',
    close: 'Close',
    you: 'You',
    pending: 'Answering…',
    noAnswer: 'No answer came back.',
    retry: 'Ask again',
    resizeWidth: 'Resize width',
    resizeHeight: 'Resize height',
    errors: {
      invalid: 'This question could not be sent.',
      'not-live': 'This conversation is no longer connected. Send it a message, then ask again.',
      unsupported: 'This AI does not answer side questions.',
      busy: 'Too many side questions at once. Try again shortly.',
      'session-restarted': 'The conversation settings changed, so this side question was cancelled.',
      cancelled: 'Stopped.',
      timeout: 'No answer within 5 minutes.',
      unavailable: 'The computer running the conversation is not reachable right now.',
      failed: 'The side question failed. Try again.',
    },
  },
  ko: {
    title: 'btw',
    subtitle: '이 대화 내용만으로 도구 없이 답합니다. 대화·기록에 남지 않습니다.',
    threadLabel: '곁가지 문답',
    empty: '이 대화에 이미 있는 내용이면 무엇이든 물어보세요. 그동안 본 대화는 계속됩니다.',
    placeholder: '곁가지 질문 입력',
    inputLabel: '곁가지 질문',
    send: '묻기',
    stop: '멈추기',
    clear: '지우기',
    close: '닫기',
    you: '나',
    pending: '답하는 중…',
    noAnswer: '답이 오지 않았습니다.',
    retry: '다시 묻기',
    resizeWidth: '폭 조절',
    resizeHeight: '높이 조절',
    errors: {
      invalid: '이 질문은 보낼 수 없습니다.',
      'not-live': '이 대화의 연결이 끊겼습니다. 메시지를 한 번 보낸 뒤 다시 물어보세요.',
      unsupported: '이 AI는 곁가지 질문을 지원하지 않습니다.',
      busy: '곁가지 질문이 너무 많습니다. 잠시 뒤 다시 물어보세요.',
      'session-restarted': '본 대화 설정이 바뀌어 취소됐습니다.',
      cancelled: '멈췄습니다.',
      timeout: '5분 안에 답이 오지 않았습니다.',
      unavailable: '지금은 대화가 돌아가는 컴퓨터에 연결할 수 없습니다.',
      failed: '곁가지 질문이 실패했습니다. 다시 물어보세요.',
    },
  },
};

export const sideQuestionCopy = (ko: boolean): SideQuestionCopy => COPY[ko ? 'ko' : 'en'];
