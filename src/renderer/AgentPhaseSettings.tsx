import type { ChatAgentPhaseMap, ChatAgentProfile } from '../shared/chat-agent-profiles';
import { Field, Select, Switch } from './ui';
import { Glyph } from './ui/Glyph';
import { workflowEffortLabel } from './workflow/workflow-copy';
import './agent-profiles-settings.css';

export interface AgentPhaseSettingsProps {
  readonly ko: boolean;
  readonly profiles: readonly ChatAgentProfile[];
  readonly phases: ChatAgentPhaseMap;
  /** The AIs conversations can use (their agents are listed per AI). */
  readonly providers: readonly { readonly id: string; readonly label: string }[];
  readonly disabled?: boolean;
  readonly onChange: (phases: ChatAgentPhaseMap) => void;
}

/**
 * Settings › AI › 단계 연결: which agent applies in each phase of a conversation. Plan and implement are set
 * per AI (a conversation only switches within its own AI, in the same session); review is shared because it
 * runs as a new conversation. By default only effort and permission change at a switch, so the conversation's
 * cache stays warm; changing the model as well is opt-in because it re-reads the whole conversation.
 */
export function AgentPhaseSettings({ ko, profiles, phases, providers, disabled = false, onChange }: AgentPhaseSettingsProps): JSX.Element {
  const text = (korean: string, english: string): string => ko ? korean : english;
  const label = (id: string): string => providers.find(provider => provider.id === id)?.label ?? id;
  const describe = (profile: ChatAgentProfile | undefined): string => profile
    ? [label(profile.providerId), profile.model ?? text('기본 모델', 'Default model'), profile.reasoningEffort ? workflowEffortLabel(profile.reasoningEffort, text) : undefined].filter(Boolean).join(' · ')
    : text('바꾸지 않음 (대화 설정 그대로)', 'No change (keep the conversation’s settings)');
  const setProvider = (providerId: string, phase: 'plan' | 'implement', profileId: string) => {
    const current = phases.byProvider[providerId] ?? {};
    onChange({ ...phases, byProvider: { ...phases.byProvider, [providerId]: { ...current, [phase]: profileId ? { profileId } : undefined } } });
  };
  const row = (id: string, step: string, title: string, when: string, value: string | undefined, choices: readonly ChatAgentProfile[], onPick: (profileId: string) => void) => {
    const chosen = profiles.find(profile => profile.id === value);
    return <li key={id} className="agent-phase-settings__row">
      <span className="agent-phase-settings__step" aria-hidden="true">{step}</span>
      <div className="agent-phase-settings__phase"><strong>{title}</strong><small>{when}</small></div>
      <Field label={`${title} ${text('에이전트', 'agent')}`} labelHidden description={describe(chosen)}>
        <Select value={chosen?.id ?? ''} disabled={disabled} onChange={event => onPick(event.target.value)}>
          <option value="">{text('바꾸지 않음', 'No change')}</option>
          {choices.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </Select>
      </Field>
    </li>;
  };
  return <section className="agent-phase-settings" aria-labelledby="agent-phase-settings-title" data-testid="agent-phase-settings">
    <div className="agent-profiles-settings__head"><h3 id="agent-phase-settings-title">{text('단계 연결', 'Phases')}</h3></div>
    <p className="agent-profiles-settings__note">{text('계획을 승인해 구현으로 넘어갈 때 알맞은 에이전트가 저절로 적용됩니다. 멈출 필요 없이 다음 차례부터 바뀌고, 대화는 같은 AI 안에서만 바뀝니다.',
      'When an approved plan moves to implementing, the right agent applies by itself — from the next turn, without stopping, within the conversation’s own AI.')}</p>
    {providers.map(provider => {
      const own = profiles.filter(profile => profile.providerId === provider.id);
      const mapping = phases.byProvider[provider.id] ?? {};
      return <div key={provider.id} className="agent-phase-settings__group" data-provider={provider.id}>
        <p className="agent-phase-settings__group-title"><span className="agent-phase-settings__lamp" aria-hidden="true" />{text(`${provider.label}로 대화할 때`, `In ${provider.label} conversations`)}</p>
        <ol className="agent-phase-settings__rows">
          {row(`${provider.id}-plan`, '1', text('계획', 'Plan'), text('계획 모드를 켜고 보낼 때', 'When you send with plan mode on'), mapping.plan?.profileId, own, value => setProvider(provider.id, 'plan', value))}
          {row(`${provider.id}-implement`, '2', text('구현', 'Implement'), text('계획을 승인해 실행할 때', 'When an approved plan runs'), mapping.implement?.profileId, own, value => setProvider(provider.id, 'implement', value))}
        </ol>
      </div>;
    })}
    <div className="agent-phase-settings__group" data-provider="any">
      <p className="agent-phase-settings__group-title"><Glyph name="search" />{text('모든 대화 공통', 'Every conversation')}</p>
      <ol className="agent-phase-settings__rows">
        {row('review', '3', text('검토', 'Review'), text('검토 맡기기 · 워크플로 검토 단계의 기본 (새 대화라 다른 AI도 됨)', 'Hand off a review, and the workflow review default (a new conversation, any AI)'), phases.review?.profileId, profiles,
          value => onChange({ ...phases, review: value ? { profileId: value } : undefined }))}
      </ol>
    </div>
    <Switch checked={phases.switchModel} disabled={disabled} onChange={event => onChange({ ...phases, switchModel: event.target.checked })}
      label={text('단계가 바뀔 때 모델도 바꾸기', 'Change the model too when the phase changes')}
      description={phases.switchModel
        ? text('모델이 바뀌면 그 차례에 지금까지의 대화를 처음부터 다시 읽습니다(캐시 없음). 긴 대화에서는 아끼는 것보다 비쌀 수 있습니다.', 'A model change re-reads the whole conversation on that turn (no cache). On a long conversation it can cost more than it saves.')
        : text('꺼 두면 같은 모델에서 노력·권한만 바꿉니다. Claude 5.5 계열은 노력만 바꾸면 캐시가 그대로 남습니다.', 'Off: only effort and permission change on the same model. On Claude 5.5 models an effort change keeps the cache.')} />
  </section>;
}
