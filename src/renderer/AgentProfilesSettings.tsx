import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { ChatAgentProfile } from '../shared/chat-agent-profiles';
import { useAppTranslation } from './i18n';
import { Button, Field, IconButton, Input, Select, Switch } from './ui';
import './agent-profiles-settings.css';

export interface AgentProfileProviderOption {
  readonly id: string;
  readonly label: string;
  readonly models: readonly string[];
  readonly efforts: readonly string[];
}

export interface AgentProfilesSettingsProps {
  readonly orchestrationEnabled: boolean;
  readonly orchestrationBusy?: boolean;
  readonly onOrchestrationChange: (enabled: boolean) => void;
  readonly profiles: readonly ChatAgentProfile[];
  readonly providers: readonly AgentProfileProviderOption[];
  readonly onSaveProfile: (profile: ChatAgentProfile) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
  readonly onDeleteProfile: (id: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
}

type Draft = Omit<ChatAgentProfile, 'id'> & { readonly id?: string };

const emptyDraft = (providerId: string): Draft => ({ name: '', providerId, permissionPreset: 'standard' });

/**
 * Settings → Agents → collaboration: whether agents may start other agents, and
 * the saved profiles people (and agents) start conversations with.
 */
export function AgentProfilesSettings({
  orchestrationEnabled, orchestrationBusy = false, onOrchestrationChange, profiles, providers, onSaveProfile, onDeleteProfile,
}: AgentProfilesSettingsProps): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  const text = (korean: string, english: string): string => ko ? korean : english;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const provider = providers.find((entry) => entry.id === draft?.providerId);
  const providerLabel = (id: string): string => providers.find((entry) => entry.id === id)?.label ?? id;
  const permissionLabel = (preset: ChatAgentProfile['permissionPreset']): string => preset === 'plan' ? 'Plan' : preset === 'full-access' ? 'Full access' : 'Standard';

  const save = async (): Promise<void> => {
    if (!draft || !draft.name.trim()) return;
    setBusy(true);
    setError(undefined);
    const result = await onSaveProfile({
      ...draft,
      id: draft.id ?? `profile-${Date.now().toString(36)}`,
      name: draft.name.trim(),
      ...(draft.whenToUse?.trim() ? { whenToUse: draft.whenToUse.trim() } : { whenToUse: undefined }),
    });
    setBusy(false);
    if (result.ok) setDraft(null);
    else setError(result.error);
  };

  return (
    <section className="agent-profiles-settings" aria-labelledby="agent-profiles-settings-title" data-testid="agent-profiles-settings">
      <h2 className="status-section-title" id="agent-profiles-settings-title">{text('에이전트 협업', 'Agent collaboration')}</h2>
      <Switch
        checked={orchestrationEnabled}
        disabled={orchestrationBusy}
        onChange={(event) => onOrchestrationChange(event.target.checked)}
        label={text('에이전트가 다른 에이전트를 만들 수 있음', 'Agents can start other agents')}
        description={text(
          '켜면 대화 중인 에이전트가 서브에이전트를 만들고 지시할 수 있습니다. 대화 메뉴의 맡기기는 이 설정과 상관없이 쓸 수 있습니다.',
          'Lets a running agent create and instruct child agents. Handing off from the conversation menu works either way.',
        )}
        data-testid="agent-profiles-orchestration"
      />
      <div className="agent-profiles-settings__head">
        <h3>{text('에이전트 프로필', 'Agent profiles')}</h3>
        {!draft && providers[0] && (
          <Button size="sm" variant="secondary" leadingIcon={<Plus aria-hidden="true" />} onClick={() => setDraft(emptyDraft(providers[0]!.id))}>
            {text('프로필 추가', 'Add profile')}
          </Button>
        )}
      </div>
      <p className="agent-profiles-settings__note">
        {text('새 대화와 맡기기에서 고릅니다. "언제 쓰나요"는 에이전트가 서브에이전트를 고를 때도 읽습니다.',
          'Pick one when starting or handing off a conversation. Agents also read "When to use" to choose a profile for a child.')}
      </p>
      {profiles.length === 0 && !draft && <p className="agent-profiles-settings__empty">{text('아직 프로필이 없습니다.', 'No profiles yet.')}</p>}
      {profiles.length > 0 && (
        <ul className="agent-profiles-settings__list">
          {profiles.map((profile) => (
            <li key={profile.id} className="agent-profiles-settings__item">
              <div className="agent-profiles-settings__summary">
                <strong>{profile.name}</strong>
                <span>{[providerLabel(profile.providerId), profile.model ?? text('기본 모델', 'Default model'), profile.reasoningEffort, permissionLabel(profile.permissionPreset)].filter(Boolean).join(' · ')}</span>
                {profile.whenToUse && <small>{profile.whenToUse}</small>}
              </div>
              <IconButton icon={Pencil} size="sm" variant="ghost" aria-label={`${text('편집', 'Edit')}: ${profile.name}`} onClick={() => setDraft(profile)} />
              <IconButton icon={Trash2} size="sm" variant="ghost" aria-label={`${text('삭제', 'Delete')}: ${profile.name}`} onClick={() => void onDeleteProfile(profile.id)} />
            </li>
          ))}
        </ul>
      )}
      {draft && (
        <div className="agent-profiles-settings__editor" role="group" aria-label={text('프로필 편집', 'Edit profile')}>
          <Field label={text('이름', 'Name')}>
            <Input value={draft.name} maxLength={200} placeholder={text('예: 꼼꼼한 검토자', 'e.g. Careful reviewer')} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} />
          </Field>
          <div className="agent-profiles-settings__row">
            <Field label="AI">
              <Select value={draft.providerId} onChange={(event) => setDraft({ ...draft, providerId: event.currentTarget.value, model: undefined, reasoningEffort: undefined })}>
                {providers.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </Select>
            </Field>
            <Field label={text('모델', 'Model')}>
              <Select value={draft.model ?? ''} onChange={(event) => setDraft({ ...draft, model: event.currentTarget.value || undefined })}>
                <option value="">{text('기본 모델', 'Default model')}</option>
                {provider?.models.map((model) => <option key={model} value={model}>{model}</option>)}
              </Select>
            </Field>
            <Field label={text('강도', 'Effort')}>
              <Select value={draft.reasoningEffort ?? ''} onChange={(event) => setDraft({ ...draft, reasoningEffort: event.currentTarget.value || undefined })}>
                <option value="">{text('기본 강도', 'Default')}</option>
                {provider?.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </Select>
            </Field>
            <Field label={text('권한', 'Permission')}>
              <Select value={draft.permissionPreset} onChange={(event) => setDraft({ ...draft, permissionPreset: event.currentTarget.value as ChatAgentProfile['permissionPreset'] })}>
                <option value="plan">Plan</option>
                <option value="standard">Standard</option>
                <option value="full-access">Full access</option>
              </Select>
            </Field>
          </div>
          <Field label={text('언제 쓰나요', 'When to use')}>
            <Input value={draft.whenToUse ?? ''} maxLength={1_000} placeholder={text('예: 바뀐 코드를 고치지 않고 검토만 할 때', 'e.g. Reviewing changes without editing')}
              onChange={(event) => setDraft({ ...draft, whenToUse: event.currentTarget.value })} />
          </Field>
          {error && <p role="alert" className="agent-profiles-settings__error">{error}</p>}
          <div className="agent-profiles-settings__actions">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setDraft(null); setError(undefined); }}>{text('취소', 'Cancel')}</Button>
            <Button size="sm" variant="primary" loading={busy} disabled={!draft.name.trim()} onClick={() => void save()}>{text('저장', 'Save')}</Button>
          </div>
        </div>
      )}
    </section>
  );
}
