import type { ChatAgentPhaseMap, ChatAgentPhaseName, ChatAgentProfile } from '../shared/chat-agent-profiles';
import { Field, Select, Switch } from './ui';
import { Glyph } from './ui/Glyph';
import { workflowEffortLabel } from './workflow/workflow-copy';
import './agent-profiles-settings.css';

export interface AgentPhaseSettingsProps {
  readonly ko: boolean;
  readonly profiles: readonly ChatAgentProfile[];
  readonly phases: ChatAgentPhaseMap;
  readonly providerLabel: (providerId: string) => string;
  readonly disabled?: boolean;
  readonly onChange: (phases: ChatAgentPhaseMap) => void;
}

const PHASES: readonly { readonly id: ChatAgentPhaseName; readonly ko: string; readonly en: string; readonly whenKo: string; readonly whenEn: string }[] = [
  { id: 'plan', ko: '계획', en: 'Plan', whenKo: '계획 모드를 켜고 보낼 때', whenEn: 'When you send with plan mode on' },
  { id: 'implement', ko: '구현', en: 'Implement', whenKo: '계획을 승인해 실행할 때 · 계획 모드가 꺼져 있을 때', whenEn: 'When an approved plan runs, and with plan mode off' },
  { id: 'review', ko: '검토', en: 'Review', whenKo: '검토 맡기기 · 워크플로 검토 단계의 기본', whenEn: 'Hand off a review, and the workflow review default' },
];

/**
 * Settings › AI › 단계 연결: which agent applies in each phase of a conversation. The switch happens at a
 * turn boundary (plan approval); by default only effort and permission change, so the conversation's
 * cache stays warm. Changing the model as well is opt-in because it re-reads the whole conversation.
 */
export function AgentPhaseSettings({ ko, profiles, phases, providerLabel, disabled = false, onChange }: AgentPhaseSettingsProps): JSX.Element {
  const text = (korean: string, english: string): string => ko ? korean : english;
  const describe = (profile: ChatAgentProfile | undefined): string => profile
    ? [providerLabel(profile.providerId), profile.model ?? text('기본 모델', 'Default model'), profile.reasoningEffort ? workflowEffortLabel(profile.reasoningEffort, text) : undefined].filter(Boolean).join(' · ')
    : text('바꾸지 않음 (대화 설정 그대로)', 'No change (keep the conversation’s settings)');
  const models = new Set(PHASES.map(phase => profiles.find(profile => profile.id === phases[phase.id]?.profileId)).filter(Boolean).map(profile => `${profile!.providerId}:${profile!.model ?? ''}`));
  return <section className="agent-phase-settings" aria-labelledby="agent-phase-settings-title" data-testid="agent-phase-settings">
    <div className="agent-profiles-settings__head"><h3 id="agent-phase-settings-title">{text('단계 연결', 'Phases')}</h3></div>
    <p className="agent-profiles-settings__note">{text('대화가 계획에서 구현으로 넘어갈 때 알맞은 에이전트가 저절로 적용됩니다. 진행 중에 멈출 필요 없이 다음 차례부터 바뀝니다. 같은 AI의 에이전트끼리만 바뀝니다.',
      'When a conversation moves from planning to implementing, the right agent applies by itself — from the next turn, without stopping. Only agents of the same AI switch.')}</p>
    <ol className="agent-phase-settings__rows">
      {PHASES.map((phase, index) => {
        const chosen = profiles.find(profile => profile.id === phases[phase.id]?.profileId);
        return <li key={phase.id} className="agent-phase-settings__row" data-phase={phase.id}>
          <span className="agent-phase-settings__step" aria-hidden="true">{index + 1}</span>
          <div className="agent-phase-settings__phase"><strong>{text(phase.ko, phase.en)}</strong><small>{text(phase.whenKo, phase.whenEn)}</small></div>
          {index < PHASES.length - 1 && <Glyph name="next" className="agent-phase-settings__arrow" />}
          <Field label={text(`${phase.ko} 에이전트`, `${phase.en} agent`)} labelHidden description={describe(chosen)}>
            <Select value={chosen?.id ?? ''} disabled={disabled} onChange={event => onChange({ ...phases, [phase.id]: event.target.value ? { profileId: event.target.value } : undefined })}>
              <option value="">{text('바꾸지 않음', 'No change')}</option>
              {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </Select>
          </Field>
        </li>;
      })}
    </ol>
    <Switch checked={phases.switchModel} disabled={disabled} onChange={event => onChange({ ...phases, switchModel: event.target.checked })}
      label={text('단계가 바뀔 때 모델도 바꾸기', 'Change the model too when the phase changes')}
      description={phases.switchModel
        ? text('모델이 바뀌면 그 차례에 지금까지의 대화를 처음부터 다시 읽습니다(캐시 없음). 긴 대화에서는 아끼는 것보다 비쌀 수 있습니다.', 'A model change re-reads the whole conversation on that turn (no cache). On a long conversation it can cost more than it saves.')
        : text('꺼 두면 같은 모델에서 노력·권한만 바꿉니다. Claude 5.5 계열은 노력만 바꾸면 캐시가 그대로 남습니다.', 'Off: only effort and permission change on the same model. On Claude 5.5 models an effort change keeps the cache.')} />
    {!phases.switchModel && models.size > 1 && <p className="agent-profiles-settings__note" role="note"><Glyph name="info" />{text('고른 에이전트들의 모델이 달라도, 모델은 대화를 시작한 모델 그대로 둡니다.', 'The agents use different models; the conversation keeps the model it started with.')}</p>}
  </section>;
}
