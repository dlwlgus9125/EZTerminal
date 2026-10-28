import { z } from 'zod';

import { ChatAgentProfileSchema } from './chat-agent-profiles';
import { BUILTIN_THEME_IDS, ThemeNameSchema } from './layout-schema';
import { EffectIntensitySchema, UiDensitySchema, UiLocalePreferenceSchema } from './ui-preferences';
import { WorkflowRepeatSchema } from './workflow';
import { WorkflowTemplateInputSchema } from './workflow-templates';

/**
 * EZTerminal settings a conversation's AI changes (대화로 설정 바꾸기). Two safety classes, decided by
 * the FIELD that changes: view settings, saved agents, 단계 연결 and workflow templates apply now with
 * history and undo; anything that raises a permission or turns on something that acts on its own
 * (반복, 자동 승인, remote access, start at login, agents creating agents, 자문) is only proposed and a
 * person applies it. Saving a definition is never permission to run it.
 */

/** A host-raised approval with no turn: the person applies or declines a proposed settings change. */
export const SETTINGS_PROPOSAL_REQUEST_PREFIX = 'settings-proposal:';
/** The host raises settings proposals and records what the AI changed (`settings-proposal-v1`). */
export const SETTINGS_PROPOSAL_CAPABILITY = 'settings-proposal-v1';

export function isSettingsProposalRequest(providerRequestId: string): boolean {
  return providerRequestId.startsWith(SETTINGS_PROPOSAL_REQUEST_PREFIX);
}

export type SettingsDomain = 'ui' | 'agent' | 'phase' | 'template';

export type SettingsActor =
  | { readonly kind: 'ai'; readonly sessionId: string; readonly turnId?: string }
  | { readonly kind: 'person'; readonly principal: 'desktop' | 'android'; readonly id: string };

/** One field-level change in `userData/settings-changes.json`; `null` is "absent" (or the default). */
export interface SettingsChangeRecord {
  readonly id: string;
  readonly at: string;
  readonly actor: SettingsActor;
  readonly domain: SettingsDomain;
  /** ui: the field (`theme`, `effects.scanlines`, …); agent/template: its id; phase: `phases`. */
  readonly target: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly undoOf?: string;
  /** A person applied it from a proposal this conversation's AI raised. */
  readonly proposedBy?: { readonly sessionId: string; readonly turnId?: string };
}

const Actor = z.union([
  z.object({ kind: z.literal('ai'), sessionId: z.string().min(1).max(256), turnId: z.string().min(1).max(256).optional() }).strict(),
  z.object({ kind: z.literal('person'), principal: z.enum(['desktop', 'android']), id: z.string().min(1).max(256) }).strict(),
]);

export const SettingsChangeRecordSchema = z.object({
  id: z.string().min(1).max(128),
  at: z.string().datetime(),
  actor: Actor,
  domain: z.enum(['ui', 'agent', 'phase', 'template']),
  target: z.string().min(1).max(256),
  before: z.unknown(),
  after: z.unknown(),
  undoOf: z.string().min(1).max(128).optional(),
  proposedBy: z.object({ sessionId: z.string().min(1).max(256), turnId: z.string().min(1).max(256).optional() }).strict().optional(),
}).strict();

export const MAX_SETTINGS_CHANGES = 500;
export const SettingsChangeFileSchema = z.object({
  version: z.literal(1),
  changes: z.array(SettingsChangeRecordSchema).max(MAX_SETTINGS_CHANGES),
}).strict();
export type SettingsChangeFile = z.infer<typeof SettingsChangeFileSchema>;

// ── What an AI may ask for (the `change` argument of settings_apply / settings_propose) ─────────────────

export const UI_SETTING_FIELDS = ['theme', 'uiScale', 'font', 'effects', 'effectIntensity', 'density', 'locale', 'scrollback'] as const;

const UiSettingsPatchSchema = z.object({
  theme: ThemeNameSchema.optional(),
  uiScale: z.number().int().min(80).max(150).optional(),
  /** A font id, or null for the theme's own font. */
  font: z.string().min(1).max(256).nullable().optional(),
  /** Effect id → on/off; null returns it to the theme's default. */
  effects: z.record(z.string().min(1).max(64), z.boolean().nullable()).optional(),
  effectIntensity: EffectIntensitySchema.optional(),
  density: UiDensitySchema.optional(),
  locale: UiLocalePreferenceSchema.optional(),
  scrollback: z.number().int().min(100).max(100_000).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: 'Give at least one setting.' });
export type UiSettingsPatch = z.infer<typeof UiSettingsPatchSchema>;

/** 단계 연결: a profile id per phase (null unlinks it); plan/implement are per AI (provider id). */
const PhasePatchSchema = z.object({
  plan: z.record(z.string().min(1).max(100), z.string().min(1).max(100).nullable()).optional(),
  implement: z.record(z.string().min(1).max(100), z.string().min(1).max(100).nullable()).optional(),
  review: z.string().min(1).max(100).nullable().optional(),
  switchModel: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: 'Give at least one phase.' });
export type PhasePatch = z.infer<typeof PhasePatchSchema>;

export const HOST_SETTING_KEYS = ['orchestration', 'advisor', 'remoteAccess', 'startAtLogin'] as const;
export type HostSettingKey = typeof HOST_SETTING_KEYS[number];

export const SettingsChangeSchema = z.union([
  z.object({ domain: z.literal('ui'), set: UiSettingsPatchSchema }).strict(),
  z.object({ domain: z.literal('agent'), profile: ChatAgentProfileSchema }).strict(),
  z.object({ domain: z.literal('agent'), remove: z.string().min(1).max(100) }).strict(),
  z.object({ domain: z.literal('phase'), set: PhasePatchSchema }).strict(),
  z.object({ domain: z.literal('template'), template: WorkflowTemplateInputSchema }).strict(),
  z.object({ domain: z.literal('template'), remove: z.string().min(1).max(100) }).strict(),
  z.object({ domain: z.literal('host'), set: z.object({
    orchestration: z.boolean().optional(), advisor: z.boolean().optional(), remoteAccess: z.boolean().optional(), startAtLogin: z.boolean().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, { message: 'Give at least one setting.' }) }).strict(),
  z.object({ domain: z.literal('workflow'), subprojectId: z.string().min(1).max(160), set: z.object({
    autoApprove: z.boolean().optional(), repeat: WorkflowRepeatSchema.optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, { message: 'Give autoApprove or repeat.' }) }).strict(),
]);
export type SettingsChange = z.infer<typeof SettingsChangeSchema>;

// ── What the conversation shows ──────────────────────────────────────────────────────────────────────────

export interface SettingsProposalRow {
  readonly name: string;
  readonly before: string;
  readonly after: string;
}
export type SettingsProposalState = 'pending' | 'applying' | 'applied' | 'failed' | 'declined';
export interface SettingsProposalView {
  readonly id: string;
  readonly approvalId: string;
  readonly sessionId: string;
  readonly at: string;
  readonly title: string;
  readonly rows: readonly SettingsProposalRow[];
  readonly risk: string;
  /** Only the PC applies it: anything beyond a view setting or an agent edit that raises no permission. */
  readonly desktopOnly: boolean;
  readonly state: SettingsProposalState;
  readonly detail?: string;
  readonly resolvedBy?: 'desktop' | 'android';
}
export interface SettingsChangeView extends SettingsChangeRecord {
  readonly undone: boolean;
  /** It changed again since: undo is refused (shows the difference instead). */
  readonly conflict: boolean;
  readonly current?: unknown;
}
export interface SettingsConversationView {
  readonly changes: readonly SettingsChangeView[];
  readonly proposals: readonly SettingsProposalView[];
}
export type SettingsUndoResult =
  | { readonly ok: true; readonly changeId: string }
  | { readonly ok: false; readonly error: 'not-found' | 'already-undone' | 'conflict' | 'needs-person' | 'failed'; readonly message: string; readonly current?: unknown };
export type SettingsChangedDomain = SettingsDomain | 'host' | 'proposal';
export interface SettingsChangedEvent {
  readonly domains: readonly SettingsChangedDomain[];
}

/** Desktop only: what the AI changed or proposed in a conversation, 되돌리기, and the 자문 switch. */
export interface SettingsChangesAccess {
  conversation(sessionId: string): Promise<SettingsConversationView>;
  undo(changeId: string): Promise<SettingsUndoResult>;
  advisor(): Promise<boolean>;
  setAdvisor(enabled: boolean): Promise<boolean>;
  onChanged(listener: (event: SettingsChangedEvent) => void): () => void;
}

// ── Readable names (proposal rows, the conversation's list of changes) ───────────────────────────────────

const EFFECT_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  scanlines: ['주사선', 'Scanlines'],
  'phosphor-glow': ['형광체 발광', 'Phosphor glow'],
  flicker: ['깜박임', 'Flicker'],
  'crt-curvature': ['CRT 곡률', 'CRT curvature'],
  'crt-rollbar': ['CRT 롤 바', 'CRT roll bar'],
  'scanline-scroll': ['주사선 이동', 'Scanline scroll'],
  'jitter-burst': ['간헐적 흔들림', 'Burst jitter'],
  'micro-jitter': ['미세 흔들림', 'Micro jitter'],
  'static-noise': ['정적 노이즈', 'Static noise'],
};
const THEME_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  dark: ['다크', 'Dark'], light: ['라이트', 'Light'], 'high-contrast': ['고대비', 'High contrast'], matrix: ['매트릭스', 'Matrix'],
};
const PERMISSION_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  plan: ['계획만', 'Plan only'], standard: ['승인 후 실행', 'Ask before running'], 'full-access': ['전체 권한', 'Full access'],
};
const DENSITY_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  adaptive: ['자동', 'Adaptive'], compact: ['촘촘하게', 'Compact'], comfortable: ['넉넉하게', 'Comfortable'],
};
const LOCALE_NAMES: Readonly<Record<string, readonly [string, string]>> = { system: ['시스템', 'System'], ko: ['한국어', 'Korean'], en: ['English', 'English'] };
const PHASE_NAMES: Readonly<Record<string, readonly [string, string]>> = { plan: ['계획', 'Plan'], implement: ['구현', 'Implement'], review: ['검토', 'Review'] };

export function permissionName(preset: string, ko: boolean): string {
  const names = PERMISSION_NAMES[preset];
  return names ? names[ko ? 0 : 1] : preset;
}

export function isBuiltinThemeId(id: string): boolean {
  return (BUILTIN_THEME_IDS as readonly string[]).includes(id);
}

function pick(names: Readonly<Record<string, readonly [string, string]>>, key: string, ko: boolean): string {
  const entry = names[key];
  return entry ? entry[ko ? 0 : 1] : key;
}

function onOff(value: unknown, ko: boolean): string {
  return value === true ? (ko ? '켬' : 'On') : value === false ? (ko ? '끔' : 'Off') : (ko ? '기본' : 'Default');
}

interface ProfileLike { readonly name?: unknown; readonly providerId?: unknown; readonly model?: unknown; readonly reasoningEffort?: unknown; readonly permissionPreset?: unknown }
interface TemplateLike { readonly title?: unknown; readonly graph?: { readonly nodes?: readonly unknown[] } }

function profileSummary(value: unknown, ko: boolean): string {
  if (value === null || typeof value !== 'object') return ko ? '없음' : 'None';
  const profile = value as ProfileLike;
  return [profile.providerId, profile.model, profile.reasoningEffort, typeof profile.permissionPreset === 'string' ? permissionName(profile.permissionPreset, ko) : undefined]
    .filter((part): part is string => typeof part === 'string' && part.length > 0).join(' · ');
}

function templateSummary(value: unknown, ko: boolean): string {
  if (value === null || typeof value !== 'object') return ko ? '없음' : 'None';
  const template = value as TemplateLike;
  const stages = template.graph?.nodes?.length ?? 0;
  return ko ? `단계 ${String(stages)}개` : `${String(stages)} stage${stages === 1 ? '' : 's'}`;
}

function phaseSummary(value: unknown, ko: boolean, profileName: (id: string) => string | undefined): string {
  if (value === null || typeof value !== 'object') return ko ? '없음' : 'None';
  const map = value as { byProvider?: Record<string, { plan?: { profileId: string }; implement?: { profileId: string } }>; review?: { profileId: string }; switchModel?: boolean };
  const name = (id: string): string => profileName(id) ?? id;
  const parts: string[] = [];
  for (const [provider, links] of Object.entries(map.byProvider ?? {})) {
    for (const phase of ['plan', 'implement'] as const) {
      const link = links[phase];
      if (link) parts.push(`${provider} ${pick(PHASE_NAMES, phase, ko)}: ${name(link.profileId)}`);
    }
  }
  if (map.review) parts.push(`${pick(PHASE_NAMES, 'review', ko)}: ${name(map.review.profileId)}`);
  if (map.switchModel) parts.push(ko ? '모델도 바꾸기' : 'switch model');
  return parts.length ? parts.join(', ') : (ko ? '연결 없음' : 'No links');
}

/** One change as a person reads it: the setting, what it was and what it becomes. */
export function settingsEditLabel(
  edit: { readonly domain: SettingsDomain; readonly target: string; readonly before: unknown; readonly after: unknown },
  ko: boolean,
  names: { readonly profileName?: (id: string) => string | undefined; readonly fontName?: (id: string) => string | undefined } = {},
): SettingsProposalRow {
  const text = (korean: string, english: string): string => (ko ? korean : english);
  switch (edit.domain) {
    case 'ui': {
      const [field, effect] = edit.target.split('.', 2) as [string, string | undefined];
      const value = (raw: unknown): string => {
        if (field === 'effects') return onOff(raw, ko);
        if (raw === null || raw === undefined) return field === 'font' ? text('테마 기본', 'Theme default') : text('기본', 'Default');
        if (field === 'theme') return pick(THEME_NAMES, String(raw), ko);
        if (field === 'uiScale') return `${String(raw)}%`;
        if (field === 'font') return names.fontName?.(String(raw)) ?? String(raw);
        if (field === 'density') return pick(DENSITY_NAMES, String(raw), ko);
        if (field === 'locale') return pick(LOCALE_NAMES, String(raw), ko);
        if (field === 'scrollback') return text(`${String(raw)}줄`, `${String(raw)} lines`);
        return String(raw);
      };
      const name = field === 'effects' ? `${text('화면 효과', 'Screen effect')}: ${pick(EFFECT_NAMES, effect ?? '', ko)}`
        : field === 'theme' ? text('테마', 'Theme')
          : field === 'uiScale' ? text('UI 크기', 'UI scale')
            : field === 'font' ? text('터미널 글꼴', 'Terminal font')
              : field === 'effectIntensity' ? text('효과 강도', 'Effect intensity')
                : field === 'density' ? text('밀도', 'Density')
                  : field === 'locale' ? text('언어', 'Language')
                    : field === 'scrollback' ? text('스크롤백 줄 수', 'Scrollback lines') : field;
      return { name, before: value(edit.before), after: value(edit.after) };
    }
    case 'agent': {
      const named = (edit.after ?? edit.before) as ProfileLike | null;
      const agentName = typeof named?.name === 'string' ? named.name : edit.target;
      const before = edit.before as ProfileLike | null;
      const after = edit.after as ProfileLike | null;
      // A permission-only edit reads as the permission; other edits as the whole agent.
      if (before && after && JSON.stringify({ ...before, permissionPreset: undefined }) === JSON.stringify({ ...after, permissionPreset: undefined })) {
        return { name: text(`에이전트 "${agentName}" 권한`, `Agent "${agentName}" permission`), before: permissionName(String(before.permissionPreset), ko), after: permissionName(String(after.permissionPreset), ko) };
      }
      const name = !before ? text(`에이전트 추가: ${agentName}`, `New agent: ${agentName}`) : !after ? text(`에이전트 삭제: ${agentName}`, `Removed agent: ${agentName}`) : text(`에이전트 "${agentName}"`, `Agent "${agentName}"`);
      return { name, before: profileSummary(edit.before, ko), after: profileSummary(edit.after, ko) };
    }
    case 'phase':
      return { name: text('단계 연결', 'Phase links'), before: phaseSummary(edit.before, ko, names.profileName ?? (() => undefined)), after: phaseSummary(edit.after, ko, names.profileName ?? (() => undefined)) };
    case 'template': {
      const named = (edit.after ?? edit.before) as TemplateLike | null;
      const title = typeof named?.title === 'string' ? named.title : edit.target;
      const name = !edit.before ? text(`템플릿 추가: ${title}`, `New template: ${title}`) : !edit.after ? text(`템플릿 삭제: ${title}`, `Removed template: ${title}`) : text(`템플릿 "${title}"`, `Template "${title}"`);
      return { name, before: templateSummary(edit.before, ko), after: templateSummary(edit.after, ko) };
    }
  }
}

/** "화면 효과: 주사선 켬 → 끔" — one line for the conversation's list of changes. */
export function settingsChangeLine(row: SettingsProposalRow): string {
  return `${row.name}: ${row.before} → ${row.after}`;
}
