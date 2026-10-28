import { useId, useState, type ReactNode } from 'react';
import { Button, Field, Input, Select } from '../ui';
import { Glyph } from '../ui/Glyph';
import type { WorkflowCopy } from './workflow-copy';
import './workflow-agents.css';

export interface WorkflowStageAgentCheck {
  readonly id: string;
  readonly command: string;
  /**
   * `needed`: new or changed since a person last allowed it on this PC, so it does not run yet. `unsaved`: only in
   * the unsaved draft (allowing reads the saved workflow). `pc-only`: the phone, where the PC that runs it allows it.
   * `unknown`: this PC could not say.
   */
  readonly consent: 'confirmed' | 'needed' | 'unsaved' | 'pc-only' | 'unknown';
}

export interface WorkflowStageAgentProps {
  readonly text: WorkflowCopy;
  /** The agent placed on the stage; absent = none yet. `missing`: its id is not in this PC's Settings. */
  readonly agent?: { readonly name: string; readonly detail: string; readonly tone: 'codex' | 'claude' | 'other'; readonly missing?: boolean; readonly effortLabel?: string; readonly permissionLabel: string };
  /**
   * Continue the previous stage's conversation (same agent) or start fresh; `reason` when it cannot continue, `note`
   * in place of the default sentence under the choice.
   */
  readonly session: { readonly value: 'continue' | 'fresh'; readonly from?: string; readonly reason?: string; readonly note?: string };
  readonly effort: { readonly value: string; readonly options: readonly { readonly value: string; readonly label: string }[] };
  readonly permission: { readonly value: string; readonly options: readonly { readonly value: string; readonly label: string }[]; readonly note?: string };
  readonly checks: readonly WorkflowStageAgentCheck[];
  readonly review: { readonly value: string; readonly options: readonly { readonly value: string; readonly label: string }[]; readonly note?: string };
  readonly disabled?: boolean;
  /** Effort and permission can be changed (default: an agent is placed). A stage set up before agents keeps its own. */
  readonly tunable?: boolean;
  /** Said right under the agent (e.g. 전체 권한 was lowered to 승인 후 실행 when it was placed). */
  readonly notice?: ReactNode;
  readonly onChange?: (patch: Record<string, string>) => void;
  readonly onReplace?: () => void;
  readonly onRemove?: () => void;
  readonly onConfirmCheck?: (id: string) => void;
  /** Adds a check with this command (the form opens from 명령 추가). */
  readonly onAddCheck?: (command: string) => void;
  readonly onRemoveCheck?: (id: string) => void;
  /** Opens the agent picker (phone, keyboard): shown when no agent is placed yet. */
  readonly onAssign?: () => void;
  /** Below the review choice (e.g. 결과가 같으면 건너뜀). */
  readonly children?: ReactNode;
}

/**
 * Who does a stage and how hard: the agent placed on it (from Settings), whether it continues the
 * previous stage's conversation, and the stage's own effort, permission, checks and review. The
 * stage panel shows it in place of the AI · model · effort fields; instructions stay below it.
 */
export function WorkflowStageAgent({ text, agent, session, effort, permission, checks, review, disabled = false, tunable = !!agent, notice, onChange, onReplace, onRemove, onConfirmCheck, onAddCheck, onRemoveCheck, onAssign, children }: WorkflowStageAgentProps): JSX.Element {
  const radioName = useId();
  const [adding, setAdding] = useState<string | null>(null);
  const add = () => { const command = adding?.trim(); if (command) { onAddCheck?.(command); setAdding(null); } };
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
      </div> : <div className="workflow-stage-agent__empty">
        <p>{onAssign ? text('이 단계를 맡을 에이전트를 고르세요.', 'Pick the agent for this stage.') : text('오른쪽 위 에이전트 목록에서 끌어다 놓거나 \'배정\'을 누르세요.', 'Drag an agent from the list above, or press Assign.')}</p>
        {onAssign && <Button variant="primary" size="sm" disabled={disabled} onClick={onAssign} leadingIcon={<Glyph name="bot" />}>{text('에이전트 배정', 'Assign an agent')}</Button>}
      </div>}
      {notice && <p className="workflow-stage-agent__notice" role="status">{notice}</p>}
    </div>
    <div>
      <fieldset className="workflow-stage-agent__session" disabled={disabled}>
        <legend className="workflow-stage-agent__label">{text('이 단계를 실행할 때', 'When this stage runs')}</legend>
        <label data-checked={session.value === 'continue' || undefined} data-disabled={!!session.reason || undefined}>
          <input type="radio" name={`${radioName}-session`} value="continue" checked={session.value === 'continue'} disabled={!!session.reason} onChange={() => onChange?.({ session: 'continue' })} />
          <Glyph name="link" /><span>{text('앞 대화 이어서', 'Continue the previous conversation')}</span>
        </label>
        <label data-checked={session.value === 'fresh' || undefined}>
          <input type="radio" name={`${radioName}-session`} value="fresh" checked={session.value === 'fresh'} onChange={() => onChange?.({ session: 'fresh' })} />
          <Glyph name="new" /><span>{text('새 대화로', 'Start a new conversation')}</span>
        </label>
      </fieldset>
      <p className="workflow-stage-agent__note" data-tone={session.value === 'continue' && !session.reason ? 'saving' : undefined}>
        {session.reason ?? session.note ?? (session.value === 'continue'
          ? text(`'${session.from ?? ''}' 단계 대화에 이어서 하므로 처음부터 설명할 필요가 없습니다. 재시도해도 같은 대화로 돌아오며, 앞 시도의 결과와 확인 기록은 남습니다.`, `Continues the '${session.from ?? ''}' conversation, so nothing needs explaining again. A retry returns to the same conversation; earlier attempts and their checks stay recorded.`)
          : text('새 대화에서 시작합니다. 앞 단계 결과는 요약으로 넘겨받습니다.', 'Starts a new conversation; the previous result arrives as a summary.'))}
      </p>
    </div>
    <div className="workflow-stage-agent__pair">
      <Field label={text('노력', 'Effort')} description={agent?.effortLabel ? text(`에이전트 기본: ${agent.effortLabel}`, `Agent default: ${agent.effortLabel}`) : undefined}>
        <Select value={effort.value} disabled={disabled || !tunable} onChange={event => onChange?.({ effort: event.target.value })} data-testid="workflow-stage-agent-effort">
          {effort.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      </Field>
      <Field label={text('권한', 'Permission')} description={permission.note}>
        <Select value={permission.value} disabled={disabled || !tunable} onChange={event => onChange?.({ permission: event.target.value })} data-testid="workflow-stage-agent-permission">
          {permission.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      </Field>
    </div>
    <div data-testid="workflow-stage-checks">
      <p className="workflow-stage-agent__label">{text('확인 명령 · 결과로 통과/실패', 'Checks · pass or fail by result')}</p>
      {checks.length === 0 && <p className="workflow-stage-agent__note">{text('없음. 명령이 없으면 완료 조건은 검토 AI가 읽고 판단합니다.', 'None. Without one, the review AI judges the acceptance criteria.')}</p>}
      {checks.map(check => <div key={check.id} className="workflow-check" data-consent={check.consent}>
        <Glyph name="term" />
        <code>{check.command}</code>
        {check.consent === 'needed'
          ? <Button size="sm" variant="primary" disabled={disabled || !onConfirmCheck} onClick={() => onConfirmCheck?.(check.id)}>{text('확인하고 허용', 'Review and allow')}</Button>
          : <span className="workflow-check__allowed">{check.consent === 'confirmed'
            ? <><Glyph name="key" />{text('실행 허용됨 · 결과는 실행 때', 'Allowed to run · result when it runs')}</>
            : check.consent === 'unsaved' ? text('저장하면 허용할 수 있음', 'Allow it once saved')
              : check.consent === 'pc-only' ? text('PC에서 허용', 'Allowed on the PC') : text('허용 여부 모름', 'Allowance unknown')}</span>}
        {onRemoveCheck && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onRemoveCheck(check.id)} aria-label={text(`확인 명령 ${check.command} 빼기`, `Remove the check ${check.command}`)}><Glyph name="x" /></Button>}
      </div>)}
      {checks.some(check => check.consent === 'needed') && <p className="workflow-stage-agent__note">{text('새로 생기거나 바뀐 명령은 사람이 한 번 확인해야 실행됩니다. 받은 저장소에 들어 있던 명령도 같습니다.', 'New or changed commands run only after a person allows them once — including ones that came with a cloned repository.')}</p>}
      {checks.some(check => check.consent === 'unsaved') && <p className="workflow-stage-agent__note">{text('허용은 저장된 워크플로의 명령을 확인합니다. 먼저 초안을 저장하세요.', 'Allowing reads the saved workflow’s commands: save the draft first.')}</p>}
      {checks.some(check => check.consent === 'pc-only') && <p className="workflow-stage-agent__note">{text('확인 명령은 그 명령을 실행하는 PC에서 사람이 한 번 허용합니다. 허용하지 않은 명령이 있으면 실행이 시작되지 않습니다.', 'A person allows each check once on the PC that runs it; a run does not start while one is not allowed.')}</p>}
      {adding === null
        ? <Button size="sm" variant="ghost" leadingIcon={<Glyph name="plus" />} disabled={disabled || !onAddCheck || checks.length >= 20} onClick={() => setAdding('')}>{text('명령 추가', 'Add a check')}</Button>
        : <div className="workflow-check-add">
          <Input aria-label={text('추가할 확인 명령', 'Check command to add')} value={adding} placeholder="pnpm test" maxLength={4000} autoFocus disabled={disabled}
            onChange={event => setAdding(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } else if (event.key === 'Escape') setAdding(null); }} />
          <Button size="sm" variant="primary" disabled={disabled || !adding.trim()} onClick={add}>{text('추가', 'Add')}</Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>{text('취소', 'Cancel')}</Button>
        </div>}
    </div>
    <Field label={text('검토', 'Review')} description={review.note}>
      <Select value={review.value} disabled={disabled} onChange={event => onChange?.({ review: event.target.value })} data-testid="workflow-stage-agent-review">
        {review.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select>
    </Field>
    {children}
  </div>;
}
