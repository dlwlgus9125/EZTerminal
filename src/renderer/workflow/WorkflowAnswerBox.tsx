import { useId } from 'react';
import { Button } from '../ui';
import { Glyph, Led } from '../ui/Glyph';
import type { WorkflowCopy } from './workflow-copy';
import './workflow-agents.css';

export interface WorkflowAnswerBoxProps {
  readonly text: WorkflowCopy;
  /** What the stage asks, written by the flow (or the previous stage's questions). */
  readonly question: string;
  /** The stage whose result the question is about. */
  readonly from?: string;
  readonly value: string;
  readonly disabled?: boolean;
  readonly onChange?: (value: string) => void;
  readonly onSend?: () => void;
  readonly onOpenResult?: () => void;
  /**
   * An approval with a comment instead of an answer: 승인, or 의견 달아 되돌리기 (the comment goes back to
   * `returnsTo`, which redoes its work with it).
   */
  readonly decision?: { readonly returnsTo: string; readonly onApprove?: () => void; readonly onReturn?: () => void };
}

/**
 * A stage that waits for the person: an answer (a requirements interview) or an approval with a comment
 * (feedback on a mockup). No model runs while it waits; what the person writes is saved with the run and
 * goes to the stage that continues.
 */
export function WorkflowAnswerBox({ text, question, from, value, disabled = false, onChange, onSend, onOpenResult, decision }: WorkflowAnswerBoxProps): JSX.Element {
  const id = useId();
  return <section className="workflow-answer" aria-labelledby={`${id}-head`} data-testid={decision ? 'workflow-stage-approval-comment' : 'workflow-stage-answer'}>
    <p id={`${id}-head`} className="workflow-answer__head"><Led tone="amber" /><span>{decision ? text('내 승인을 기다림', 'Waiting for your approval') : text('내 답을 기다림', 'Waiting for your answer')}</span></p>
    <p className="workflow-answer__question">{question}</p>
    {from && <p className="workflow-answer__from">{text(`'${from}' 단계 결과를 바탕으로 묻습니다. 기다리는 동안 AI는 돌지 않습니다.`, `Asked from the '${from}' result. No AI runs while it waits.`)}</p>}
    <label className="ez-ui-visually-hidden" htmlFor={`${id}-answer`}>{decision ? text('의견', 'Comment') : text('답', 'Answer')}</label>
    <textarea id={`${id}-answer`} value={value} disabled={disabled} onChange={event => onChange?.(event.target.value)}
      placeholder={decision ? text(`의견(선택). 되돌리면 '${decision.returnsTo}' 단계가 이 의견으로 다시 합니다.`, `Comment (optional). Sending it back makes '${decision.returnsTo}' redo its work with it.`) : text('답을 쓰세요. 다음 단계가 이 답을 받아 이어갑니다.', 'Write your answer. The next stage picks it up.')} />
    <div className="workflow-answer__actions">
      {decision ? <>
        <Button variant="primary" disabled={disabled} onClick={decision.onApprove} leadingIcon={<Glyph name="check" />}>{text('승인', 'Approve')}</Button>
        <Button disabled={disabled || !value.trim()} onClick={decision.onReturn} leadingIcon={<Glyph name="undo" />}>{text(`의견 달아 '${decision.returnsTo}'로 되돌리기`, `Send back to '${decision.returnsTo}' with the comment`)}</Button>
      </> : <Button variant="primary" disabled={disabled || !value.trim()} onClick={onSend} leadingIcon={<Glyph name="send" />}>{text('답 보내기', 'Send answer')}</Button>}
      {onOpenResult && <Button variant="ghost" onClick={onOpenResult} leadingIcon={<Glyph name="eye" />}>{text('앞 단계 결과 보기', 'See the previous result')}</Button>}
    </div>
  </section>;
}
