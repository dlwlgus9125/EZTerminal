import { useEffect, useId, useState } from 'react';

import type { ChatAgentProfile } from '../shared/chat-agent-profiles';
import { permissionPresetLabel } from './agent-permission-copy';
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

export interface DelegateAgentRequest {
  readonly profileId: string;
  readonly workspace: DelegateWorkspaceChoice;
  readonly instruction: string;
  /** Send the child's final answer back to this conversation once. */
  readonly reportBack: boolean;
}

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
}

const NEW_WORKTREE = '__new-worktree__';
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/u;

/**
 * Hand this conversation's work, or a review of it, to another agent. The new
 * agent starts as a managed child of this conversation: it shows in the child
 * track and under this chat in the project tree, and can be opened directly.
 */
export function DelegateAgentDialog({
  open, onOpenChange, mode, profiles, providerLabels, workspaces, defaultWorkspaceId, initialInstruction, onSubmit, onManageProfiles, allowNewWorktree = true,
}: DelegateAgentDialogProps): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  const text = (korean: string, english: string): string => ko ? korean : english;
  const instructionId = useId();
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? '');
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId);
  const [branch, setBranch] = useState('');
  const [instruction, setInstruction] = useState(initialInstruction);
  const [reportBack, setReportBack] = useState(mode === 'review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setProfileId(profiles[0]?.id ?? '');
    setWorkspaceId(defaultWorkspaceId);
    setBranch('');
    setInstruction(initialInstruction);
    setReportBack(mode === 'review');
    setError(undefined);
  }, [open, mode, defaultWorkspaceId, initialInstruction, profiles]);

  const profile = profiles.find((entry) => entry.id === profileId);
  const newWorktree = workspaceId === NEW_WORKTREE;
  const branchInvalid = newWorktree && !BRANCH.test(branch.trim());
  const canSubmit = Boolean(profile) && instruction.trim().length > 0 && !branchInvalid && !busy;
  const profileLine = (entry: ChatAgentProfile): string => [
    providerLabels[entry.providerId] ?? entry.providerId,
    entry.model ?? text('기본 모델', 'Default model'),
    entry.reasoningEffort,
    // A delegated agent works on its own: a plan profile only plans.
    permissionPresetLabel(entry.permissionPreset, ko ? 'ko' : 'en', 'automated'),
  ].filter(Boolean).join(' · ');

  const submit = async (): Promise<void> => {
    if (!profile || !canSubmit) return;
    setBusy(true);
    setError(undefined);
    const result = await onSubmit({
      profileId: profile.id,
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
      title={mode === 'review' ? text('검토 맡기기', 'Ask for a review') : text('다른 에이전트에게 맡기기', 'Hand off to another agent')}
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
            {mode === 'review' ? text('검토 맡기기', 'Ask for review') : text('맡기기', 'Hand off')}
          </Button>
        </>
      )}
    >
      {profiles.length === 0 ? (
        <div className="delegate-agent-dialog__empty">
          <p>{text('먼저 에이전트 프로필을 만드세요. 어떤 AI·모델·권한으로 시작할지 정해 둡니다.', 'Create an agent profile first: which AI, model and permission to start with.')}</p>
          {onManageProfiles && <Button variant="secondary" size="sm" onClick={onManageProfiles}>{text('프로필 관리', 'Manage profiles')}</Button>}
        </div>
      ) : (
        <div className="delegate-agent-dialog__form">
          <Field label={text('에이전트 프로필', 'Agent profile')} description={profile ? profileLine(profile) : undefined}>
            <Select value={profileId} onChange={(event) => setProfileId(event.currentTarget.value)} data-testid="delegate-agent-profile">
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
