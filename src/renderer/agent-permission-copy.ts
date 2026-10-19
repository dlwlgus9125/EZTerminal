import type { PermissionPreset } from '../shared/daemon-protocol';
import type { ChatLocale } from './chat/model/summary';

/**
 * What a conversation may do without asking. Plan mode is a separate switch,
 * stored as the `plan` preset while it is on.
 */
export type AccessLevel = Exclude<PermissionPreset, 'plan'>;

export const ACCESS_LEVELS: readonly AccessLevel[] = ['standard', 'full-access'];

export function isAccessLevel(value: unknown): value is AccessLevel {
  return value === 'standard' || value === 'full-access';
}

export interface AgentPermissionCopy {
  /** Name of the access control. */
  readonly access: string;
  readonly levels: Readonly<Record<AccessLevel, { readonly label: string; readonly hint: string }>>;
  readonly plan: string;
  readonly planHint: string;
  /** A plan-only automated agent (schedules, planning stages): it never runs the plan. */
  readonly planOnly: string;
  readonly planOnlyHint: string;
  readonly startInPlan: string;
  readonly planShortcut: string;
}

const COPY: Readonly<Record<ChatLocale, AgentPermissionCopy>> = {
  en: {
    access: 'Access',
    levels: {
      standard: { label: 'Ask before running', hint: 'Works in the selected folder and asks before commands and edits that need approval.' },
      'full-access': { label: 'Full access', hint: 'Runs commands and edits without asking.' },
    },
    plan: 'Plan',
    planHint: 'Investigates and proposes a plan without changing files. Approving the plan runs it with the access level.',
    planOnly: 'Plan only · read-only',
    planOnlyHint: 'Investigates and reports a plan without changing files.',
    startInPlan: 'Start in plan mode',
    planShortcut: 'Shift+Tab',
  },
  ko: {
    access: '권한',
    levels: {
      standard: { label: '승인 후 실행', hint: '선택한 작업 위치에서 일하고, 승인이 필요한 명령과 편집은 먼저 묻습니다.' },
      'full-access': { label: '전체 권한', hint: '묻지 않고 명령과 편집을 실행합니다.' },
    },
    plan: '계획',
    planHint: '파일을 바꾸지 않고 조사해 계획을 제안합니다. 계획을 승인하면 선택한 권한으로 실행합니다.',
    planOnly: '계획만 · 읽기 전용',
    planOnlyHint: '파일을 바꾸지 않고 조사해 계획을 보고합니다.',
    startInPlan: '계획 모드로 시작',
    planShortcut: 'Shift+Tab',
  },
};

export function agentPermissionCopy(locale: ChatLocale): AgentPermissionCopy {
  return COPY[locale];
}

/**
 * One label for a stored preset. A conversation shows `plan` as the plan
 * switch; an automated agent shows it as plan-only, since nobody approves it.
 */
export function permissionPresetLabel(preset: PermissionPreset, locale: ChatLocale, context: 'conversation' | 'automated' = 'conversation'): string {
  const copy = COPY[locale];
  if (preset === 'plan') return context === 'automated' ? copy.planOnly : copy.plan;
  return copy.levels[preset].label;
}

export function permissionPresetHint(preset: PermissionPreset, locale: ChatLocale, context: 'conversation' | 'automated' = 'conversation'): string {
  const copy = COPY[locale];
  if (preset === 'plan') return context === 'automated' ? copy.planOnlyHint : copy.planHint;
  return copy.levels[preset].hint;
}
