import { useEffect, useId, useState } from 'react';

import { sameChatAgentSettings, type ChatAgentProfile, type ChatAgentSettings } from '../shared/chat-agent-profiles';
import { permissionPresetLabel, reasoningEffortLabel } from './agent-permission-copy';
import type { ChatLocale } from './chat/model/summary';
import { useAppTranslation } from './i18n';
import { Button, Dialog, Field, Input, Select } from './ui';
import './delegate-agent-dialog.css';

export type DelegateMode = 'handoff' | 'review';

export interface DelegateWorkspaceOption {
  readonly id: string;
  readonly label: string;
  readonly kind: 'local' | 'worktree';
}

export type DelegateWorkspaceChoice =
  | { readonly kind: 'existing'; readonly workspaceId: string }
  | { readonly kind: 'new-worktree'; readonly branch: string };

/** What starts: a saved profile, or (a start being repeated that no profile says) exactly these settings. */
export type DelegateAgentRequest = {
  readonly workspace: DelegateWorkspaceChoice;
  readonly instruction: string;
  /** Send the child's final answer back to this conversation once. */
  readonly reportBack: boolean;
} & ({ readonly profileId: string; readonly agent?: undefined } | { readonly agent: ChatAgentSettings; readonly profileId?: undefined });

export interface DelegateAgentDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly mode: DelegateMode;
  readonly profiles: readonly ChatAgentProfile[];
  readonly providerLabels: Readonly<Record<string, string>>;
  readonly workspaces: readonly DelegateWorkspaceOption[];
  readonly defaultWorkspaceId: string;
  /** Prefilled from the conversation; the person edits it before sending. */
  readonly initialInstruction: string;
  readonly onSubmit: (request: DelegateAgentRequest) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
  /** Opens Settings → Agents → collaboration when there is no profile yet. */
  readonly onManageProfiles?: () => void;
  /** Offer "새 워크트리…" (desktop). */
  readonly allowNewWorktree?: boolean;
  /** Where it starts when it opens, if not `defaultWorkspaceId` (a suggested task the AI recommends a worktree for). */
  readonly initialWorkspace?: DelegateWorkspaceChoice;
  /**
   * A start being repeated: what it asked for, and that in words. A saved profile is chosen only if it says exactly the
   * same; otherwise the form offers these settings as they are and never puts a profile in their place.
   */
  readonly initialAgent?: ChatAgentSettings & { readonly label: string };
  /** Instead of the title `mode` gives it. */
  readonly title?: string;
  /** Instead of the button label `mode` gives it. */
  readonly submitLabel?: string;
  /** A model's name; without it the model id shows. */
  readonly modelLabel?: (providerId: string, model: string) => string;
}

const NEW_WORKTREE = '__new-worktree__';
const AS_ASKED = '__as-asked__';
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/u;

/** What a start runs with, in words: `Claude · Opus 5.5 · 높음 · 승인 후 실행`, as a suggested task's card says it. */
export function delegateAgentLine(
  agent: ChatAgentSettings,
  locale: ChatLocale,
  providerLabels: Readonly<Record<string, string>>,
  modelLabel?: (providerId: string, model: string) => string,
): string {
  return [
    providerLabels[agent.providerId] ?? agent.providerId,
    agent.model ? modelLabel?.(agent.providerId, agent.model) ?? agent.model : locale === 'ko' ? '기본 모델' : 'Default model',
    ...(agent.reasoningEffort ? [reasoningEffortLabel(agent.reasoningEffort, locale)] : []),
    // A delegated agent works on its own: a plan profile only plans.
    permissionPresetLabel(agent.permissionPreset, locale, 'automated'),
  ].join(' · ');
}

/**
 * Hand this conversation's work, or a review of it, to another agent. The new
 * agent starts as a managed child of this conversation: it shows in the child
 * track and under this chat in the project tree, and can be opened directly.
 */
export function DelegateAgentDialog({
  open, onOpenChange, mode, profiles, providerLabels, workspaces, defaultWorkspaceId, initialInstruction, onSubmit, onManageProfiles, allowNewWorktree = true,
  initialWorkspace, initialAgent, title, submitLabel, modelLabel,
}: DelegateAgentDialogProps): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  const text = (korean: string, english: string): string => ko ? korean : english;
  const instructionId = useId();
  const startWorkspace = initialWorkspace?.kind === 'new-worktree' && allowNewWorktree ? NEW_WORKTREE
    : initialWorkspace?.kind === 'existing' ? initialWorkspace.workspaceId : defaultWorkspaceId;
  const startBranch = initialWorkspace?.kind === 'new-worktree' && allowNewWorktree ? initialWorkspace.branch : '';
  const askedProfile = initialAgent && profiles.find((entry) => sameChatAgentSettings(entry, initialAgent));
  const startProfile = initialAgent && !askedProfile ? AS_ASKED : (askedProfile ?? profiles[0])?.id ?? '';
  const [profileId, setProfileId] = useState(startProfile);
  const [workspaceId, setWorkspaceId] = useState(startWorkspace);
  const [branch, setBranch] = useState(startBranch);
  const [instruction, setInstruction] = useState(initialInstruction);
  const [reportBack, setReportBack] = useState(mode === 'review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setProfileId(startProfile);
    setWorkspaceId(startWorkspace);
    setBranch(startBranch);
    setInstruction(initialInstruction);
    setReportBack(mode === 'review');
    setError(undefined);
  }, [open, mode, startProfile, startWorkspace, startBranch, initialInstruction, profiles]);

  const profile = profiles.find((entry) => entry.id === profileId);
  const asAsked = profileId === AS_ASKED ? initialAgent : undefined;
  const newWorktree = workspaceId === NEW_WORKTREE;
  const branchInvalid = newWorktree && !BRANCH.test(branch.trim());
  const canSubmit = Boolean(profile ?? asAsked) && instruction.trim().length > 0 && !branchInvalid && !busy;

  const submit = async (): Promise<void> => {
    const who = asAsked
      ? { agent: { providerId: asAsked.providerId, ...(asAsked.model ? { model: asAsked.model } : {}), ...(asAsked.reasoningEffort ? { reasoningEffort: asAsked.reasoningEffort } : {}), permissionPreset: asAsked.permissionPreset } }
      : profile ? { profileId: profile.id } : undefined;
    if (!who || !canSubmit) return;
    setBusy(true);
    setError(undefined);
    const result = await onSubmit({
      ...who,
      workspace: newWorktree ? { kind: 'new-worktree', branch: branch.trim() } : { kind: 'existing', workspaceId },
      instruction: instruction.trim(),
      reportBack,
    });
    setBusy(false);
    if (result.ok) onOpenChange(false);
    else setError(result.error);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!busy) onOpenChange(next); }}
      title={title ?? (mode === 'review' ? text('검토 맡기기', 'Ask for a review') : text('다른 에이전트에게 맡기기', 'Hand off to another agent'))}
      description={text(
        '새 에이전트가 이 대화의 하위 대화로 시작합니다. 진행은 입력창 위 서브에이전트 목록과 프로젝트 목록에서 볼 수 있습니다.',
        'The new agent starts as a child of this conversation. Follow it above the composer and in the project list.',
      )}
      size="md"
      dismissible={!busy}
      closeLabel={text('닫기', 'Close')}
      className="delegate-agent-dialog"
      testId="delegate-agent-dialog"
      footer={(
        <>
          <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>{text('취소', 'Cancel')}</Button>
          <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={() => void submit()} data-testid="delegate-agent-submit">
            {submitLabel ?? (mode === 'review' ? text('검토 맡기기', 'Ask for review') : text('맡기기', 'Hand off'))}
          </Button>
        </>
      )}
    >
      {profiles.length === 0 && !initialAgent ? (
        <div className="delegate-agent-dialog__empty">
          <p>{text('먼저 에이전트 프로필을 만드세요. 어떤 AI·모델·권한으로 시작할지 정해 둡니다.', 'Create an agent profile first: which AI, model and permission to start with.')}</p>
          {onManageProfiles && <Button variant="secondary" size="sm" onClick={onManageProfiles}>{text('프로필 관리', 'Manage profiles')}</Button>}
        </div>
      ) : (
        <div className="delegate-agent-dialog__form">
          <Field label={text('에이전트 프로필', 'Agent profile')} description={asAsked
            ? text('저장된 프로필이 아닙니다. 시작하려던 설정 그대로 씁니다.', 'Not a saved profile. It starts with these settings as they are.')
            : profile ? delegateAgentLine(profile, ko ? 'ko' : 'en', providerLabels, modelLabel) : undefined}>
            <Select value={profileId} onChange={(event) => setProfileId(event.currentTarget.value)} data-testid="delegate-agent-profile">
              {initialAgent && !askedProfile && <option value={AS_ASKED}>{initialAgent.label}</option>}
              {profiles.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </Select>
          </Field>
          {profile?.whenToUse && <p className="delegate-agent-dialog__hint">{profile.whenToUse}</p>}
          <Field label={text('작업 위치', 'Workspace')}>
            <Select value={workspaceId} onChange={(event) => setWorkspaceId(event.currentTarget.value)} data-testid="delegate-agent-workspace">
              {workspaces.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.kind === 'worktree' ? `${entry.label} · ${text('워크트리', 'worktree')}` : entry.label}</option>
              ))}
              {allowNewWorktree && <option value={NEW_WORKTREE}>{text('새 워크트리…', 'New worktree…')}</option>}
            </Select>
          </Field>
          {newWorktree && (
            <Field label={text('새 브랜치 이름', 'New branch name')} error={branch && branchInvalid ? text('영문·숫자와 . _ / - 만 쓸 수 있습니다.', 'Use letters, numbers and . _ / - only.') : undefined}
              description={text('원본 작업 위치는 그대로 두고 이 브랜치에서 따로 작업합니다.', 'Work happens on this branch without touching the original checkout.')}>
              <Input value={branch} maxLength={100} placeholder="feature/login-review" onChange={(event) => setBranch(event.currentTarget.value)} data-testid="delegate-agent-branch" />
            </Field>
          )}
          <Field id={instructionId} label={mode === 'review' ? text('무엇을 검토할까요?', 'What should be reviewed?') : text('무엇을 맡길까요?', 'What should it do?')}>
            <textarea id={instructionId} className="delegate-agent-dialog__instruction" rows={6} maxLength={20_000} value={instruction}
              onChange={(event) => setInstruction(event.target.value)} data-testid="delegate-agent-instruction" />
          </Field>
          <label className="delegate-agent-dialog__report">
            <input type="checkbox" checked={reportBack} onChange={(event) => setReportBack(event.target.checked)} />
            <span>{text('끝나면 결과를 이 대화로 보내기', 'Send the result back to this conversation when it finishes')}</span>
          </label>
          {error && <p className="delegate-agent-dialog__error" role="alert">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}
