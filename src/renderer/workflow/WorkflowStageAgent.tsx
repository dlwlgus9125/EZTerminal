import { Button, Field, Select } from '../ui';
import { Glyph } from '../ui/Glyph';
import type { WorkflowCopy } from './workflow-copy';
import './workflow-agents.css';

export interface WorkflowStageAgentCheck {
  readonly id: string;
  readonly command: string;
  /** `needed`: new or changed since a person last confirmed it, so it does not run yet. */
  readonly consent: 'confirmed' | 'needed';
}

export interface WorkflowStageAgentProps {
  readonly text: WorkflowCopy;
  /** The agent placed on the stage; absent = none yet. `missing`: its id is not in this PC's Settings. */
  readonly agent?: { readonly name: string; readonly detail: string; readonly tone: 'codex' | 'claude' | 'other'; readonly missing?: boolean; readonly effortLabel?: string; readonly permissionLabel: string };
  /** Continue the previous stage's conversation (same agent) or start fresh; `reason` when it cannot continue. */
  readonly session: { readonly value: 'continue' | 'fresh'; readonly from?: string; readonly reason?: string };
  readonly effort: { readonly value: string; readonly options: readonly { readonly value: string; readonly label: string }[] };
  readonly permission: { readonly value: string; readonly options: readonly { readonly value: string; readonly label: string }[]; readonly note?: string };
  readonly checks: readonly WorkflowStageAgentCheck[];
  readonly review: { readonly value: string; readonly options: readonly { readonly value: string; readonly label: string }[]; readonly note?: string };
  readonly disabled?: boolean;
  readonly onChange?: (patch: Record<string, string>) => void;
  readonly onReplace?: () => void;
  readonly onRemove?: () => void;
  readonly onConfirmCheck?: (id: string) => void;
  readonly onAddCheck?: () => void;
}

/**
 * Who does a stage and how hard: the agent placed on it (from Settings), whether it continues the
 * previous stage's conversation, and the stage's own effort, permission, checks and review. The
 * stage panel shows it in place of the AI · model · effort fields; instructions stay below it.
 */
export function WorkflowStageAgent({ text, agent, session, effort, permission, checks, review, disabled = false, onChange, onReplace, onRemove, onConfirmCheck, onAddCheck }: WorkflowStageAgentProps): JSX.Element {
  return <div className="workflow-stage-agent" data-testid="workflow-stage-agent">
    <div>
      <p className="workflow-stage-agent__label">{text('맡은 에이전트', 'Agent')}</p>
      {agent ? <div className="workflow-stage-agent__who" data-tone={agent.tone} data-missing={agent.missing || undefined}>
        {agent.missing ? <Glyph name="warn" data-tone="amber" /> : <span className="workflow-agent__lamp" aria-hidden="true" />}
        <div className="workflow-stage-agent__who-body">
          <strong>{agent.name}</strong>
          <small>{agent.missing ? text('이 PC의 설정에 없는 에이전트입니다. 다시 배정해야 실행됩니다.', 'This agent is not in this PC’s Settings. Reassign it to run.') : agent.detail}</small>
        </div>
        <Button size="sm" disabled={disabled} onClick={onReplace}>{text('바꾸기', 'Replace')}</Button>
        {!agent.missing && <Button size="sm" variant="ghost" disabled={disabled} onClick={onRemove} aria-label={text('에이전트 빼기', 'Remove agent')}><Glyph name="x" /></Button>}
      </div> : <p className="workflow-stage-agent__empty">{text('오른쪽 위 에이전트 목록에서 끌어다 놓거나 \'배정\'을 누르세요.', 'Drag an agent from the list above, or press Assign.')}</p>}
    </div>
    <div>
      <p className="workflow-stage-agent__label">{text('대화', 'Conversation')}</p>
      <div className="workflow-stage-agent__session" role="radiogroup" aria-label={text('대화', 'Conversation')}>
        <Button size="sm" variant={session.value === 'continue' ? 'primary' : 'secondary'} role="radio" aria-checked={session.value === 'continue'} disabled={disabled || !!session.reason} onClick={() => onChange?.({ session: 'continue' })} leadingIcon={<Glyph name="link" />}>{text('이어서', 'Continue')}</Button>
        <Button size="sm" variant={session.value === 'fresh' ? 'primary' : 'secondary'} role="radio" aria-checked={session.value === 'fresh'} disabled={disabled} onClick={() => onChange?.({ session: 'fresh' })} leadingIcon={<Glyph name="new" />}>{text('새로 시작', 'Start fresh')}</Button>
      </div>
      <p className="workflow-stage-agent__note" data-tone={session.value === 'continue' && !session.reason ? 'saving' : undefined}>
        {session.reason ?? (session.value === 'continue'
          ? text(`'${session.from ?? ''}' 단계와 같은 대화에서 이어서 합니다. 지금까지의 맥락을 다시 읽지 않아 토큰과 시간을 아낍니다.`, `Continues the '${session.from ?? ''}' conversation: no re-reading of the context, so fewer tokens and less time.`)
          : text('새 대화에서 시작합니다. 앞 단계 결과는 요약으로 넘겨받습니다.', 'Starts a new conversation; the previous result arrives as a summary.'))}
      </p>
    </div>
    <div className="workflow-stage-agent__pair">
      <Field label={text('노력', 'Effort')} description={agent?.effortLabel ? text(`에이전트 기본: ${agent.effortLabel}`, `Agent default: ${agent.effortLabel}`) : undefined}>
        <Select value={effort.value} disabled={disabled || !agent} onChange={event => onChange?.({ effort: event.target.value })} data-testid="workflow-stage-agent-effort">
          {effort.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      </Field>
      <Field label={text('권한', 'Permission')} description={permission.note}>
        <Select value={permission.value} disabled={disabled || !agent} onChange={event => onChange?.({ permission: event.target.value })}>
          {permission.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      </Field>
    </div>
    <div>
      <p className="workflow-stage-agent__label">{text('확인 명령 · 결과로 통과/실패', 'Checks · pass or fail by result')}</p>
      {checks.length === 0 && <p className="workflow-stage-agent__note">{text('없음. 명령이 없으면 완료 조건은 검토 AI가 읽고 판단합니다.', 'None. Without one, the review AI judges the acceptance criteria.')}</p>}
      {checks.map(check => <div key={check.id} className="workflow-check" data-consent={check.consent}>
        <Glyph name="term" />
        <code>{check.command}</code>
        {check.consent === 'needed'
          ? <Button size="sm" variant="primary" disabled={disabled} onClick={() => onConfirmCheck?.(check.id)}>{text('확인하고 허용', 'Review and allow')}</Button>
          : <span className="workflow-stage-agent__note" data-tone="saving"><Glyph name="check" />{text('확인됨', 'Allowed')}</span>}
      </div>)}
      {checks.some(check => check.consent === 'needed') && <p className="workflow-stage-agent__note">{text('새로 생기거나 바뀐 명령은 사람이 한 번 확인해야 실행됩니다. 받은 저장소에 들어 있던 명령도 같습니다.', 'New or changed commands run only after a person allows them once — including ones that came with a cloned repository.')}</p>}
      <Button size="sm" variant="ghost" leadingIcon={<Glyph name="plus" />} disabled={disabled} onClick={onAddCheck}>{text('명령 추가', 'Add a check')}</Button>
    </div>
    <Field label={text('검토', 'Review')} description={review.note}>
      <Select value={review.value} disabled={disabled} onChange={event => onChange?.({ review: event.target.value })}>
        {review.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select>
    </Field>
  </div>;
}
